import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const exec = promisify(execFile);
const scripts = fileURLToPath(new URL('.', import.meta.url));
const from = '2026-10-12T12:00:00.000Z', to = '2026-10-13T12:00:00.000Z';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'retro-test-'));
  t.after(() => exec('trash', [root]));
  for (const path of ['claude-home/projects', 'codex-home/sessions', 'grok-home/sessions', 'cursor-home/chats']) await mkdir(join(root, '.t3', path), { recursive: true });
  return root;
}
async function put(root, path, value) {
  const target = join(root, '.t3', path); await mkdir(join(target, '..'), { recursive: true });
  await writeFile(target, Array.isArray(value) ? value.map(x => JSON.stringify(x)).join('\n') + '\n' : JSON.stringify(value));
  return target;
}
async function run(script, root, more = [], expected = 0, nodeArgs = []) {
  const out = join(root, `out-${Math.random().toString(16).slice(2)}`);
  const args = [...nodeArgs, join(scripts, script), '--out', out, '--home', root, '--machine', 'fixture', '--from', from, '--to', to, ...more];
  try { await exec(process.execPath, args); assert.equal(expected, 0); }
  catch (e) { assert.equal(e.code, expected, e.stderr || e.message); }
  const index = JSON.parse(await readFile(join(out, 'index.json'), 'utf8'));
  const rows = [];
  for (const part of index.parts) {
    assert.equal((await stat(join(out, part.file))).size, part.bytes);
    for (const line of (await readFile(join(out, part.file), 'utf8')).trim().split('\n')) if (line) rows.push(JSON.parse(line));
  }
  return { out, index, rows };
}

test('provider CLI filters exact window, groups children, separates Grok context and Cursor probes', async t => {
  const root = await fixture(t);
  const path = await put(root, 'claude-home/projects/p/parent.jsonl', [
    { sessionId: 'parent', timestamp: '2026-10-12T11:59:59Z' },
    { sessionId: 'parent', timestamp: from, tool: 'exec', input: { cmd: 'gh pr view https://github.com/a/b/pull/12' }, result: { ok: true } },
    { sessionId: 'parent', timestamp: to },
    { sessionId: 'parent', timestamp: '2026-10-13T13:00:00Z' },
  ]);
  await utimes(path, new Date('2026-10-14Z'), new Date('2026-10-14Z'));
  await put(root, 'claude-home/projects/p/parent/subagents/child.jsonl', [{ sessionId: 'child', timestamp: from }]);
  await put(root, 'grok-home/sessions/p/g/updates.jsonl', [
    { timestamp: Date.parse(from) / 1000, method: 'tool', params: { name: 'shell' } },
    { timestamp: Date.parse(to), method: 'excluded' },
  ]);
  await put(root, 'grok-home/sessions/p/g/chat_history.jsonl', [{ text: 'https://github.com/a/b/pull/999' }]);
  await put(root, 'cursor-home/chats/p/probe/meta.json', { hasConversation: false, updatedAtMs: Date.parse(from) });
  await put(root, 'codex-home/sessions/rollout-s.jsonl', [{ timestamp: '2026-10-11T12:00:00Z', type: 'session_meta', payload: { id: 'native-codex' } }, { timestamp: from, text: 'hello' }]);
  const { index, rows } = await run('collect-sessions.mjs', root);
  assert.equal(rows.filter(r => r.kind === 'activity').length, 4);
  assert.equal(rows.find(r => r.childSessionId)?.sessionId, 'parent');
  assert.equal(rows.find(r => r.raw.tool)?.raw.result.ok, true);
  assert.equal(index.sessions.g.context, 1);
  assert.deepEqual(Object.keys(index.prs), ['https://github.com/a/b/pull/12']);
  assert.equal(index.sources.cursor.probes, 1);
  assert.equal(index.sessions['native-codex'].activity, 1);
});

