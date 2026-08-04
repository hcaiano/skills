#!/usr/bin/env node
// Sends a message to a Herdr agent and does not exit until it has LANDED —
// pasted AND submitted. `herdr agent prompt` owns the Enter in theory, but a
// caller that trusts its exit code eventually leaves a message sitting in a
// composer and stalls the run in silence. So the Enter is sent here,
// unconditionally, after letting the paste settle.
//
// Measured against herdr 0.8.0 on 2026-08-04, receiver by receiver:
//   Claude — `agent prompt` IS atomic now. Single-line, a 19-line body with
//     fences and blank lines, and a prompt to a mid-turn agent all landed in
//     one call with no Enter of ours.
//   Codex  — multi-line SILENTLY DOES NOT LAND. Reproduced twice: the same
//     19-line body returned `agent_status: done`, `error: null`, while the
//     pane kept an empty composer, `Context 100% left`, and no rollout file
//     was ever written. A single-line prompt to that same pane landed fine.
//     The same body through this script landed on enter_attempts=1.
// Every kickoff and milestone is multi-line, so the loop below is still the
// only thing standing between a Codex delegate and silence. Do not remove it
// because the Claude half now works.
//
// This has been re-broken by four prose rewrites of the skill. Keeping the
// behaviour in code is the point: a rewrite cannot shave off a step it does
// not contain.
//
//   node send.mjs <pane_id> <text>
//   node send.mjs <pane_id> @<file>      # kickoffs: no shell quoting
//
// Exit 0 with a JSON receipt on stdout when landed; exit 1 with the pane's
// visible tail when it will not land; exit 2 on usage error.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const PASTE_SETTLE_MS = 400;   // let the pasted text reach the composer
const CONFIRM_MS = 3000;       // how long a landing may take to show
const POLL_MS = 200;
const ENTER_ATTEMPTS = 3;

const sleep = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const emit = (obj, code) => {
  process.stdout.write(JSON.stringify(obj) + '\n');
  process.exit(code);
};

const herdr = (...args) => {
  const r = spawnSync('herdr', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: r.stdout || '' };
};

const json = (t) => { try { return JSON.parse(t); } catch { return null; } };

const status = (pane) => json(herdr('agent', 'get', pane).out)?.result?.agent?.agent_status ?? null;

// `--source recent` is the default and returns an empty string on a live pane,
// so any composer check that omits the source reads "clear" no matter what is
// on screen. Always ask for the visible snapshot.
const visible = (pane) =>
  herdr('agent', 'read', pane, '--source', 'visible', '--lines', '40').out;

// True while our text still sits unsubmitted: the last prompt line on screen
// (`›` in Codex, `>` in Claude Code) carries it instead of the placeholder an
// empty composer shows.
const composerHolds = (pane, head) => {
  const lines = visible(pane).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!/^[›>]\s/.test(line)) continue;
    return line.slice(2).trim().startsWith(head);
  }
  return false;
};

const settled = (pane, head) => {
  for (let waited = 0; waited < CONFIRM_MS; waited += POLL_MS) {
    if (!composerHolds(pane, head)) return true;
    sleep(POLL_MS);
  }
  return !composerHolds(pane, head);
};

const [pane, raw] = process.argv.slice(2);
if (!pane || !raw) emit({ landed: false, error: 'usage: send.mjs <pane_id> <text|@file>' }, 2);
const text = raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw;
if (!text.trim()) emit({ landed: false, error: 'refusing to send an empty message' }, 2);

// Match on the first line's opening, which survives the composer's wrapping.
const head = (text.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 40);

const before = status(pane);
if (before === null) {
  emit({ landed: false, pane, error: `pane ${pane} hosts no agent to receive a message` }, 1);
}

herdr('agent', 'prompt', pane, text);
sleep(PASTE_SETTLE_MS);

// Unconditional: an Enter on an already-submitted composer is a no-op, while a
// missing one strands the message. Pay the harmless key, never the silent stall.
let attempts = 0;
let landed = false;
while (attempts < ENTER_ATTEMPTS && !landed) {
  herdr('agent', 'send-keys', pane, 'enter');
  attempts += 1;
  landed = settled(pane, head);
}

// One full resend, in case the paste itself never arrived.
let resent = false;
if (!landed) {
  resent = true;
  herdr('agent', 'prompt', pane, text);
  sleep(PASTE_SETTLE_MS);
  herdr('agent', 'send-keys', pane, 'enter');
  landed = settled(pane, head);
}

if (!landed) {
  emit({
    landed: false, pane, enter_attempts: attempts, resent,
    error: 'message will not land — report this pane to the user',
    status_before: before, status_now: status(pane), visible: visible(pane).slice(-1200),
  }, 1);
}

emit({
  landed: true, pane, enter_attempts: attempts, resent,
  queued: before === 'working', status_now: status(pane),
}, 0);
