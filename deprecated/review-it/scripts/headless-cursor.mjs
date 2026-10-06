#!/usr/bin/env node
// Runs one fresh Cursor review in read-only plan mode. It resolves the review
// range before model startup, records that range, requires non-empty output,
// and fingerprints the tree before and after the run.
//
// Plan mode sometimes files the findings through its CreatePlan tool instead of
// a final reply. Text output then holds only stderr noise, such as reconnect
// notices; every empty Cursor review on 2026-09-29/30 had done this. stream-json
// carries both the plan and the reply, and its steady events keep the idle
// deadline honest on long runs.
//
//   node headless-cursor.mjs "<axis prompt>" --model <id> --base origin/main
//   node headless-cursor.mjs "<axis prompt>" --model <id> --commit <sha>
//   node headless-cursor.mjs "<axis prompt>" --model <id> --uncommitted
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitRunner, optionReader, receiptEmitter, supervise } from './headless-run.mjs';

const argv = process.argv.slice(2);
const prompt = argv[0];
const { opt, flag } = optionReader(argv);
const usage = 'usage: headless-cursor.mjs "<prompt>" --model <id> (--base <branch> | --commit <sha> | --uncommitted) [--cwd <path>] [--receipt <path>] [--idle-min N] [--total-min N]';
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
const emit = receiptEmitter(receiptPath);

if (!model) emit({ ok: false, reason: `--model is required. ${usage}` }, 2);
// OpenAI no longer serves Cursor, so its GPT entries are stale.
if (/^gpt-/iu.test(model)) emit({ ok: false, reason: `${model} is a GPT model; GPT reviews run only through headless-codex.mjs` }, 2);
const selectors = [base && '--base', commit && '--commit', uncommitted && '--uncommitted'].filter(Boolean);
if (selectors.length !== 1) {
  emit({ ok: false, reason: `exactly one range selector required, got ${selectors.length ? selectors.join(' + ') : 'none'}. ${usage}` }, 2);
}

const git = gitRunner(cwd);
const fingerprint = () => {
  const diff = git('diff', 'HEAD', '--binary');
  const untracked = git('ls-files', '--others', '--exclude-standard', '-z');
  if (diff.status !== 0 || untracked.status !== 0) return null;
  const hashes = untracked.stdout.split('\0').filter(Boolean).sort().map((file) => {
    const path = join(cwd, file);
    try {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) return `${file}:symlink:${readlinkSync(path)}`;
      if (!stat.isFile()) return `${file}:special:${stat.mode}`;
      return `${file}:file:${createHash('sha256').update(readFileSync(path)).digest('hex')}`;
    } catch {
      return `${file}:unreadable`;
    }
  });
  return `${diff.stdout}\n--untracked--\n${hashes.join('\n')}`;
};
const baselineTree = fingerprint();
if (baselineTree == null) emit({ ok: false, reason: 'cannot fingerprint the working tree before the review' }, 1);

let range;
if (base) {
  const mergeBase = git('merge-base', 'HEAD', base);
  if (mergeBase.status !== 0) emit({ ok: false, reason: `cannot resolve the merge base with ${base}: ${mergeBase.stderr.trim()}` }, 1);
  const sha = mergeBase.stdout.trim();
  range = { selector: '--base', ref: base, resolved_sha: sha, diff_command: `git diff ${sha}` };
} else if (commit) {
  const resolved = git('rev-parse', '--verify', `${commit}^{commit}`);
  if (resolved.status !== 0) emit({ ok: false, reason: `cannot resolve commit ${commit}: ${resolved.stderr.trim()}` }, 1);
  const sha = resolved.stdout.trim();
  range = { selector: '--commit', ref: commit, resolved_sha: sha, diff_command: `git diff ${sha}^ ${sha}` };
} else {
  range = { selector: '--uncommitted', ref: null, resolved_sha: null, diff_command: 'git diff HEAD' };
}

const work = mkdtempSync(join(tmpdir(), 'headless-cursor-'));
const logPath = join(work, 'run.log');
const logFd = openSync(logPath, 'w');
const composedPrompt = [
  'Review exactly the changes produced by this already-resolved command:',
  '',
  `    ${range.diff_command}`,
  '',
  'The range is fixed. Do not recompute it, do not pick a different base, and',
  'do not report on anything outside it. Return findings only; make no edits.',
  '',
  prompt,
].join('\n');
// A fresh worktree is untrusted, and -p then exits 1 on the trust prompt.
const args = ['-p', '--trust', '--mode', 'plan', '--output-format', 'stream-json', '--model', model, composedPrompt];

const reviewText = (transcript) => {
  const events = transcript.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const result = events.findLast((event) => event.type === 'result');
  if (!result) return { reason: 'no result event — not a completed review' };
  if (result.is_error) return { reason: 'result event carries is_error' };
  const plan = events.findLast((event) => typeof event.tool_call?.createPlanToolCall?.args?.plan === 'string')
    ?.tool_call.createPlanToolCall.args.plan;
  // Earlier assistant segments narrate tool calls; the reply follows the last one.
  const lastTool = events.findLastIndex((event) => event.type === 'tool_call');
  const reply = events.slice(lastTool + 1)
    .filter((event) => event.type === 'assistant')
    .flatMap((event) => event.message?.content ?? [])
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('');
  const text = [plan, reply].map((part) => part?.trim()).filter(Boolean).join('\n\n');
  return text ? { text } : { reason: 'review output is empty — content validation failed' };
};

const finish = (outcome) => {
  closeSync(logFd);
  const record = {
    command: ['cursor-agent', ...args],
    review_range: range,
    model,
    seconds: Math.round((Date.now() - startedAt) / 1000),
    log: logPath,
    ...outcome,
  };
  const finalTree = fingerprint();
  if (finalTree == null) {
    record.tree_changed = 'cannot fingerprint the working tree after the review — inspect before trusting this diff';
    record.ok = false;
    record.reason ??= 'tree fingerprint failed after a review that must stay read-only';
  } else if (finalTree !== baselineTree) {
    record.tree_changed = 'the working tree changed during the review — inspect before trusting this diff';
    record.ok = false;
    record.reason ??= 'tree changed during a review that must stay read-only';
  }
  emit(record, record.ok ? 0 : 1);
};

const { startedAt } = supervise({
  bin: 'cursor-agent',
  args,
  cwd,
  logFd,
  idleMs,
  totalMs,
  onExit: (exit) => {
    if (exit !== 0) return finish({ ok: false, reason: `cursor-agent exited ${exit}`, exit_code: exit });
    const { text, reason } = reviewText(readFileSync(logPath, 'utf8'));
    if (!text) return finish({ ok: false, reason, exit_code: exit });
    return finish({ ok: true, exit_code: exit, result: text });
  },
  onHang: (why) => finish({ ok: false, reason: `hang: ${why}`, killed: true }),
});
