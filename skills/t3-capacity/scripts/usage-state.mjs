#!/usr/bin/env node
// Prints one JSON line with each pool's usage AND burn rate. Claude and Codex
// are weekly; Cursor's two included pools follow its monthly billing cycle.
// Per pool (or null when the source is unavailable):
//   used_percent     percent of the 7-day pool already spent
//   elapsed_hours    how much of the 168 h window has already passed
//   resets_in_hours  hours until the window resets
//   days_left        resets_in_hours / 24
//   burn_per_day     points/day spent so far (null before 12 h elapsed — a rate
//                    measured over a few hours is noise, not a trend)
//   budget_per_day   points/day still affordable: (100 - used) / days_left
//   pace             burn_per_day / budget_per_day; >1 = spending faster than
//                    the rest of the window can fund, <1 = headroom to spare
//   days_to_empty    (100 - used) / burn_per_day; compare against days_left
//   short_window     the pool's burst limit, when it publishes one
//   stale_minutes    age of the snapshot; a stale pool reads cooler than it is
// `states` classifies claude, codex, cursor_models, and other_models with
// poolState below: no reading is unknown; >=90% of the window or the burst
// window is unavailable; pace > 1 is protected; a snapshot older than 15
// minutes is unknown. The first two outrank staleness, so a stale reading can
// only be as good as its worst proven state.
// Every read is live by default; --offline reads only local snapshots. Many
// threads read at once and the endpoints answer 429, so each good live reading
// is cached in ~/.cache/t3-capacity/live-usage.json under a hash of its account
// (the Claude token, the Codex account_id), and each account is read live at
// most once per two minutes across processes, or less often when an endpoint
// sends a longer Retry-After. A 429, 5xx or dropped connection retries briefly
// first. A read skipped by that spacing, or one that fails in
// transit (timeout, 429, 5xx, a Codex RPC error), reuses that account's cached
// reading when it is younger than 10 minutes and newer than the local snapshot,
// re-paced to now, with its age as stale_minutes and a `note`. Otherwise the
// failed-read rule above holds. The reused reading never raises an alert.
// Claude source: the subscription's usage endpoint with Claude Code's own
// token; offline, ~/.claude/usage-state.json (written by the user's statusline).
// Codex source: read-only account RPC per home; offline, session snapshots.
// Cursor source: the logged-in CLI's native /usage command. In its current UI,
// "Auto" is the Cursor Models pool and "API" is the Other Models pool.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { codexRead, listCodexHomes } from './codex-rpc.mjs';

const WEEK_MINUTES = 10080;
const WEEK_HOURS = WEEK_MINUTES / 60;
// A rate extrapolated from a sliver of the window swings wildly (one busy
// evening reads as 300%/day), so pace stays null until half a day has elapsed.
const MIN_ELAPSED_HOURS = 12;
// Mirror image at the other end: with hours left, dividing the remaining
// percent by a sliver of a day yields a huge budget and a near-zero pace,
// which would read as "ice cold" on a pool that is nearly spent. Judge a
// window this close to reset by used_percent alone.
const MIN_LEFT_HOURS = 6;
const hoursUntil = (resetsAt) =>
  resetsAt ? (resetsAt - Date.now() / 1000) / 3600 : null;
const round = (n, d = 1) =>
  n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** d) / 10 ** d;
// A burst window that has already reset is spent history, not a live limit.
const burstWindow = (usedPercent, resetsAt) => {
  const left = hoursUntil(resetsAt);
  return left != null && left > 0 && typeof usedPercent === 'number'
    ? { used_percent: Math.round(usedPercent), resets_in_hours: round(left) }
    : null;
};

