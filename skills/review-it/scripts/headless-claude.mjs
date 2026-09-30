#!/usr/bin/env node
// Runs one Claude review headless in read-only plan mode. headless-run.mjs owns
// the shared supervision: output-based liveness (stock macOS has no `timeout`),
// live stderr for a visible Herdr pane, and a kill of the PID itself, never the
// group. What stays here is Claude's argv and its stream-json success
// predicate: exit 0 with an empty or missing result is a FAILURE, not a pass.
//
//   node headless-claude.mjs "<review prompt>" [--cwd <path>] [--model opus]
//     [--effort <level>] [--receipt <path>] [--idle-min 20] [--total-min 60]
//
// Exit 0: JSON receipt {ok: true, result: "<final result text>", ...}.
// Exit 1: {ok: false, reason, ...}.
import { mkdtempSync, openSync, closeSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { optionReader, receiptEmitter, supervise } from './headless-run.mjs';

const argv = process.argv.slice(2);
const prompt = argv[0];
const { opt } = optionReader(argv);
if (!prompt || prompt.startsWith('--')) {
  process.stdout.write(JSON.stringify({ ok: false, reason: 'usage: headless-claude.mjs "<review prompt>" [--cwd <path>] [--model opus] [--effort <level>] [--receipt <path>] [--idle-min N] [--total-min N]' }) + '\n');
  process.exit(2);
}
const cwd = opt('cwd', process.cwd());
const model = opt('model', 'opus');
const effort = opt('effort', null);
const emit = receiptEmitter(opt('receipt', null));
const idleMs = parseFloat(opt('idle-min', '20')) * 60000;
const totalMs = parseFloat(opt('total-min', '60')) * 60000;

const logPath = join(mkdtempSync(join(tmpdir(), 'headless-claude-')), 'run.log');
const logFd = openSync(logPath, 'w');

const finish = (outcome) => {
  closeSync(logFd);
  const seconds = Math.round((Date.now() - startedAt) / 1000);
  emit({ model, effort, seconds, log: logPath, ...outcome }, outcome.ok ? 0 : 1);
};

const { startedAt } = supervise({
  bin: 'claude',
  args: ['-p', '--model', model, ...(effort ? ['--effort', effort] : []), '--permission-mode', 'plan', '--strict-mcp-config', '--no-chrome', '--output-format', 'stream-json', '--verbose', prompt],
  cwd,
  logFd,
  idleMs,
  totalMs,
  // Complete means exit 0 AND a final result event with is_error false AND
  // non-empty content — a clean exit around a refusal or empty payload must
  // read as failure, never as a passed run.
  onExit: (exit) => {
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
  },
  onHang: (why) => finish({ ok: false, reason: `hang: ${why}`, killed: true }),
});
