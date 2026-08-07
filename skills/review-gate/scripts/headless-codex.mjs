#!/usr/bin/env node
// Runs one Codex review headless, with the same protections `headless-claude`
// gives the Claude leg: output-based liveness (stock macOS has no `timeout`),
// live stderr streaming for a visible Herdr pane, a kill of the PID itself
// (never the group), and content validation — exit 0 with an empty or missing
// final message is a FAILURE, not a pass.
//
//   node headless-codex.mjs "<axis prompt>" --base origin/main
//   node headless-codex.mjs "<axis prompt>" --commit <sha>
//   node headless-codex.mjs "<axis prompt>" --uncommitted
//   [--cwd <path>] [--model <m>] [--receipt <path>] [--idle-min 20] [--total-min 60]
//
// Exactly one range selector is required, and the wrapper resolves it to a SHA
// itself. `codex exec review` refuses its own `--base`/`--commit`/`--uncommitted`
// flags together with a custom prompt, and ship-it must assign a review axis —
// so the axis keeps the prompt and the range stops being a `git merge-base`
// command the model is asked to run. It arrives already resolved, and the exact
// SHA lands on the receipt for the delivery's chain of custody.
//
// Three differences from the Claude wrapper, all forced by the CLI surface:
//   * No baseline/restore. The run is pinned to `sandbox_mode="read-only"`, so
//     there is no writable mode to undo. The tree is fingerprinted before and
//     after anyway and any drift is reported on `tree_changed` for the caller.
//   * Sandbox and range arrive through `-c` and the prompt because
//     `codex exec review` accepts neither `--sandbox` nor `--color` nor `--cd`;
//     those belong to `codex exec` and its `review` subcommand rejects them.
//   * Codex publishes no `is_error` equivalent on this surface. Success is
//     therefore exit 0 AND a non-empty `--output-last-message` file; a refusal
//     that still writes prose reads as success here, so the caller must apply
//     ship-it's transcript content rules to `log` as well.
//
// Exit 0: JSON receipt {ok: true, result: "<final message>", ...}.
// Exit 1: {ok: false, reason, ...}.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, openSync, closeSync, existsSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const POLL_MS = 2000;

const argv = process.argv.slice(2);
const prompt = argv[0];
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const flag = (name) => argv.includes(`--${name}`);

const usage = 'usage: headless-codex.mjs "<prompt>" (--base <branch> | --commit <sha> | --uncommitted) [--cwd <path>] [--model <m>] [--receipt <path>] [--idle-min N] [--total-min N]';
if (!prompt || prompt.startsWith('--')) {
  process.stdout.write(JSON.stringify({ ok: false, reason: usage }) + '\n');
  process.exit(2);
}
const base = opt('base', null);
const commit = opt('commit', null);
const uncommitted = flag('uncommitted');
const cwd = opt('cwd', process.cwd());
const model = opt('model', null);
const receiptPath = opt('receipt', null);
const idleMs = parseFloat(opt('idle-min', '20')) * 60000;
const totalMs = parseFloat(opt('total-min', '60')) * 60000;

const emit = (obj, code) => {
  const output = JSON.stringify(obj, null, 2) + '\n';
  if (receiptPath) writeFileSync(receiptPath, output);
  process.stdout.write(output);
  process.exit(code);
};

// Ambiguous range selection is the exact failure this wrapper exists to
// prevent, so two selectors is a usage error rather than a silent precedence.
const selectors = [base && '--base', commit && '--commit', uncommitted && '--uncommitted'].filter(Boolean);
if (selectors.length !== 1) {
  emit({ ok: false, reason: `exactly one range selector required, got ${selectors.length ? selectors.join(' + ') : 'none'}. ${usage}` }, 2);
}