const ansi = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu;
const cursorReset = (label) => {
  const parsed = label.match(/^([A-Z][a-z]{2}) (\d{1,2})$/u);
  if (!parsed) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months.indexOf(parsed[1]);
  if (month === -1) return null;
  const now = new Date();
  let reset = Date.UTC(now.getUTCFullYear(), month, Number(parsed[2]), 23, 59, 59);
  if (reset <= Date.now()) reset = Date.UTC(now.getUTCFullYear() + 1, month, Number(parsed[2]), 23, 59, 59);
  // A Cursor individual billing cycle repeats on the same calendar day.
  const resetDate = new Date(reset);
  const previous = Date.UTC(
    resetDate.getUTCMonth() === 0 ? resetDate.getUTCFullYear() - 1 : resetDate.getUTCFullYear(),
    resetDate.getUTCMonth() === 0 ? 11 : resetDate.getUTCMonth() - 1,
    resetDate.getUTCDate(),
    23, 59, 59,
  );
  return { reset, windowHours: (reset - previous) / 3600000 };
};

const readCursorUsage = (live) => new Promise((resolve) => {
  if (process.env.USAGE_STATE_SKIP_CURSOR === '1' || !live) return resolve(null);
  const cursorBin = process.env.CURSOR_AGENT_BIN || 'cursor-agent';
  // `script` supplies the TTY required by Cursor's native /usage command. The
  // command reads account state and never starts a model turn.
  const quoted = `'${cursorBin.replaceAll("'", "'\\''")}'`;
  const command = `stty cols 120 rows 40; exec ${quoted}`;
  // BSD script rejects Node's socket-backed stdin. Bash supplies a real pipe,
  // then exec keeps script as the supervised PID.
  const darwin = process.platform === 'darwin';
  const scriptArgs = darwin
    ? ['-c', 'exec /usr/bin/script -q /dev/null /bin/sh -c "$1" < <(cat)', 'cursor-usage', command]
    : ['-qfec', command, '/dev/null'];
  const child = spawn(
    darwin ? '/bin/bash' : 'script',
    scriptArgs,
    { stdio: ['pipe', 'pipe', 'ignore'] },
  );
  let output = '';
  let settled = false;
  const timers = [];
  const finish = () => {
    if (settled) return;
    settled = true;
    for (const timer of timers) clearTimeout(timer);
    child.stdin.destroy();
    try { child.kill('SIGTERM'); } catch {}
    const text = output.replace(ansi, '');
    const values = Object.fromEntries(
      [...text.matchAll(/^\s*(Included|Auto|API)\s+(\d+)% used\b/gmu)]
        .map((match) => [match[1], Number(match[2])]),
    );
    const resetLabel = text.match(/\bResets ([A-Z][a-z]{2} \d{1,2})\b/u)?.[1];
    const cycle = resetLabel ? cursorReset(resetLabel) : null;
    if (!cycle || !Number.isFinite(values.Auto) || !Number.isFinite(values.API)) return resolve(null);
    const hoursLeft = (cycle.reset - Date.now()) / 3600000;
    resolve({
      included: Number.isFinite(values.Included) ? pace(values.Included, hoursLeft, cycle.windowHours) : null,
      cursor_models: pace(values.Auto, hoursLeft, cycle.windowHours),
      other_models: pace(values.API, hoursLeft, cycle.windowHours),
      resets_on: resetLabel,
      stale_minutes: 0,
    });
  };
  child.on('error', finish);
  child.on('close', finish);
  child.stdin.on('error', () => {});
  child.stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
    if (/^\s*API\s+\d+% used\b/mu.test(output.replace(ansi, ''))) {
      try { child.stdin.write('\u001b'); } catch {}
      timers.push(setTimeout(finish, 100));
    }
  });
  timers.push(setTimeout(() => { try { child.stdin.write('/usage\r'); } catch {} }, 1800));
  timers.push(setTimeout(() => { try { child.stdin.write('\r'); } catch {} }, 2300));
  timers.push(setTimeout(finish, 8000));
});

