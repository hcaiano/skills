#!/usr/bin/env node
// Runs one Claude slash command headless with the whole fragile mechanic in
// code: output-based liveness (stock macOS has no `timeout`), live stderr
// streaming for a visible Herdr pane, a kill of the PID
// itself (never the group), content validation (exit 0 with an empty or
// missing result is a FAILURE, not a pass), and for writable runs a baseline
// patch taken before and a verified restore after any failure — the tree
// fingerprint must match the baseline, not just "apply ran".
//
//   node headless-claude.mjs "/code-review"                 # read-only (plan)
//   node headless-claude.mjs "/simplify" --writable true    # acceptEdits
//   [--cwd <path>] [--model opus] [--idle-min 20] [--total-min 60]
//
// Exit 0: JSON receipt {ok: true, result: "<final result text>", ...}.
// Exit 1: {ok: false, reason, ...}; writable runs report restore status —
// a failed restore is called out loudly for the caller to inspect.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const POLL_MS = 2000;

const argv = process.argv.slice(2);
const command = argv[0];
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
if (!command || command.startsWith('--')) {
  process.stdout.write(JSON.stringify({ ok: false, reason: 'usage: headless-claude.mjs "<slash-command>" [--writable true] [--cwd <path>] [--model opus] [--idle-min N] [--total-min N]' }) + '\n');
  process.exit(2);
}
const writable = opt('writable', 'false') === 'true';
const cwd = opt('cwd', process.cwd());
const model = opt('model', 'opus');
const receiptPath = opt('receipt', null);
const idleMs = parseFloat(opt('idle-min', '20')) * 60000;
const totalMs = parseFloat(opt('total-min', '60')) * 60000;

const emit = (obj, code) => {
  const output = JSON.stringify(obj, null, 2) + '\n';
  if (receiptPath) writeFileSync(receiptPath, output);
  process.stdout.write(output);
  process.exit(code);
};

const git = (...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });

// Baseline for writable runs: a --binary patch captures intent-to-add paths
// that `git stash create` refuses; record those paths to re-mark them after
// a restore.
let baselinePatch = null;
let intentPaths = [];
let baselineUntracked = [];
const untracked = () => git('ls-files', '--others', '--exclude-standard').stdout.split('\n').filter(Boolean);
const work = mkdtempSync(join(tmpdir(), 'headless-claude-'));
if (writable) {
  const diff = git('diff', 'HEAD', '--binary');
  if (diff.status !== 0) emit({ ok: false, reason: `baseline diff failed: ${diff.stderr}` }, 1);
  baselinePatch = join(work, 'baseline.patch');
  writeFileSync(baselinePatch, diff.stdout);
  intentPaths = git('diff', 'HEAD', '--name-only', '--diff-filter=A').stdout.split('\n').filter(Boolean);
  baselineUntracked = untracked();
}

// Never deletes: pre-existing untracked files are the user's. New untracked
// files the run left behind are reported for the caller to review.
const restore = () => {
  const checkout = git('checkout', 'HEAD', '--', '.');
  if (checkout.status !== 0) return { error: `checkout failed: ${checkout.stderr.trim()}` };
  // checkout leaves intent-to-add files on disk (possibly clobbered by the
  // run); the baseline patch recreates them with their original contents.
  for (const path of intentPaths) rmSync(join(cwd, path), { force: true });
  if (readFileSync(baselinePatch, 'utf8').length > 0) {
    const apply = git('apply', '--binary', baselinePatch);
    if (apply.status !== 0) return { error: `apply failed: ${apply.stderr.trim()}` };
  }
  for (const path of intentPaths) git('add', '--intent-to-add', '--', path);
  // Fingerprint: the tracked tree must reproduce the baseline exactly.
  const now = git('diff', 'HEAD', '--binary').stdout;
  if (now !== readFileSync(baselinePatch, 'utf8')) return { error: 'restored tree does not match the baseline fingerprint' };
  const before = new Set(baselineUntracked);
  return { error: null, leftover_untracked: untracked().filter((p) => !before.has(p)) };
};

const logPath = join(work, 'run.log');
const logFd = openSync(logPath, 'w');
const started = Date.now();
const child = spawn(
  'claude',
  ['-p', '--model', model, '--permission-mode', writable ? 'acceptEdits' : 'plan', '--strict-mcp-config', '--no-chrome', '--output-format', 'stream-json', '--include-partial-messages', '--verbose', command],
  { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
);
// Liveness is measured here, on the bytes themselves: the parent now sees
// every chunk, so there is nothing left for a filesystem size poll to learn.
let lastGrowth = Date.now();
const mirror = (chunk) => {
  writeSync(logFd, chunk);
  process.stderr.write(chunk);
  lastGrowth = Date.now();
};
child.stdout.on('data', mirror);
child.stderr.on('data', mirror);

const finish = (outcome) => {
  closeSync(logFd);
  const seconds = Math.round((Date.now() - started) / 1000);
  const base = { command, writable, seconds, log: logPath, ...outcome };
  if (base.ok) emit(base, 0);
  if (writable) {
    const { error, leftover_untracked } = restore();
    base.restored = error === null;
    if (error) base.restore_error = `RESTORE FAILED — inspect the tree before touching it: ${error}`;
    if (leftover_untracked?.length) base.leftover_untracked = leftover_untracked;
  }
  emit(base, 1);
};

let exit = null;
child.on('close', (code) => { exit = code ?? -1; });
child.on('error', () => { exit = -1; });

const timer = setInterval(() => {
  if (exit !== null) {
    clearInterval(timer);
    // Complete means exit 0 AND a final result event with is_error false AND
    // non-empty content — a clean exit around a refusal or empty payload
    // must read as failure, never as a passed run.
    const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    let result = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const event = JSON.parse(lines[i]);
        if (event.type === 'result') { result = event; break; }
      } catch { /* non-JSON output line */ }
    }
    if (exit !== 0) return finish({ ok: false, reason: `claude exited ${exit}`, exit_code: exit });
    if (!result) return finish({ ok: false, reason: 'no result event in the stream — not a completed run', exit_code: exit });
    if (result.is_error) return finish({ ok: false, reason: 'result event carries is_error', exit_code: exit });
    const text = (result.result ?? '').trim();
    if (!text) return finish({ ok: false, reason: 'result event is empty — content validation failed', exit_code: exit });
    return finish({ ok: true, exit_code: exit, result: text });
  }

  const now = Date.now();
  if (now - lastGrowth > idleMs || now - started > totalMs) {
    clearInterval(timer);
    const why = now - started > totalMs ? `total budget ${Math.round(totalMs / 60000)}m exceeded` : `no output for ${Math.round(idleMs / 60000)}m`;
    child.kill('SIGTERM'); // the PID itself, never the group
    setTimeout(() => {
      try { process.kill(child.pid, 0); child.kill('SIGKILL'); } catch { /* already gone */ }
      setTimeout(() => finish({ ok: false, reason: `hang: ${why}`, killed: true }), 500);
    }, 2000);
  }
}, POLL_MS);