test('redaction precedes bounded UTF-8 fragmentation and restores structured tools', async t => {
  const root = await fixture(t);
  const secrets = ['shortpw', 'shorttoken', 'sk-proj-abcdefghijk', 'ghp_abcdefghijkl', 'keycontents', 'urlpass'];
  await put(root, 'codex-home/sessions/s.jsonl', [{ timestamp: from, tool: 'shell', input: {
    password: secrets[0], nested: { access_token: secrets[1] },
    arguments: JSON.stringify({ private_key: '-----BEGIN PRIVATE KEY-----\nkeycontents\n-----END PRIVATE KEY-----', cmd: 'PASSWORD="shortpw"' }),
    cmd: `curl -H 'Authorization: Bearer shorttoken' https://user:urlpass@example.com ${secrets[2]} ${secrets[3]}`,
  }, result: 'é'.repeat(7000) }]);
  const { index, rows, out } = await run('collect-sessions.mjs', root, ['--part-bytes', '2048']);
  assert.ok(index.parts.length > 1);
  assert.ok(index.parts.every(p => p.bytes <= 2048));
  const restored = JSON.parse(Buffer.concat(rows.map(r => Buffer.from(r.data, 'base64'))).toString());
  assert.equal(restored.raw.tool, 'shell'); assert.equal(restored.raw.result, 'é'.repeat(7000));
  assert.equal(restored.raw.input.password, '[REDACTED]');
  const text = JSON.stringify(restored) + await readFile(join(out, 'index.json'), 'utf8');
  for (const secret of secrets) assert.ok(!text.includes(secret), secret);
  assert.equal(new Set(rows.map(r => r.recordId)).size, 1);
  assert.deepEqual(rows.map(r => r.fragment), rows.map((_, i) => i));
});

test('malformed lines and unavailable Cursor timelines produce partial receipts', async t => {
  const root = await fixture(t);
  await put(root, 'cursor-home/chats/p/chat/meta.json', { hasConversation: true, updatedAtMs: Date.parse(from) });
  await writeFile(join(root, '.t3/codex-home/sessions/bad.jsonl'), '{}\ninvalid\n');
  const { index } = await run('collect-sessions.mjs', root, [], 1);
  assert.equal(index.complete, false);
  assert.deepEqual(index.gaps.map(x => x.kind).sort(), ['cursor-timeline-required', 'malformed-jsonl', 'missing-timestamp']);
});

test('transcript larger than Node heap streams through the public CLI', async t => {
  const root = await fixture(t);
  const file = await open(join(root, '.t3/codex-home/sessions/large.jsonl'), 'w');
  const line = JSON.stringify({ timestamp: to, text: 'x'.repeat(2048) }) + '\n';
  for (let i = 0; i < 24000; i++) await file.writeFile(line);
  await file.writeFile(JSON.stringify({ timestamp: from, text: 'selected' }) + '\n'); await file.close();
  assert.ok((await stat(join(root, '.t3/codex-home/sessions/large.jsonl'))).size > 48 * 1024 ** 2);
  const { rows } = await run('collect-sessions.mjs', root, [], 0, ['--max-old-space-size=24']);
  assert.deepEqual(rows.map(r => r.raw.text), ['selected']);
});