// Turns a raw (used_percent, hours until reset) reading into the pace fields,
// or null when the snapshot describes a window that has already reset — its
// used_percent belongs to a window that no longer exists, and reporting it as
// a live window with zero time left would read as a pool to drain.
export const pace = (usedPercent, hoursLeft, windowHours = WEEK_HOURS) => {
  if (hoursLeft == null || hoursLeft <= 0) return null;
  const used = Math.round(usedPercent);
  const left = hoursLeft;
  const elapsed = Math.max(windowHours - left, 0);
  const daysLeft = left / 24;
  const burn = elapsed >= MIN_ELAPSED_HOURS ? used / (elapsed / 24) : null;
  const budget = left >= MIN_LEFT_HOURS ? (100 - used) / daysLeft : null;
  return {
    used_percent: used,
    elapsed_hours: Math.round(elapsed),
    resets_in_hours: Math.round(left),
    days_left: round(daysLeft, 2),
    burn_per_day: round(burn),
    budget_per_day: round(budget),
    // An untouched pool is pace 0 with no empty date, not an unknown.
    pace: burn != null && budget ? round(burn / budget, 2) : null,
    days_to_empty: burn ? round((100 - used) / burn) : null,
  };
};

export const poolState = (pool) => {
  if (!pool) return 'unknown';
  if (pool.used_percent >= 90 || pool.short_window?.used_percent >= 90) return 'unavailable';
  if (pool.pace > 1) return 'protected';
  if (pool.stale_minutes == null || pool.stale_minutes > 15) return 'unknown';
  return 'available';
};

// A live reading is kept raw: { at, week: { used, resets_at, window_hours? },
// burst }, with epoch-second resets, so a reused one is paced against the
// current time. window_hours defaults to the 168 h week.
export const poolFromRaw = ({ at, week, burst }) => {
  const weekly = pace(week.used, hoursUntil(week.resets_at), week.window_hours ?? WEEK_HOURS);
  return weekly && { ...weekly, stale_minutes: Math.round((Date.now() - at) / 60000),
    short_window: burst ? burstWindow(burst.used, burst.resets_at) : null };
};
const CACHE_MAX_MINUTES = 10;
// Claude's usage endpoint grants about one read per account every two minutes
// and answers 429 with Retry-After: 0 in between (measured 2026-10-07), so one
// live read per account per two minutes, success or failure, serves every
// thread on the machine.
const SPACING_MS = 120000;
// A caller inside the spacing waits this long from the other read's start for
// its result: Codex's RPC times out at 15 s, an HTTP read with retries sooner.
const IN_FLIGHT_MS = 20000;
// One HTTP read, retries and body included, ends within READ_BUDGET_MS. A 429,
// 5xx or dropped connection retries inside it: after Retry-After when it is
// positive, else after RETRY_BASE_MS doubled per retry. A longer Retry-After
// holds every process off that account until it passes, up to an hour.
const READ_BUDGET_MS = 10000;
const RETRY_LIMIT = 2;
const HOLD_OFF_MAX_MS = 3600000;
const RETRY_BASE_MS = Number(process.env.USAGE_STATE_RETRY_BASE_MS) || 1000;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const accountKey = (prefix, secret) =>
  (secret ? `${prefix}:${crypto.createHash('sha256').update(secret).digest('hex').slice(0, 16)}` : null);