const git = (...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
const fingerprint = () => git('diff', 'HEAD', '--binary').stdout;
const baselineTree = fingerprint();

// Resolving here rather than in the prompt is the point: a ref that does not
// exist fails now, with the reason, instead of becoming a review of the wrong
// range or a model that quietly reviews whatever it can find.
let range;
if (base) {
  const mergeBase = git('merge-base', 'HEAD', base);
  if (mergeBase.status !== 0) {
    emit({ ok: false, reason: `cannot resolve the merge base with ${base}: ${mergeBase.stderr.trim()}` }, 1);
  }
  const sha = mergeBase.stdout.trim();
  range = { selector: '--base', ref: base, resolved_sha: sha, diff_command: `git diff ${sha}` };
} else if (commit) {
  const resolved = git('rev-parse', '--verify', `${commit}^{commit}`);
  if (resolved.status !== 0) {
    emit({ ok: false, reason: `cannot resolve commit ${commit}: ${resolved.stderr.trim()}` }, 1);
  }
  const sha = resolved.stdout.trim();
  range = { selector: '--commit', ref: commit, resolved_sha: sha, diff_command: `git diff ${sha}^ ${sha}` };
} else {
  range = { selector: '--uncommitted', ref: null, resolved_sha: null, diff_command: 'git diff HEAD' };
}

const work = mkdtempSync(join(tmpdir(), 'headless-codex-'));
const lastMessagePath = join(work, 'last-message.txt');
const logPath = join(work, 'run.log');
const logFd = openSync(logPath, 'w');

const composedPrompt = [
  `Review exactly the changes produced by this already-resolved command:`,
  ``,
  `    ${range.diff_command}`,
  ``,
  `The range is fixed. Do not recompute it, do not pick a different base, and`,
  `do not report on anything outside it.`,
  ``,
  prompt,
].join('\n');

const args = [
  'exec', 'review',
  '--json',
  '--config', 'sandbox_mode="read-only"',
  '--output-last-message', lastMessagePath,
  ...(model ? ['--model', model] : []),
  composedPrompt,
];

const started = Date.now();
const child = spawn('codex', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
// Liveness is measured on the bytes themselves: the parent sees every chunk,
// so there is nothing left for a filesystem size poll to learn.
let lastGrowth = Date.now();
let visibleOutputOpen = true;
process.stderr.on('error', (error) => {
  if (error.code === 'EPIPE') {
    visibleOutputOpen = false;
    return;
  }
  throw error;
});
const mirror = (chunk) => {
  writeSync(logFd, chunk);
  if (visibleOutputOpen) process.stderr.write(chunk);
  lastGrowth = Date.now();
};
child.stdout.on('data', mirror);
child.stderr.on('data', mirror);

const finish = (outcome) => {
  closeSync(logFd);
  const seconds = Math.round((Date.now() - started) / 1000);
  const record = { command: ['codex', ...args], review_range: range, seconds, log: logPath, ...outcome };
  // The sandbox is the enforcement; this is the audit trail. It never fails the
  // run on its own — in a shared worktree an unrelated edit would read as
  // review drift, and a false failure on a valid review costs more than a
  // reported one the caller can check.
  if (fingerprint() !== baselineTree) {
    record.tree_changed = 'the working tree changed during a read-only review — inspect before trusting this diff';
  }
  emit(record, record.ok ? 0 : 1);
};

let exit = null;
child.on('close', (code) => { exit = code ?? -1; });
child.on('error', () => { exit = -1; });

const timer = setInterval(() => {
  if (exit !== null) {
    clearInterval(timer);
    // Complete means exit 0 AND a final message with non-empty content — a
    // clean exit around an empty payload must read as failure, never as a
    // passed review.
    if (exit !== 0) return finish({ ok: false, reason: `codex exited ${exit}`, exit_code: exit });
    if (!existsSync(lastMessagePath)) {
      return finish({ ok: false, reason: 'no final message file — not a completed review', exit_code: exit });
    }
    const text = readFileSync(lastMessagePath, 'utf8').trim();
    if (!text) return finish({ ok: false, reason: 'final message is empty — content validation failed', exit_code: exit });
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