test('read-only SQLite extracts activity, ancestor chains, failures and spanning runs without restart noise', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const root = await fixture(t); const path = join(root, 'state.sqlite'); const db = new DatabaseSync(path);
  const specs = {
    threads: 'thread_id TEXT, payload_json TEXT', messages: 'thread_id TEXT, run_id TEXT, created_at TEXT, payload_json TEXT',
    turn_items: 'thread_id TEXT, run_id TEXT, payload_json TEXT', runs: 'thread_id TEXT, run_id TEXT, requested_at TEXT, completed_at TEXT, status TEXT, payload_json TEXT',
    run_attempts: 'thread_id TEXT, run_id TEXT, payload_json TEXT', nodes: 'thread_id TEXT, run_id TEXT, payload_json TEXT',
    subagents: 'thread_id TEXT, child_thread_id TEXT, run_id TEXT, payload_json TEXT', provider_threads: 'thread_id TEXT, payload_json TEXT',
  };
  for (const [table, columns] of Object.entries(specs)) db.exec(`CREATE TABLE orchestration_v2_projection_${table} (${columns})`);
  function insert(table, row) {
    const keys = Object.keys(row); db.prepare(`INSERT INTO orchestration_v2_projection_${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...Object.values(row));
  }
  for (const id of ['root', 'middle', 'child', 'restart', 'fork']) insert('threads', { thread_id: id, payload_json: JSON.stringify({ id, updatedAt: from, forkedFrom: id === 'fork' ? 'root' : null }) });
  insert('subagents', { thread_id: 'root', child_thread_id: 'middle', payload_json: '{}' });
  insert('subagents', { thread_id: 'middle', child_thread_id: 'child', payload_json: '{}' });
  insert('messages', { thread_id: 'child', run_id: 'failed', created_at: '2026-10-12T13:00:00+01:00', payload_json: '{"text":"inside"}' });
  insert('messages', { thread_id: 'restart', created_at: to, payload_json: '{"text":"outside"}' });
  insert('messages', { thread_id: 'fork', created_at: from, payload_json: '{"text":"fork"}' });
  insert('runs', { thread_id: 'child', run_id: 'failed', requested_at: from, completed_at: '2026-10-12T14:00:00Z', status: 'failed', payload_json: '{"status":"failed"}' });
  insert('runs', { thread_id: 'root', run_id: 'ongoing', requested_at: '2026-10-11T00:00:00Z', status: 'running', payload_json: '{"status":"running"}' });
  insert('run_attempts', { thread_id: 'child', run_id: 'failed', payload_json: '{"status":"failed","error":"provider failed"}' });
  insert('nodes', { thread_id: 'child', run_id: 'failed', payload_json: '{"status":"failed"}' });
  insert('turn_items', { thread_id: 'child', run_id: 'failed', payload_json: JSON.stringify({ type: 'error', startedAt: from, error: 'tool failed', token: 'dont-expose' }) });
  insert('provider_threads', { thread_id: 'child', payload_json: '{"nativeThreadRef":{"nativeId":"native-child"},"driver":"cursor"}' });
  const taskCols = ['task_id','title','prompt','enabled','schedule_json','project_id','thread_id','workspace_strategy_json','model_selection_json','runtime_mode','interaction_mode','created_at','updated_at','next_run_at','last_run_at','last_run_status','last_run_error','run_count','webhook_secret','webhook_token'];
  db.exec(`CREATE TABLE scheduled_tasks (${taskCols.map(c => c + ' TEXT').join(',')})`);
  db.exec("INSERT INTO scheduled_tasks (task_id, title, prompt, schedule_json, webhook_secret, webhook_token) VALUES ('task', '[A] keep', 'PASSWORD=hidden', '{\"type\":\"interval\"}', 'webhook-secret-value', 'webhook-token-value')");
  db.close(); const before = await readFile(path);
  const { index, rows } = await run('collect-t3.mjs', root, ['--db', path]);
  assert.equal(index.counts.activeThreads, 3); assert.equal(index.counts.ancestorThreads, 1);
  assert.equal(index.counts.runs, 2); assert.equal(index.counts.attempts, 1);
  assert.ok(!rows.some(r => r.threadId === 'restart'));
  assert.equal(rows.find(r => r.raw.id === 'child').parentThreadId, 'middle');
  assert.equal(rows.find(r => r.raw.id === 'fork').parentThreadId, undefined);
  assert.equal(rows.find(r => r.runId === 'ongoing').kind, 'metadata');
  assert.ok(rows.some(r => r.raw.error === 'provider failed'));
  assert.equal(index.nativeMappings[0].nativeThreadRef.nativeId, 'native-child');
  assert.ok(!JSON.stringify(rows).includes('dont-expose'));
  const tasks = await run('list-scheduled-tasks.mjs', root, ['--db', path]);
  assert.equal(tasks.rows[0].raw.title, '[A] keep');
  for (const secret of ['hidden', 'webhook-secret-value', 'webhook-token-value', 'webhook_secret', 'webhook_token']) assert.ok(!JSON.stringify(tasks).includes(secret), secret);
  assert.deepEqual(await readFile(path), before);
  const changed = new DatabaseSync(path);
  changed.exec("INSERT INTO orchestration_v2_projection_subagents (thread_id, child_thread_id, payload_json) VALUES ('child', 'root', '{}'), ('missing', 'fork', '{}')");
  changed.close();
  const partial = await run('collect-t3.mjs', root, ['--db', path], 1);
  assert.ok(partial.index.gapCounts['cyclic-lineage'] > 0);
  assert.equal(partial.index.gapCounts['unresolved-thread'], 1);
});
