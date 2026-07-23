#!/usr/bin/env node
// Prints one JSON line with each pool's weekly usage for phase 2 grading:
//   {"claude":{used_percent,resets_in_hours,stale_minutes}|null,
//    "codex":{used_percent,resets_in_hours,stale_minutes}|null}
// Claude source: ~/.claude/usage-state.json (written by the user's statusline).
// Codex source: newest rate_limits snapshot in ~/.codex/sessions/**/*.jsonl.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const hoursUntil = (resetsAt) =>
  resetsAt ? Math.round((resetsAt - Date.now() / 1000) / 3600) : null;

let claude = null;
try {
  const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'usage-state.json'), 'utf8'));
  const w = j.rate_limits && j.rate_limits.seven_day;
  if (w && typeof w.used_percentage === 'number') claude = {
    used_percent: Math.round(w.used_percentage),
    resets_in_hours: hoursUntil(w.resets_at),
    stale_minutes: Math.round(Date.now() / 1000 / 60 - (j.written_at ?? 0) / 60),
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
    return buf.toString('utf8');
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
  const findRL = o => {
    if (!o || typeof o !== 'object') return null;
    if (o.rate_limits?.limit_id === 'codex' && typeof o.rate_limits.primary?.used_percent === 'number') return o.rate_limits;
    for (const v of Object.values(o)) { const r = findRL(v); if (r) return r; }
    return null;
  };
  for (const { f, m } of files.slice(0, 10)) {
    const lines = tail(f, 5 * 1024 * 1024).split('\n').slice(1);
    for (let i = lines.length - 1; i >= 0 && !codex; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let rl; try { rl = findRL(JSON.parse(lines[i])); } catch { continue; }
      if (rl) codex = {
        used_percent: Math.round(rl.primary.used_percent),
        resets_in_hours: hoursUntil(rl.primary.resets_at),
        stale_minutes: Math.round((Date.now() - m) / 60000),
      };
    }
    if (codex) break;
  }
} catch {}

console.log(JSON.stringify({ claude, codex }));
