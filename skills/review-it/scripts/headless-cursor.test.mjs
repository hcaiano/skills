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
writeFileSync(join(bin, 'cursor-agent'), `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_CURSOR_ARGV, JSON.stringify(process.argv.slice(2)));
if (process.env.FAKE_CURSOR_MODE === 'mutate') fs.appendFileSync('tracked.txt', 'drift\\n');
if (process.env.FAKE_CURSOR_MODE === 'fail') process.exit(1);
if (process.env.FAKE_CURSOR_MODE !== 'empty') process.stdout.write('one material finding\\n');
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

test('Cursor review pins the range and uses read-only plan mode', () => {
  const result = run('ok', 'axis: Standards', '--model', 'cursor-grok-4.6-high', '--base', 'HEAD');
  assert.equal(result.ok, true);
  assert.equal(result.model, 'cursor-grok-4.6-high');
  assert.equal(result.result, 'one material finding');
  assert.equal(result.review_range.selector, '--base');
  const argv = JSON.parse(readFileSync(argvLog, 'utf8'));
  assert.deepEqual(argv.slice(0, 7), ['-p', '--mode', 'plan', '--output-format', 'text', '--model', 'cursor-grok-4.6-high']);
  assert.match(argv.at(-1), /The range is fixed\. Do not recompute it/u);
});

test('Cursor review requires a model and one range', () => {
  assert.match(fail('ok', 'review', '--base', 'HEAD').reason, /--model is required/u);
  assert.match(fail('ok', 'review', '--model', 'm').reason, /exactly one range selector required/u);
});

test('Cursor review rejects empty output, failures, and tree changes', () => {
  assert.match(fail('empty', 'review', '--model', 'm', '--base', 'HEAD').reason, /output is empty/u);
  assert.match(fail('fail', 'review', '--model', 'm', '--base', 'HEAD').reason, /exited 1/u);
  const changed = fail('mutate', 'review', '--model', 'm', '--base', 'HEAD');
  assert.match(changed.reason, /must stay read-only/u);
});
