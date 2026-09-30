import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'headless-cursor-test-'));
const bin = join(root, 'bin');
const repo = join(root, 'repo');
mkdirSync(bin);
mkdirSync(repo);
// The fake prints Cursor's stream-json shape: narration, a tool call, then
// either a final reply or (as plan mode sometimes does) a CreatePlan call.
writeFileSync(join(bin, 'cursor-agent'), `#!/usr/bin/env node
const fs = require('node:fs');
const mode = process.env.FAKE_CURSOR_MODE;
fs.writeFileSync(process.env.FAKE_CURSOR_ARGV, JSON.stringify(process.argv.slice(2)));
const say = (text) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });
const tool = (call) => ({ type: 'tool_call', subtype: 'started', tool_call: call });
const events = [say('Reading the diff first.'), tool({ shellToolCall: { args: { command: 'git diff' } } })];
if (mode === 'mutate') fs.appendFileSync('tracked.txt', 'drift\\n');
if (mode === 'fail') process.exit(1);
// Reconnect notices once passed as findings under text output.
if (mode === 'empty') process.stderr.write('Connection lost, reconnecting (attempt 1)...\\n');
if (mode === 'ok' || mode === 'mutate') events.push(say('one material finding'));
if (mode === 'plan') events.push(tool({ createPlanToolCall: { args: { name: 'Review', plan: 'finding filed as a plan' } } }));
events.push({ type: 'result', subtype: 'success', is_error: false, result: 'Reading the diff first.' });
for (const event of events) process.stdout.write(JSON.stringify(event) + '\\n');
`);
chmodSync(join(bin, 'cursor-agent'), 0o755);
writeFileSync(join(repo, 'tracked.txt'), 'base\n');
spawnSync('git', ['-C', repo, 'init', '-q']);
spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t.test', 'add', '.']);
spawnSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t.test', 'commit', '-qm', 'init']);

const script = join(new URL('.', import.meta.url).pathname, 'headless-cursor.mjs');
const argvLog = join(root, 'argv.json');
const env = (mode) => ({
  ...process.env,
  PATH: `${bin}:${process.env.PATH}`,
  FAKE_CURSOR_ARGV: argvLog,
  FAKE_CURSOR_MODE: mode,
});
const run = (mode, ...args) => JSON.parse(execFileSync(
  process.execPath,
  [script, ...args, '--cwd', repo],
  { encoding: 'utf8', env: env(mode) },
));
const fail = (mode, ...args) => {
  try {
    run(mode, ...args);
  } catch (error) {
    return JSON.parse(error.stdout);
  }
  throw new Error('expected failure');
};

test('Cursor review pins the range and runs trusted, read-only plan mode', () => {
  const result = run('ok', 'axis: Standards', '--model', 'grok-4.7-high', '--base', 'HEAD');
  assert.equal(result.ok, true);
  assert.equal(result.model, 'grok-4.7-high');
  assert.equal(result.result, 'one material finding');
  assert.equal(result.review_range.selector, '--base');
  const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
  assert.deepEqual(argv.slice(0, 8), ['-p', '--trust', '--mode', 'plan', '--output-format', 'stream-json', '--model', 'grok-4.7-high']);
  assert.match(argv.at(-1), /The range is fixed\. Do not recompute it/u);
});

test('Cursor review keeps findings filed through CreatePlan', () => {
  assert.equal(run('plan', 'review', '--model', 'm', '--base', 'HEAD').result, 'finding filed as a plan');
});

test('Cursor review requires a model and one range', () => {
  assert.match(fail('ok', 'review', '--base', 'HEAD').reason, /--model is required/u);
  assert.match(fail('ok', 'review', '--model', 'm').reason, /exactly one range selector required/u);
});

test('Cursor review refuses GPT models, which run only through Codex', () => {
  writeFileSync(argvLog, 'not started');
  assert.match(fail('ok', 'review', '--model', 'gpt-5.6-sol-high', '--base', 'HEAD').reason, /run only through headless-codex\.mjs/u);
  assert.equal(readFileSync(argvLog, 'utf8'), 'not started');
});

test('Cursor review rejects empty output, failures, and tree changes', () => {
  assert.match(fail('empty', 'review', '--model', 'm', '--base', 'HEAD').reason, /output is empty/u);
  assert.match(fail('fail', 'review', '--model', 'm', '--base', 'HEAD').reason, /exited 1/u);
  const changed = fail('mutate', 'review', '--model', 'm', '--base', 'HEAD');
  assert.match(changed.reason, /must stay read-only/u);
});
