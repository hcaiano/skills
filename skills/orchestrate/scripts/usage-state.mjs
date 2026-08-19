#!/usr/bin/env node
// Prints one JSON line with each pool's weekly usage AND burn rate, for phase 2
// grading. Per pool (or null when the source is unavailable):
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
// Claude source: ~/.claude/usage-state.json (written by the user's statusline).
// Codex source: newest plan-pool rate_limits snapshot in ~/.codex/sessions/**/*.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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
  walk(path.join(os.homedir(), '.codex', 'sessions'));
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

console.log(JSON.stringify({ claude, codex }));
