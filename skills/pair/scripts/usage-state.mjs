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
// Every read is live by default; --offline reads only local snapshots.
// Claude source: the subscription's usage endpoint with Claude Code's own
// token; offline, ~/.claude/usage-state.json (written by the user's statusline).
// Codex source: read-only account RPC per home; offline, session snapshots.
// Cursor source: the logged-in CLI's native /usage command. In its current UI,
// "Auto" is the Cursor Models pool and "API" is the Other Models pool.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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

const readCursorUsage = () => new Promise((resolve) => {
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
const pace = (usedPercent, hoursLeft, windowHours = WEEK_HOURS) => {
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
const claudeToken = () => {
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf8'));
    if (stored.claudeAiOauth?.accessToken) return stored.claudeAiOauth.accessToken;
  } catch {}
  if (process.platform !== 'darwin') return null;
  const keychain = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
    { encoding: 'utf8', timeout: 3000 });
  try { return JSON.parse(keychain.stdout).claudeAiOauth?.accessToken ?? null; } catch { return null; }
};
const readClaudeLive = async () => {
  const token = claudeToken();
  if (!token) throw new Error('no Claude Code login token');
  const response = await fetch(process.env.CLAUDE_USAGE_URL || 'https://api.anthropic.com/api/oauth/usage', {
    headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`usage endpoint answered ${response.status}`);
  const body = await response.json();
  const epoch = (iso) => (iso ? Date.parse(iso) / 1000 : null);
  const week = body.seven_day;
  if (!Number.isFinite(week?.utilization)) throw new Error('usage endpoint sent no weekly window');
  const weekly = pace(week.utilization, hoursUntil(epoch(week.resets_at)));
  if (!weekly) throw new Error('usage endpoint sent an expired weekly window');
  const burst = body.five_hour;
  return { ...weekly, stale_minutes: 0,
    short_window: Number.isFinite(burst?.utilization) ? burstWindow(burst.utilization, epoch(burst.resets_at)) : null };
};
// Each account is independent: start the Claude read now, join it below.
const claudeLive = live ? readClaudeLive().then((pool) => ({ pool }), (error) => ({ error })) : null;
const homes = listCodexHomes();

const measuredPool = (reading) => {
  const limits = reading.rateLimitsByLimitId?.codex ?? reading.rateLimits;
  if (!limits || (limits.limitId && limits.limitId !== 'codex')) return null;
  const windows = [limits.primary, limits.secondary].filter(Boolean);
  const week = windows.find((w) => w.windowDurationMins === WEEK_MINUTES);
  if (!week || !Number.isFinite(week.usedPercent) || week.usedPercent < 0 || week.usedPercent > 100) return null;
  const weekly = pace(week.usedPercent, hoursUntil(week.resetsAt));
  if (!weekly) return null;
  const burst = windows.find((w) => w.windowDurationMins < WEEK_MINUTES);
  return { ...weekly, stale_minutes: 0,
    short_window: burst ? burstWindow(burst.usedPercent, burst.resetsAt) : null };
};
const poolState = (pool) => {
  if (!pool) return 'unknown';
  if (pool.used_percent >= 90 || pool.short_window?.used_percent >= 90) return 'unavailable';
  if (pool.pace > 1) return 'protected';
  if (pool.stale_minutes == null || pool.stale_minutes > 15) return 'unknown';
  return 'available';
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
  if (live) {
    try {
      if (!fs.statSync(canonical).isDirectory()) throw new Error('home missing');
      pool = measuredPool(await codexRead('account/rateLimits/read', {}, { codexHome: canonical }));
      source = 'account/rateLimits/read';
      liveError = null;
    } catch {
      liveError = 'live quota unavailable; snapshot is not current account proof';
    }
  }
  codexIdentities[identity] = { home: canonical, pool, source,
    state: liveError ? (['protected', 'unavailable'].includes(poolState(pool)) ? poolState(pool) : 'unknown') : poolState(pool),
    ...(liveError ? { error: liveError } : {}) };
}
const eligible = Object.entries(codexIdentities).filter(([, entry]) => entry.state === 'available');
eligible.sort(([, a], [, b]) => (a.pool.pace ?? 1) - (b.pool.pace ?? 1) || a.pool.used_percent - b.pool.used_percent);
const codex = codexIdentities.default?.pool ?? null;

const cursor = await readCursorUsage();
let claudeSource = claude ? 'statusline' : null;
let claudeError = null;
if (claudeLive) {
  const read = await claudeLive;
  if (read.pool) {
    claude = read.pool;
    claudeSource = 'oauth/usage';
  } else {
    claudeError = `live quota unavailable (${read.error.message}); snapshot is not current account proof`;
  }
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
earlyEmpty('claude', claude, Boolean(claudeError));
for (const [name, entry] of Object.entries(codexIdentities)) earlyEmpty(`codex:${name}`, entry.pool, Boolean(entry.error));
earlyEmpty('cursor_models', cursorPool(cursor?.cursor_models), false);
earlyEmpty('other_models', cursorPool(cursor?.other_models), false);
console.log(JSON.stringify({ alerts, claude, claude_source: claudeSource,
  ...(claudeError ? { claude_error: claudeError } : {}), codex, cursor, codex_identities: codexIdentities,
  recommended_codex_identity: eligible[0]?.[0] ?? null, states }));