const cacheDir = () => path.join(os.homedir(), '.cache', 't3-capacity');
const cacheFile = () => path.join(cacheDir(), 'live-usage.json');
const attemptsFile = () => path.join(cacheDir(), 'live-attempts.json');
const readJson = (file) => {
  try { const value = JSON.parse(fs.readFileSync(file, 'utf8')); return value && typeof value === 'object' ? value : {}; }
  catch { return {}; }
};
// A rename swaps in a whole file, so a reader never sees half of one.
const writeJson = (file, value) => {
  const temp = `${file}.${process.pid}`;
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
};
const fresh = (entry) => Date.now() - entry?.at <= CACHE_MAX_MINUTES * 60000;
// Every read-modify-write of the cache files runs under one lock directory, so
// two processes cannot both claim a read or drop each other's reading. It is
// held for milliseconds: a lock older than 5 s belongs to a dead process. A
// caller that cannot lock within 2 s goes ahead unlocked, which costs at worst
// one extra live read.
const locked = (fn) => {
  const lock = path.join(cacheDir(), 'lock');
  let held = false;
  try {
    fs.mkdirSync(cacheDir(), { recursive: true });
    for (const giveUp = Date.now() + 2000; !held && Date.now() < giveUp;) {
      try { fs.mkdirSync(lock); held = true; } catch (error) {
        if (error.code !== 'EEXIST') break;
        try { if (Date.now() - fs.statSync(lock).mtimeMs > 5000) fs.rmdirSync(lock); } catch {}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return fn();
  } catch { return null; }
  finally { if (held) try { fs.rmdirSync(lock); } catch {} }
};
// Takes the account's next live read, or returns the read another process
// started inside the spacing or before the endpoint's Retry-After.
const claim = (key) => locked(() => {
  const attempts = readJson(attemptsFile());
  const now = Date.now();
  const holds = (attempt) => (now - attempt?.started >= 0 && now - attempt?.started < SPACING_MS)
    || (now < attempt?.not_before && attempt.not_before - now <= HOLD_OFF_MAX_MS);
  if (holds(attempts[key])) return { other: attempts[key] };
  for (const [name, attempt] of Object.entries(attempts)) if (!holds(attempt)) delete attempts[name];
  attempts[key] = { started: now };
  writeJson(attemptsFile(), attempts);
  return { started: now };
}) ?? { started: Date.now() };
// Keeps the newer good reading, then records how the claimed read ended: a
// waiter that sees the read finished finds its reading already cached.
const settle = (key, started, { raw, error }) => locked(() => {
  if (raw) {
    const cache = Object.fromEntries(Object.entries(readJson(cacheFile())).filter(([, entry]) => fresh(entry)));
    if (!(cache[key]?.at >= raw.at)) cache[key] = raw;
    writeJson(cacheFile(), cache);
  }
  const attempts = readJson(attemptsFile());
  if (attempts[key]?.started !== started) return;
  attempts[key] = { started, finished: Date.now(),
    ...(error ? { failure: error.message, transient: Boolean(error.transient) } : {}),
    ...(error?.notBefore ? { not_before: Math.min(error.notBefore, Date.now() + HOLD_OFF_MAX_MS) } : {}) };
  writeJson(attemptsFile(), attempts);
});
const reuseCached = (key, why, snapshot, toPool) => {
  const entry = readJson(cacheFile())[key];
  if (!fresh(entry) || !(entry.at <= Date.now()) || typeof entry.week?.used !== 'number') return null;
  const pool = toPool(entry);
  // Ages are whole minutes, so a tie goes to the live reading, which is account proof.
  if (!pool || (snapshot?.stale_minutes != null && snapshot.stale_minutes < pool.stale_minutes)) return null;
  return { pool, note: `live read ${why}; reused the live reading from ${pool.stale_minutes} minutes ago` };
};
// A failure before the request, or a refusal of the token, says nothing
// about load: only a failure in transit may reuse a cached reading.
const transient = (message) => Object.assign(new Error(message), { transient: true });

// Reads one account live at most once per SPACING_MS across processes. Returns
// { pool } for a live reading, { pool, note } for a reused one, or { error }.
// A caller inside the spacing waits for the other read, then reuses its
// reading; when that read failed in transit, or found nothing, it reuses an
// older one under the 10-minute rule. A refused token is never papered over.
export const liveRead = async (key, read, { snapshot = null, toPool = poolFromRaw } = {}) => {
  if (!key) {
    try { const raw = await read(); return { pool: raw && toPool(raw) }; } catch (error) { return { error }; }
  }
  const slot = claim(key);
  if (slot.other) {
    let other = slot.other;
    while (!other.finished && Date.now() - slot.other.started < IN_FLIGHT_MS) {
      await pause(200);
      const latest = readJson(attemptsFile())[key];
      if (latest?.started !== slot.other.started) break;
      other = latest;
    }
    if (other.failure && !other.transient) return { error: new Error(other.failure) };
    const seconds = Math.round((Date.now() - slot.other.started) / 1000);
    const why = `skipped (another process read this account ${seconds} s ago${other.failure ? `: ${other.failure}` : ''})`;
    return reuseCached(key, why, snapshot, toPool) ?? { error: transient(`live read ${why}, and no reading from the last 10 minutes is cached`) };
  }
  try {
    const raw = await read();
    settle(key, slot.started, { raw });
    return { pool: raw && toPool(raw) };
  } catch (error) {
    settle(key, slot.started, { error });
    const reused = error.transient ? reuseCached(key, `failed (${error.message})`, snapshot, toPool) : null;
    return reused ?? { error };
  }
};

// Seconds or an HTTP date; 0, past or unreadable values give no hint.
const retryAfterMs = (value) => {
  if (value == null || value.trim() === '') return null;
  const ms = /^\d+$/u.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - Date.now();
  return ms > 0 ? ms : null;
};
// GETs a usage endpoint and parses its JSON within READ_BUDGET_MS. A 429, a
// 5xx or a connection dropped before the body is in retries, then throws a
// transient error; any other answer returns as { status, ok, body }, with the
// body parsed only when ok. Malformed JSON is no transit failure: it throws.
export const fetchUsage = async (url, headers, what) => {
  const deadline = Date.now() + READ_BUDGET_MS;
  for (let retry = 0; ; retry++) {
    let failure;
    let wait = null;
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)) });
      if (response.status !== 429 && response.status < 500) {
        if (!response.ok) return { status: response.status, ok: false, body: null };
        const text = await response.text();
        return { status: response.status, ok: true, body: JSON.parse(text) };
      }
      failure = `${what} answered ${response.status}`;
      wait = retryAfterMs(response.headers.get('retry-after'));
    } catch (error) {
      if (error.name === 'SyntaxError') throw error;
      failure = `${what} request failed: ${error.message}`;
    }
    const hinted = wait != null;
    wait ??= RETRY_BASE_MS * 2 ** retry * (0.75 + Math.random() / 2);
    // A retry needs time left for its own request after the wait.
    if (retry >= RETRY_LIMIT || Date.now() + wait + 1000 > deadline) {
      throw Object.assign(transient(failure), hinted ? { notBefore: Date.now() + wait } : {});
    }
    await pause(wait);
  }
};

// Session files grow past Node's string limit — read only the tail.
const tail = (file, bytes) => {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return { text: buf.toString('utf8'), truncated: size > len };
  } finally { fs.closeSync(fd); }
};

const readCodexSnapshot = (codexHome) => {
let codex = null;
try {
  const files = [];
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.jsonl')) files.push({ f, m: fs.statSync(f).mtimeMs });
    }
  };
  walk(path.join(codexHome, 'sessions'));
  files.sort((a, b) => b.m - a.m);
  // Sessions may run promo/free lanes with their own limit_id (e.g.
  // "codex_bengalfox"); only limit_id "codex" is the plan's weekly pool.
  // Observed snapshots carry the weekly window in `primary`, but pick by
  // window_minutes so a primary=5h/secondary=weekly shape also works.
  const findRL = o => {
    if (!o || typeof o !== 'object') return null;
    if (o.rate_limits?.limit_id === 'codex') {
      const windows = [o.rate_limits.primary, o.rate_limits.secondary]
        .filter(x => x && typeof x.used_percent === 'number');
      const w = windows.find(x => x.window_minutes === WEEK_MINUTES);
      // Codex publishes only the weekly window on some plans; short_window
      // stays null there rather than borrowing another window's numbers.
      if (w) return { w, burst: windows.find(x => x.window_minutes < WEEK_MINUTES) || null };
    }
    for (const v of Object.values(o)) { const r = findRL(v); if (r) return r; }
    return null;
  };
  // Concurrent sessions interleave: an old file can carry the newest plan
  // snapshot. Take each file's newest snapshot, then keep the newest by the
  // event's own timestamp — never the file's mtime, which unrelated appends
  // keep fresh.
  let best = null;
  for (const { f, m } of files.slice(0, 10)) {
    const { text, truncated } = tail(f, 5 * 1024 * 1024);
    const lines = text.split('\n');
    if (truncated) lines.shift();
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let j; try { j = JSON.parse(lines[i]); } catch { continue; }
      const rl = findRL(j);
      if (!rl) continue;
      const at = Date.parse(j.timestamp) || m;
      if (!best || at > best.at) best = { ...rl, at };
      break;
    }
  }
  const weekly = best
    ? pace(best.w.used_percent, hoursUntil(best.w.resets_at), best.w.window_minutes / 60)
    : null;
  if (weekly) codex = {
    ...weekly,
    short_window: best.burst ? burstWindow(best.burst.used_percent, best.burst.resets_at) : null,
    stale_minutes: Math.round((Date.now() - best.at) / 60000),
  };
} catch {}
return codex;
};

const main = async () => {
  let claude = null;
  try {
    const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'usage-state.json'), 'utf8'));
    const w = j.rate_limits && j.rate_limits.seven_day;
    const burst = j.rate_limits && j.rate_limits.five_hour;
    const weekly = w && typeof w.used_percentage === 'number'
      ? pace(w.used_percentage, hoursUntil(w.resets_at)) : null;
    if (weekly) claude = {
      ...weekly,
      short_window: burst ? burstWindow(burst.used_percentage, burst.resets_at) : null,
      stale_minutes: j.written_at ? Math.round(Date.now() / 60000 - j.written_at * 1000 / 60000) : null,
    };
  } catch {}

  // Live is the default because staffing on hours-old snapshots misled
  // September's gates. --live stays accepted for callers written before.
  const args = process.argv.slice(2);
  const unknownArgs = args.filter((arg) => arg !== '--live' && arg !== '--offline');
  if (unknownArgs.length || (args.includes('--live') && args.includes('--offline')))
    throw new Error('usage: usage-state.mjs [--offline]');
  const live = !args.includes('--offline');

  // The statusline writes its snapshot only while an interactive Claude Code
  // session renders it, so a lead in an SDK host (T3 Code, the desktop app)
  // leaves it hours stale. --live asks the endpoint Claude Code's /usage reads,
  // with the token the CLI stored: the credentials file on Linux, the login
  // keychain on macOS. The helper never refreshes or writes the token; an
  // expired one fails the read like a failed Codex read.
  // A credentials file left by an older install can outlive the keychain login
  // Claude Code now uses on macOS, so take the credential that expires last,
  // and refuse an expired one before it costs a request.
  const claudeCredential = () => {
    const found = [];
    try {
      const stored = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
      if (stored.claudeAiOauth?.accessToken) found.push(stored.claudeAiOauth);
    } catch {}
    if (process.platform === 'darwin') {
      const keychain = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 3000 });
      try {
        const stored = JSON.parse(keychain.stdout).claudeAiOauth;
        if (stored?.accessToken) found.push(stored);
      } catch {}
    }
    return found.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0] ?? null;
  };
  // A missing or expired login fails before it claims a read or costs a request.
  const claudeRefusal = (credential) => {
    if (!credential) return 'no Claude Code login token';
    if (credential.expiresAt && credential.expiresAt < Date.now()) {
      return 'the stored Claude Code login expired; any Claude Code session refreshes it';
    }
    return null;
  };
  const readClaudeLive = async (credential) => {
    const { status, ok, body } = await fetchUsage(process.env.CLAUDE_USAGE_URL || 'https://api.anthropic.com/api/oauth/usage',
      { authorization: `Bearer ${credential.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' }, 'usage endpoint');
    if (!ok) throw new Error(`usage endpoint answered ${status}`);
    const epoch = (iso) => (iso ? Date.parse(iso) / 1000 : null);
    const week = body.seven_day;
    if (!Number.isFinite(week?.utilization)) throw new Error('usage endpoint sent no weekly window');
    const burst = body.five_hour;
    const raw = { at: Date.now(), week: { used: week.utilization, resets_at: epoch(week.resets_at) },
      burst: Number.isFinite(burst?.utilization) ? { used: burst.utilization, resets_at: epoch(burst.resets_at) } : null };
    if (!poolFromRaw(raw)) throw new Error('usage endpoint sent an expired weekly window');
    return raw;
  };
  // Each account is independent: start the Claude read now, join it below.
  const credential = live ? claudeCredential() : null;
  const refusal = live ? claudeRefusal(credential) : null;
  const claudeLive = !live ? null : refusal ? Promise.resolve({ error: new Error(refusal) })
    : liveRead(accountKey('claude', credential.accessToken), () => readClaudeLive(credential), { snapshot: claude });
  const homes = listCodexHomes();

  const measuredRaw = (reading) => {
    const limits = reading.rateLimitsByLimitId?.codex ?? reading.rateLimits;
    if (!limits || (limits.limitId && limits.limitId !== 'codex')) return null;
    const windows = [limits.primary, limits.secondary].filter(Boolean);
    const week = windows.find((w) => w.windowDurationMins === WEEK_MINUTES);
    if (!week || !Number.isFinite(week.usedPercent) || week.usedPercent < 0 || week.usedPercent > 100) return null;
    const burst = windows.find((w) => w.windowDurationMins < WEEK_MINUTES);
    const raw = { at: Date.now(), week: { used: week.usedPercent, resets_at: week.resetsAt },
      burst: burst ? { used: burst.usedPercent, resets_at: burst.resetsAt } : null };
    return poolFromRaw(raw) ? raw : null;
  };
  const codexAccount = (home) => {
    try { return accountKey('codex', JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8')).tokens?.account_id); }
    catch { return null; }
  };
  const codexIdentities = {};
  const seenHomes = new Set();
  // A profile may symlink its sessions folder to another home's to share
  // history. Snapshots in a shared folder come from whichever account ran each
  // session, so they prove no single account's quota: only --live does.
  const realSessions = (home) => { try { return fs.realpathSync(path.join(home, 'sessions')); } catch { return null; } };
  const sessionOwners = new Map();
  for (const home of Object.values(homes)) {
    const sessions = realSessions(home);
    if (!sessions) continue;
    let canonical = home;
    try { canonical = fs.realpathSync(home); } catch {}
    sessionOwners.set(sessions, (sessionOwners.get(sessions) ?? new Set()).add(canonical));
  }
  for (const [identity, home] of Object.entries(homes)) {
    let canonical = home;
    try { canonical = fs.realpathSync(home); } catch {}
    if (seenHomes.has(canonical)) continue;
    seenHomes.add(canonical);
    const shared = (sessionOwners.get(realSessions(canonical))?.size ?? 0) > 1;
    let pool = shared ? null : readCodexSnapshot(canonical);
    let source = shared ? 'shared-session-snapshot' : 'session-snapshot';
    let liveError = shared && !live ? 'sessions folder shared with another home; only --live proves this account' : null;
    let note = null;
    if (live) {
      const account = codexAccount(canonical);
      let homeMissing = true;
      try { homeMissing = !fs.statSync(canonical).isDirectory(); } catch {}
      // An RPC error is not classified, so every one counts as transient.
      const read = homeMissing ? { error: new Error('home missing') } : await liveRead(account, async () => {
        try { return measuredRaw(await codexRead('account/rateLimits/read', {}, { codexHome: canonical })); }
        catch (error) { throw transient(error.message); }
      }, { snapshot: pool });
      if (read.error) liveError = 'live quota unavailable; snapshot is not current account proof';
      else [pool, note, source, liveError] = [read.pool, read.note ?? null,
        read.note ? 'account/rateLimits/read, cached' : 'account/rateLimits/read', null];
    }
    codexIdentities[identity] = { home: canonical, pool, source,
      state: liveError ? (['protected', 'unavailable'].includes(poolState(pool)) ? poolState(pool) : 'unknown') : poolState(pool),
      ...(liveError ? { error: liveError } : {}), ...(note ? { note } : {}) };
  }
  const eligible = Object.entries(codexIdentities).filter(([, entry]) => entry.state === 'available');
  eligible.sort(([, a], [, b]) => (a.pool.pace ?? 1) - (b.pool.pace ?? 1) || a.pool.used_percent - b.pool.used_percent);
  const codex = codexIdentities.default?.pool ?? null;

  const cursor = await readCursorUsage(live);
  let claudeSource = claude ? 'statusline' : null;
  let claudeError = null;
  let claudeNote = null;
  if (claudeLive) {
    const read = await claudeLive;
    if (read.error) claudeError = `live quota unavailable (${read.error.message}); snapshot is not current account proof`;
    else [claude, claudeNote, claudeSource] = [read.pool, read.note ?? null, read.note ? 'oauth/usage, cached' : 'oauth/usage'];
  }
  // One state per pool, so a caller acts on `states` instead of re-deriving the
  // thresholds. Codex takes the default identity's state, which already keeps a
  // failed live read from reporting a snapshot as current headroom. Cursor's
  // monthly pools share the snapshot age of the one /usage read.
  const cursorPool = (pool) => (pool ? { ...pool, stale_minutes: cursor.stale_minutes } : null);
  const claudeState = claudeError && !['protected', 'unavailable'].includes(poolState(claude))
    ? 'unknown' : poolState(claude);
  const states = {
    claude: claudeState,
    codex: codexIdentities.default?.state ?? poolState(null),
    cursor_models: poolState(cursorPool(cursor?.cursor_models)),
    other_models: poolState(cursorPool(cursor?.other_models)),
  };
  // A pool that empties more than a day before its reset strands the rest of
  // its window; the roster tells the lead what to do about it. Only a current
  // reading with half a day of history can raise one: a failed live read keeps
  // a stale snapshot's protected state, but never turns it into a new alert.
  const alerts = [];
  const earlyEmpty = (name, pool, failedRead) => {
    if (failedRead || pool?.stale_minutes == null || pool.stale_minutes > 15) return;
    if (pool.days_to_empty == null || pool.elapsed_hours < 12) return;
    if (pool.days_to_empty < pool.days_left - 1) {
      alerts.push({ pool: name, days_to_empty: pool.days_to_empty, days_left: pool.days_left });
    }
  };
  earlyEmpty('claude', claude, Boolean(claudeError || claudeNote));
  for (const [name, entry] of Object.entries(codexIdentities)) {
    earlyEmpty(`codex:${name}`, entry.pool, Boolean(entry.error || entry.note));
  }
  earlyEmpty('cursor_models', cursorPool(cursor?.cursor_models), false);
  earlyEmpty('other_models', cursorPool(cursor?.other_models), false);
  console.log(JSON.stringify({ alerts, claude, claude_source: claudeSource,
    ...(claudeError ? { claude_error: claudeError } : {}),
    ...(claudeNote ? { claude_note: claudeNote } : {}),
    codex, cursor, codex_identities: codexIdentities,
    recommended_codex_identity: eligible[0]?.[0] ?? null, states }));
};

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) await main();
