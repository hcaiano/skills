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
  let stdout;
  try { ({ stdout } = await exec(process.execPath, args, { timeout: 15000 })); assert.equal(expected, 0); }
  catch (e) { stdout = e.stdout; assert.equal(e.code, expected, e.stderr || e.message); }
  const index = JSON.parse(await readFile(join(out, 'index.json'), 'utf8'));
  const rows = [];
  for (const part of index.parts) {
    assert.equal((await stat(join(out, part.file))).size, part.bytes);
    for (const line of (await readFile(join(out, part.file), 'utf8')).trim().split('\n')) if (line) rows.push(JSON.parse(line));
  }
  return { out, index, rows, stdout };
}

test('PR index stores safe identifiers and drops credential-bearing URL segments', async t => {
  const root = await fixture(t);
  await put(root, 'codex-home/sessions/pr-index.jsonl', [{ timestamp: from, text: [
    'https://github.com/ghp_INDEX_CREDENTIAL/repo/pull/8',
    'https://github.com/owner/répo/pull/9',
    'https://github.com/owner/repo/pull/10-invalid',
    'https://github.com/Owner_1/Repo.name-2/pull/0011?token=INDEX_QUERY_CREDENTIAL',
  ].join('\n') }]);
  const { index, rows, out } = await run('collect-sessions.mjs', root);
  assert.deepEqual(index.prs, { 'Owner_1/Repo.name-2#11': [{ machine: 'fixture', sessionId: 'pr-index' }] });
  const emitted = JSON.stringify(rows) + await readFile(join(out, 'index.json'), 'utf8');
  for (const secret of ['ghp_INDEX_CREDENTIAL', 'INDEX_QUERY_CREDENTIAL']) assert.ok(!emitted.includes(secret), secret);
});

test('structured header names redact their entire associated values', async t => {
  const root = await fixture(t);
  await put(root, 'codex-home/sessions/header-pairs.jsonl', [{ timestamp: from, headers: [
    { name: 'cOoKiE', value: 'PAIR_COOKIE; second=PAIR_SECOND', extra: 'visible' },
    { name: 'Authorization', value: ['PAIR_AUTH', { nested: 'PAIR_NESTED' }] },
    ['Proxy-Authorization', 'PAIR_PROXY'],
    ['Cookie', ['PAIR_ARRAY', 'PAIR_OTHER']],
    { name: 'X-Public', value: 'visible' },
    ['X-Public', 'visible'],
  ] }]);
  const { rows, out } = await run('collect-sessions.mjs', root);
  assert.deepEqual(rows[0].raw.headers, [
    { name: 'cOoKiE', value: '[REDACTED]', extra: 'visible' },
    { name: 'Authorization', value: '[REDACTED]' },
    ['Proxy-Authorization', '[REDACTED]'],
    ['Cookie', '[REDACTED]'],
    { name: 'X-Public', value: 'visible' },
    ['X-Public', 'visible'],
  ]);
  assert.ok(!(JSON.stringify(rows) + await readFile(join(out, 'index.json'), 'utf8')).includes('PAIR_'));
});

test('multiline quoted passwords hide the whole field and preserve record metadata', async t => {
  const root = await fixture(t);
  await put(root, 'codex-home/sessions/multiline-password.jsonl', [{ timestamp: from, tool: 'exec', id: 'call-1', size: 123,
    input: { cmd: ['mysql --password "FIRST_VALUE', 'UNINDENTED_VALUE', 'LAST_VALUE"', 'echo done'].join('\n') },
    output: 'completed', messages: ['ordinary message', 'password=MESSAGE_PASSWORD'],
    structured: { fields: [{ content: 'secret=FIELD_SECRET' }] },
  }]);
  const { rows } = await run('collect-sessions.mjs', root);
  assert.deepEqual(rows[0].raw, { timestamp: from, tool: 'exec', id: 'call-1', size: 123,
    input: { cmd: '[REDACTED: credential]' }, output: 'completed',
    messages: ['ordinary message', '[REDACTED: credential]'],
    structured: { fields: [{ content: '[REDACTED: credential]' }] },
  });
  assert.equal(rows[0].timestamp, from);
  assert.equal(rows[0].sessionId, 'multiline-password');
});

test('credential headers hide long tool outputs while their PRs remain indexed', async t => {
  const root = await fixture(t);
  await put(root, 'codex-home/sessions/long-header.jsonl', [{ timestamp: from, tool: 'shell', id: 'call-2', size: 524288,
    output: 'public log\n'.repeat(25000) + 'Cookie: session=LONG_HEADER_CREDENTIAL\nhttps://github.com/owner/repo/pull/43\n' + 'public log\n'.repeat(25000),
    result: { ok: true },
  }]);
  const { rows, index } = await run('collect-sessions.mjs', root);
  assert.deepEqual(rows[0].raw, { timestamp: from, tool: 'shell', id: 'call-2', size: 524288, output: '[REDACTED: credential]', result: { ok: true } });
  assert.deepEqual(index.prs, { 'owner/repo#43': [{ machine: 'fixture', sessionId: 'long-header' }] });
});

test('sensitive shell flags hide concatenated quotes and continued lines', async t => {
  const root = await fixture(t);
  await put(root, 'codex-home/sessions/shell-flags.jsonl', [{ timestamp: from, commands: [
    `tool --password 'FLAG_FIRST'"FLAG_SECOND"; echo FLAG_TAIL`,
    ['tool --password \\', 'FLAG_CONTINUED\\', 'FLAG_LAST', 'echo visible'].join('\n'),
    ['mysql -p \\', 'FLAG_SHORT', 'echo visible'].join('\r\n'),
    'mysql -pFLAG_ATTACHED',
  ], pairOfCommands: ['tool --password FLAG_PAIR', 'echo visible'] }]);
  const { rows, out } = await run('collect-sessions.mjs', root);
  assert.deepEqual(rows[0].raw.commands, [
    '[REDACTED: credential]', '[REDACTED: credential]',
    '[REDACTED: credential]', '[REDACTED: credential]',
  ]);
  assert.deepEqual(rows[0].raw.pairOfCommands, ['[REDACTED: credential]', 'echo visible']);
  assert.ok(!(JSON.stringify(rows) + await readFile(join(out, 'index.json'), 'utf8')).includes('FLAG_'));
});

test('whole sensitive fields are hidden while their PR references remain indexed', async t => {
  const root = await fixture(t);
  await put(root, 'codex-home/sessions/sensitive-line.jsonl', [{ timestamp: from,
    text: 'visible before\nlog password=LINE_CREDENTIAL; gh pr view https://github.com/owner/repo/pull/42\nvisible after',
    indicators: ['passwd', 'secret', 'token', 'api-key', 'api_key'].map(name => `before ${name}=LINE_CREDENTIAL after`),
    key: 'visible before\n-----BEGIN PRIVATE KEY-----\nLINE_KEY_BODY\n-----END PRIVATE KEY-----\nvisible after',
  }]);
  const { rows, index } = await run('collect-sessions.mjs', root);
  assert.equal(rows[0].raw.text, '[REDACTED: credential]');
  assert.deepEqual(rows[0].raw.indicators, Array(5).fill('[REDACTED: credential]'));
  assert.equal(rows[0].raw.key, '[REDACTED: credential]');
  assert.deepEqual(index.prs, { 'owner/repo#42': [{ machine: 'fixture', sessionId: 'sensitive-line' }] });
});

test('strong credential indicators hide entire string values', async t => {
  const root = await fixture(t);
  const values = [
    'Cookie: a=1', 'Set-Cookie: a=1', 'Authorization: Basic opaque', 'Proxy-Authorization: Digest opaque',
    'before Bearer opaque after', 'password=opaque', 'password: "opaque"', 'passwd=opaque',
    'secret=opaque', 'api_key=opaque', 'apikey=opaque', 'token=opaque',
    'tool --password opaque', 'tool --token="opaque"', 'tool --api-key opaque', 'tool --secret opaque',
    'tool --password "\nopaque\n"', 'password="\nopaque\n"',
    'mysql -popaque', '/usr/bin/mysqldump --user=root -p"opaque"', 'mariadb -popaque',
    '-----BEGIN RSA PRIVATE KEY-----\nopaque\n-----END RSA PRIVATE KEY-----',
    'before sk-proj-abcdefghijk after', 'ghp_abcdefghijk', 'gho_abcdefghijk',
    'xoxa-abcdefghijk', 'xoxb-abcdefghijk', 'xoxp-abcdefghijk', 'AKIAABCDEFGHIJKLMNOP',
    'before eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl after',
  ];
  await put(root, 'codex-home/sessions/strong-indicators.jsonl', [{ timestamp: from, values }]);
  const { rows } = await run('collect-sessions.mjs', root);
  assert.deepEqual(rows[0].raw.values, Array(values.length).fill('[REDACTED: credential]'));
});

test('ordinary credential discussion and flags without values remain visible', async t => {
  const root = await fixture(t);
  const values = [
    'tokens used: 123', 'secret sauce', 'explain password handling', 'review API keys and private keys',
    'token=', 'password: ', 'secret=""', 'tool --password', "tool --token ''",
    'tool -pordinary', 'tool -p ordinary', 'psql -p5432', 'mysql -P3306',
  ];
  await put(root, 'codex-home/sessions/ordinary-discussion.jsonl', [{ timestamp: from, values,
    input: { cmd: 'echo tokens used' }, output: 'secret sauce', messages: [{ text: 'discuss secrets' }],
  }]);
  const { rows } = await run('collect-sessions.mjs', root);
  assert.deepEqual(rows[0].raw, { timestamp: from, values,
    input: { cmd: 'echo tokens used' }, output: 'secret sauce', messages: [{ text: 'discuss secrets' }],
  });
});

test('provider CLI filters exact window, groups children, separates Grok context and Cursor probes', async t => {
  const root = await fixture(t);
  const path = await put(root, 'claude-home/projects/p/parent.jsonl', [
    { sessionId: 'parent', timestamp: '2026-10-12T11:59:59Z' },
    { sessionId: 'parent', timestamp: from, tool: 'exec', input: { cmd: 'gh pr view https://github.com/a/b/pull/12' }, result: { ok: true } },
    { sessionId: 'parent', timestamp: to },
    { sessionId: 'parent', timestamp: '2026-10-13T13:00:00Z' },
  ]);
  await utimes(path, new Date('2026-10-14T00:00:00Z'), new Date('2026-10-14T00:00:00Z'));
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
  assert.deepEqual(Object.keys(index.prs), ['a/b#12']);
  assert.equal(index.sources.cursor.probes, 1);
  assert.equal(index.sessions['native-codex'].activity, 1);
});

test('redaction precedes bounded UTF-8 fragmentation and restores structured tools', async t => {
  const root = await fixture(t);
  const secrets = ['shortpw', 'shorttoken', 'sk-proj-abcdefghijk', 'ghp_abcdefghijkl', 'keycontents', 'urlpass', 'jsonpassword', 'clipassword', 'YmFzaWMtc2VjcmV0', 'client-secret-value', 'dbpassword', 'opaque-key-value', 'cookie-secret-value', 'xai-' + 'fixture'.repeat(8)];
  await put(root, 'codex-home/sessions/s.jsonl', [{ timestamp: from, tool: 'shell', input: {
    password: secrets[0], secretValue: 'opaque-key-value', providerApiKey: 'opaque-key-value', awsSecretAccessKey: 'opaque-key-value', clientSecret: 'client-secret-value', input_tokens: 123, nested: { access_token: secrets[1] },
    arguments: JSON.stringify({ private_key: '-----BEGIN PRIVATE KEY-----\nkeycontents\n-----END PRIVATE KEY-----', cmd: 'PASSWORD="shortpw"' }),
    db: 'postgresql://user:dbpassword@database',
    providerText: 'key ' + secrets.at(-1),
    providerModel: 'xai-grok-4-fast',
    argv: ['curl', '--password', 'clipassword', '--max_tokens', '4096'],
    labels: 'awsSecretAccessKey=opaque-key-value',
    query: 'https://example.com?token=shorttoken&public=true',
    cookie: 'cookie-secret-value',
    inline: `curl -d '{"client_secret":"client-secret-value","providerApiKey":"opaque-key-value"}'`,
    ordinary: 'basic checks pass',
    embedded: `curl -d '{"password":"jsonpassword"}' --password clipassword -H 'Authorization: Basic YmFzaWMtc2VjcmV0'`,
    cmd: `curl -H 'Authorization: Bearer shorttoken' https://user:urlpass@example.com ${secrets[2]} ${secrets[3]}`,
  }, result: 'é'.repeat(7000) }]);
  const { index, rows, out } = await run('collect-sessions.mjs', root, ['--part-bytes', '2048']);
  assert.ok(index.parts.length > 1);
  assert.ok(index.parts.every(p => p.bytes <= 2048));
  const restored = JSON.parse(Buffer.concat(rows.map(r => Buffer.from(r.data, 'base64'))).toString());
  assert.equal(restored.raw.tool, 'shell'); assert.equal(restored.raw.result, 'é'.repeat(7000));
  assert.equal(restored.raw.input.password, '[REDACTED]');
  assert.equal(restored.raw.input.input_tokens, 123);
  assert.equal(restored.raw.input.ordinary, 'basic checks pass');
  assert.equal(restored.raw.input.providerModel, 'xai-grok-4-fast');
  assert.deepEqual(restored.raw.input.argv, ['curl', '--password', '[REDACTED]', '--max_tokens', '4096']);
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

test('emitted records redact complete cookie and authorization headers', async t => {
  const root = await fixture(t);
  const url = 'https://github.com/o/r/pull/5';
  await put(root, 'codex-home/sessions/headers.jsonl', [{ timestamp: from, input: {
    headers: { Cookie: `theme=dark; sessionid=FAKE_SESSION_TOKEN; auth=FAKE_AUTH_TOKEN ${url}`,
      'Set-Cookie': ['sessionid=FAKE_SET_TOKEN; Path=/; HttpOnly', 'auth=FAKE_SET_AUTH; Secure'],
      Authorization: 'Digest username="FAKE_USER", nonce="FAKE_NONCE"; response="FAKE_RESPONSE"',
      'Proxy-Authorization': `Basic FAKE_PROXY_TOKEN ${url}` },
    raw: 'Cookie: theme="dark"; sessionid=FAKE_SESSION_TOKEN; auth=FAKE_AUTH_TOKEN\r\nSet-Cookie: theme=dark; auth=FAKE_SET_AUTH; Expires=Wed, 21 Oct 2026 07:28:00 GMT\r\nAuthorization: Digest username="FAKE_USER", nonce="FAKE_NONCE"; response="FAKE_RESPONSE"\r\nX-Public: visible',
    command: "curl -H 'Cookie: theme=dark; sessionid=FAKE_SESSION_TOKEN; auth=FAKE_AUTH_TOKEN'",
    json: '{"Cookie":"theme=dark; sessionid=FAKE_SESSION_TOKEN; auth=FAKE_AUTH_TOKEN","public":"visible"}',
    assigned: 'TOKEN="FAKE_SESSION_TOKEN;FAKE_AUTH_TOKEN" PASSWORD="FAKE_USER,FAKE_NONCE"',
  } }]);
  const { rows, index, out } = await run('collect-sessions.mjs', root);
  assert.deepEqual(rows[0].raw.input.headers, { Cookie: '[REDACTED]', 'Set-Cookie': '[REDACTED]', Authorization: '[REDACTED]', 'Proxy-Authorization': '[REDACTED]' });
  assert.deepEqual(index.prs, { 'o/r#5': [{ machine: 'fixture', sessionId: 'headers' }] });
  assert.equal(rows[0].raw.input.raw, '[REDACTED: credential]');
  assert.equal(rows[0].raw.input.json, '[REDACTED: credential]');
  const emitted = JSON.stringify(rows) + await readFile(join(out, 'index.json'), 'utf8');
  for (const secret of ['FAKE_SESSION_TOKEN', 'FAKE_AUTH_TOKEN', 'FAKE_SET_TOKEN', 'FAKE_SET_AUTH', 'FAKE_USER', 'FAKE_NONCE', 'FAKE_RESPONSE', 'FAKE_PROXY_TOKEN']) assert.ok(!emitted.includes(secret), secret);
});

test('folded headers redact every continuation through emitted records', async t => {
  const root = await fixture(t);
  const url = 'https://github.com/o/r/pull/6';
  const headers = `Cookie: a=1; ${url}\r\n session=FOLDED_COOKIE;\r\n\tauth=FOLDED_AUTH\r\nAuthorization: Digest\r\n nonce=FOLDED_NONCE\r\n\tresponse=FOLDED_RESPONSE\r\nSet-Cookie: a=1;\n session=FOLDED_SET\nProxy-Authorization: Basic\n\tFOLDED_PROXY\nX-Public: visible`;
  await put(root, 'codex-home/sessions/folded.jsonl', [{ timestamp: from, result: headers }]);
  const { rows, index, out } = await run('collect-sessions.mjs', root);
  assert.deepEqual(index.prs, { 'o/r#6': [{ machine: 'fixture', sessionId: 'folded' }] });
  const emitted = JSON.stringify(rows) + await readFile(join(out, 'index.json'), 'utf8');
  for (const secret of ['FOLDED_COOKIE', 'FOLDED_AUTH', 'FOLDED_NONCE', 'FOLDED_RESPONSE', 'FOLDED_SET', 'FOLDED_PROXY']) assert.ok(!emitted.includes(secret), secret);
  assert.equal(rows[0].raw.result, '[REDACTED: credential]');
});

test('header redaction consumes the field while PR discovery uses the original record', async t => {
  const url = 'https://github.com/o/r/pull/7';
  const cases = [
    ['concatenated quoted segments', `curl -H 'Cookie: a=1'"; s=INLINE_COOKIE" ${url}`],
    ['ANSI-C quoted header', `curl -H $'Cookie: a=1; s=INLINE_COOKIE' ${url}`],
    ['double quotes', `curl -H "aUtHoRiZaTiOn: Digest nonce=INLINE_AUTH; response=INLINE_RESPONSE" ${url}`],
    ['single quotes', `curl -H 'Cookie: a=1; s=INLINE_COOKIE' ${url} --fail`],
    ['long flag with equals', `curl --header="Authorization: Digest nonce=INLINE_AUTH; response=INLINE_RESPONSE" ${url}`],
    ['attached short flag', `curl -HCookie:INLINE_SHORT ${url}`],
    ['bare short flag', `curl -H Cookie:INLINE_BARE ${url}`],
    ['bare long flag', `curl --header Cookie:INLINE_LONG ${url}`],
    ['semicolon', `curl -H Cookie:INLINE_DELIMITED; gh pr view ${url}`],
    ['shell operator', `curl --header Cookie:INLINE_OPERATOR&&gh pr view ${url}`],
    ['header without a flag', `proxy-authorization: Basic INLINE_PROXY ${url}`],
    ['embedded JSON string', `curl -d '{"Cookie":"INLINE_JSON", "url":"${url}"}'`],
  ];
  for (const [name, command] of cases) await t.test(name, async t => {
    const root = await fixture(t);
    await put(root, 'codex-home/sessions/inline.jsonl', [{ timestamp: from, command }]);
    const { rows, index, out } = await run('collect-sessions.mjs', root);
    for (const part of index.parts) assert.ok(!(await readFile(join(out, part.file), 'utf8')).includes('INLINE_'));
    assert.deepEqual(index.prs, { 'o/r#7': [{ machine: 'fixture', sessionId: 'inline' }] });
    assert.equal(rows[0].raw.command, '[REDACTED: credential]');
    assert.ok(!(await readFile(join(out, 'index.json'), 'utf8')).includes('INLINE_'));
  });
});

test('record-size measurement emits only size statistics for the mtime window', async t => {
  const root = await fixture(t);
  const selected = join(root, '.t3/codex-home/sessions/sizes.jsonl');
  const old = join(root, '.t3/codex-home/sessions/old.jsonl');
  await writeFile(selected, '\n{}\r\nx\nabc');
  await writeFile(old, 'PRIVATE_CONTENT_MUST_NOT_APPEAR\n');
  await utimes(selected, new Date(from), new Date(from));
  await utimes(old, new Date('2026-10-01T00:00:00Z'), new Date('2026-10-01T00:00:00Z'));
  const { stdout } = await exec(process.execPath, [join(scripts, 'measure-record-sizes.mjs'), from, to, root]);
  const measured = JSON.parse(stdout);
  assert.equal(measured.providers.codex.files, 1);
  assert.equal(measured.providers.codex.bytes, 10);
  assert.equal(measured.combined.records, 3);
  assert.deepEqual(measured.combined.percentiles, { 50: 2, 90: 3, 95: 3, 99: 3, '99.9': 3, 100: 3 });
  assert.equal(measured.errors, 0);
  assert.ok(!stdout.includes('PRIVATE_CONTENT'));
});

test('oversized JSONL records leave byte receipts and collection continues under a small heap', async t => {
  const root = await fixture(t);
  const path = join(root, '.t3/codex-home/sessions/oversized.jsonl');
  const file = await open(path, 'w');
  const meta = JSON.stringify({ timestamp: to, type: 'session_meta', payload: { id: 'native-large' } }) + '\n';
  const prefix = JSON.stringify({ timestamp: to, text: '' }).slice(0, -2);
  const block = 'x'.repeat(64 * 1024);
  const selected = JSON.stringify({ timestamp: from, text: 'selected' }) + '\r\n';
  await file.writeFile(meta + prefix);
  for (let i = 0; i < 640; i++) await file.writeFile(block);
  await file.writeFile('"}\n' + selected);
  for (let i = 0; i < 17; i++) await file.writeFile(block);
  await file.close();
  const { index, rows } = await run('collect-sessions.mjs', root, ['--record-bytes', String(1024 ** 2)], 1, ['--max-old-space-size=24']);
  assert.deepEqual(rows.map(r => r.raw.text), ['selected']);
  assert.equal(index.sessions['native-large'].activity, 1);
  assert.equal(index.complete, false);
  assert.deepEqual(index.gapCounts, { 'oversized-jsonl': 2 });
  const size = Buffer.byteLength(prefix) + 40 * 1024 ** 2 + 2;
  assert.deepEqual(index.gaps.map(({ kind, provider, sessionId, line, offset, size, path }) => ({ kind, provider, sessionId, line, offset, size, path })), [
    { kind: 'oversized-jsonl', provider: 'codex', sessionId: 'native-large', line: 2, offset: Buffer.byteLength(meta), size, path },
    { kind: 'oversized-jsonl', provider: 'codex', sessionId: 'native-large', line: 4, offset: Buffer.byteLength(meta) + size + 1 + Buffer.byteLength(selected), size: 17 * 64 * 1024, path },
  ]);
});

test('record cap counts UTF-8 bytes, accepts the boundary with CRLF and resumes at EOF', async t => {
  const root = await fixture(t);
  const path = join(root, '.t3/claude-home/projects/p/boundary.jsonl');
  await mkdir(join(path, '..'), { recursive: true });
  const empty = JSON.stringify({ timestamp: from, text: '' });
  const padding = 1024 ** 2 - Buffer.byteLength(empty);
  const text = 'é'.repeat(Math.floor(padding / 2)) + 'x'.repeat(padding % 2);
  const accepted = JSON.stringify({ timestamp: from, text });
  assert.equal(Buffer.byteLength(accepted), 1024 ** 2);
  const oversized = JSON.stringify({ timestamp: from, text: text + 'x' });
  await writeFile(path, '\n' + accepted + '\r\n' + oversized + '\r\n' + JSON.stringify({ timestamp: from, text: 'final' }));
  const { index, rows } = await run('collect-sessions.mjs', root, ['--record-bytes', String(1024 ** 2)], 1);
  assert.deepEqual(rows.map(r => r.raw.text), [text, 'final']);
  assert.deepEqual(rows.map(r => r.line), [2, 4]);
  assert.deepEqual(index.gapCounts, { 'oversized-jsonl': 1 });
  assert.deepEqual(index.gaps, [{ kind: 'oversized-jsonl', provider: 'claude', sessionId: 'boundary', path, line: 3, offset: 1024 ** 2 + 3, size: 1024 ** 2 + 1, limit: 1024 ** 2 }]);
});

test('default record cap admits a 2 MiB tool result and receipts the next byte under a small heap', async t => {
  const root = await fixture(t);
  const path = join(root, '.t3/codex-home/sessions/default-cap.jsonl');
  const empty = JSON.stringify({ timestamp: from, result: '' });
  const result = 'x'.repeat(2 * 1024 ** 2 - Buffer.byteLength(empty));
  await writeFile(path, JSON.stringify({ timestamp: from, result }) + '\r\n' + JSON.stringify({ timestamp: from, result: result + 'x' }) + '\n' + JSON.stringify({ timestamp: from, result: 'after' }));
  const { rows, index } = await run('collect-sessions.mjs', root, [], 1, ['--max-old-space-size=24']);
  assert.deepEqual(rows.map(r => r.raw.result), [result, 'after']);
  assert.deepEqual(index.gapCounts, { 'oversized-jsonl': 1 });
  assert.equal(index.gaps[0].limit, 2 * 1024 ** 2);
  assert.equal(index.gaps[0].size, 2 * 1024 ** 2 + 1);
});

test('record cap rejects invalid flags before creating output', async t => {
  const root = await fixture(t);
  for (const value of ['0', '1023', '1.5', 'NaN', '1073741825']) {
    const out = join(root, `invalid-${value}`);
    await assert.rejects(exec(process.execPath, [join(scripts, 'collect-sessions.mjs'), '--out', out, '--from', from, '--to', to, '--record-bytes', value]), e => e.code === 1 && /--record-bytes/.test(e.stderr));
    await assert.rejects(stat(out), e => e.code === 'ENOENT');
  }
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
    turn_items: 'thread_id TEXT, run_id TEXT, payload_json TEXT', runs: 'thread_id TEXT, run_id TEXT, provider_thread_id TEXT, requested_at TEXT, completed_at TEXT, status TEXT, payload_json TEXT',
    run_attempts: 'thread_id TEXT, run_id TEXT, payload_json TEXT', nodes: 'thread_id TEXT, run_id TEXT, payload_json TEXT',
    subagents: 'thread_id TEXT, child_thread_id TEXT, run_id TEXT, payload_json TEXT', provider_threads: 'thread_id TEXT, provider_thread_id TEXT, payload_json TEXT',
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
  insert('runs', { thread_id: 'child', run_id: 'failed', provider_thread_id: 'pt-cursor', requested_at: from, completed_at: '2026-10-12T14:00:00Z', status: 'failed', payload_json: '{"status":"failed"}' });
  insert('runs', { thread_id: 'root', run_id: 'ongoing', requested_at: '2026-10-11T00:00:00Z', status: 'running', payload_json: '{"status":"running"}' });
  insert('runs', { thread_id: 'child', run_id: 'lower-edge', requested_at: '2026-10-11T00:00:00Z', completed_at: from, status: 'completed', payload_json: '{"status":"completed"}' });
  insert('runs', { thread_id: 'restart', run_id: 'upper-edge', requested_at: to, status: 'running', payload_json: '{"status":"running"}' });
  insert('run_attempts', { thread_id: 'child', run_id: 'failed', payload_json: '{"status":"failed","error":"provider failed"}' });
  insert('nodes', { thread_id: 'child', run_id: 'failed', payload_json: '{"status":"failed"}' });
  insert('turn_items', { thread_id: 'child', run_id: 'failed', payload_json: JSON.stringify({ type: 'error', startedAt: from, error: 'tool failed', token: 'dont-expose' }) });
  insert('provider_threads', { thread_id: 'child', provider_thread_id: 'pt-cursor', payload_json: '{"nativeThreadRef":{"nativeId":"native-child"},"driver":"cursor"}' });
  const taskCols = ['task_id','title','prompt','enabled','schedule_json','project_id','thread_id','workspace_strategy_json','model_selection_json','runtime_mode','interaction_mode','created_at','updated_at','next_run_at','last_run_at','last_run_status','last_run_error','run_count','webhook_secret','webhook_token'];
  db.exec(`CREATE TABLE scheduled_tasks (${taskCols.map(c => c + ' TEXT').join(',')})`);
  db.exec("INSERT INTO scheduled_tasks (task_id, title, prompt, schedule_json, webhook_secret, webhook_token) VALUES ('task', '[A] keep', 'PASSWORD=hidden', '{\"type\":\"interval\"}', 'webhook-secret-value', 'webhook-token-value')");
  db.close(); const before = await readFile(path);
  const { index, rows } = await run('collect-t3.mjs', root, ['--db', path]);
  assert.equal(index.counts.activeThreads, 3); assert.equal(index.counts.ancestorThreads, 1);
  assert.equal(index.counts.runs, 3); assert.equal(index.counts.attempts, 1);
  assert.ok(!rows.some(r => r.threadId === 'restart'));
  assert.equal(rows.find(r => r.raw.id === 'child').parentThreadId, 'middle');
  assert.equal(rows.find(r => r.raw.id === 'fork').parentThreadId, undefined);
  assert.equal(rows.find(r => r.runId === 'ongoing').kind, 'metadata');
  assert.equal(rows.find(r => r.runId === 'lower-edge').timestamp, from);
  assert.ok(rows.some(r => r.raw.error === 'provider failed'));
  assert.equal(index.nativeMappings[0].nativeThreadRef.nativeId, 'native-child');
  assert.equal(index.nativeMappings[0].activeInWindow, true);
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

test('GitHub CLI paginates reviews, threads, nested comments, checks and statuses with provenance', async t => {
  const root = await fixture(t); const bin = join(root, 'bin'); await mkdir(bin);
  const mock = `#!/usr/bin/env node
import{appendFileSync}from'node:fs';
const args=process.argv.slice(2);appendFileSync(process.env.GH_TRACE,JSON.stringify(args)+'\\n');
const endpoint=args[1];const field=n=>args.find(x=>x.startsWith(n+'='))?.slice(n.length+1);
let result;
if(endpoint==='graphql'){
  if(process.env.GH_FAILURE){console.log(JSON.stringify({errors:[{message:'denied'}]}));process.exit(0);}
  const c=id=>({id,isResolved:true,comments:{nodes:[{id:'first-'+id,body:'comment'}],pageInfo:{hasNextPage:true,endCursor:'comments-'+id}}});
  if(field('id'))result={data:{node:{comments:{nodes:[{id:'last-'+field('id'),body:'last'}],pageInfo:{hasNextPage:false,endCursor:null}}}}};
  else result={data:{repository:{pullRequest:{reviewThreads:{nodes:[c(field('cursor')?'thread2':'thread1')],pageInfo:{hasNextPage:!field('cursor'),endCursor:field('cursor')?null:'next-thread'}}}}}};
}else if(/\\/pulls\\/12$/.test(endpoint))result={head:{sha:'abc'},body:'pull body'};
else {const page=endpoint.includes('page=2')?2:1;const data=Array.from({length:page===1?100:1},(_,i)=>({id:page*100+i,state:'APPROVED'}));result=endpoint.includes('check-runs')?{check_runs:data,total_count:101}:data;}
console.log(JSON.stringify(result));
`;
  await writeFile(join(bin, 'gh'), mock, { mode: 0o700 });
  const input = join(root, 'input.json');
  await writeFile(input, JSON.stringify({ version: 1, complete: true, prs: { 'a/b#12': [{ machine: 'pc', sessionId: 's' }, { machine: 'mbp', sessionId: 's2' }] } }));
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, GH_TRACE: join(root, 'trace') };
  const out = join(root, 'prs');
  await exec(process.execPath, [join(scripts, 'collect-prs.mjs'), '--out', out, '--machine', 'fixture', '--indexes', input, '--urls', 'https://github.com/A/B/pull/12'], { env });
  const index = JSON.parse(await readFile(join(out, 'index.json'), 'utf8'));
  assert.deepEqual(index.completedPrs, ['https://github.com/a/b/pull/12']);
  const records = (await readFile(join(out, index.parts[0].file), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 11);
  assert.equal(records.filter(r => r.kind === 'reviews').flatMap(r => r.raw).length, 101);
  assert.deepEqual(records.filter(r => r.kind === 'review-comments').map(r => r.reviewThreadId), ['thread1', 'thread2']);
  assert.equal(records[0].provenance.length, 3);
  const trace = (await readFile(env.GH_TRACE, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(trace.filter(a => /\/pulls\/12$/.test(a[1])).length, 1);
  assert.ok(trace.some(a => a.includes('cursor=next-thread')));
  for (const id of ['thread1','thread2']) assert.ok(trace.some(a => a.includes('id='+id) && a.includes('commentCursor=comments-'+id)));
  const failed = join(root, 'failed');
  await assert.rejects(exec(process.execPath, [join(scripts, 'collect-prs.mjs'), '--out', failed, '--urls', 'https://github.com/a/b/pull/12'], { env: { ...env, GH_FAILURE: '1' } }), e => e.code === 1);
  const partial = JSON.parse(await readFile(join(failed, 'index.json'), 'utf8'));
  assert.equal(partial.gaps[0].kind, 'partial-pr');
  assert.match(partial.gaps[0].message, /denied/);
  assert.deepEqual(partial.completedPrs, []);
  assert.ok(partial.records > 0);
});


test('Cursor sessions use matching complete T3 timelines even without recent chat metadata', async t => {
  const root = await fixture(t);
  await put(root, 'cursor-home/chats/p/conversation/meta.json', { hasConversation: true, updatedAtMs: Date.parse(from) });
  const index = join(root, 't3.json');
  await writeFile(index, JSON.stringify({ source: 't3', machine: 'fixture', from, to, complete: true,
    nativeMappings: [{ driver: 'cursor', activeInWindow: true, threadId: 't1', nativeThreadRef: { nativeId: 'conversation' } }, { driver: 'cursor', activeInWindow: true, threadId: 't2', nativeThreadRef: { nativeId: 'acp' } }, { driver: 'cursor', activeInWindow: false, threadId: 't1', nativeThreadRef: { nativeId: 'old-handoff' } }],
    sessions: { t1: { activity: 3 }, t2: { activity: 7 } },
  }));
  const result = await run('collect-sessions.mjs', root, ['--t3-index', index]);
  assert.equal(result.index.sources.cursor.timelines, 2);
  assert.equal(result.index.sessions.conversation.timelineActivity, 3);
  assert.equal(result.index.sessions.acp.timelineActivity, 7);
  assert.equal(result.index.sessions['old-handoff'], undefined);
  const wrong = JSON.parse(await readFile(index, 'utf8')); wrong.machine = 'other';
  await writeFile(index, JSON.stringify(wrong));
  const failed = await run('collect-sessions.mjs', root, ['--t3-index', index], 1);
  assert.match(failed.index.gaps[0].message, /match this machine and window/);
});

test('gap samples stay bounded and an existing output cannot acquire stale parts', async t => {
  const root = await fixture(t);
  await writeFile(join(root, '.t3/codex-home/sessions/missing.jsonl'), '{"timestamp":{}}\n'.repeat(501));
  await put(root, 'claude-home/projects/p/prototype.jsonl', [{ sessionId: '__proto__', timestamp: from, text: 'selected' }]);
  const { index, out, stdout } = await run('collect-sessions.mjs', root, [], 1);
  assert.equal(JSON.parse(stdout).gaps, 501);
  assert.equal(index.sessions.__proto__.activity, 1);
  assert.equal(index.gaps.length, 200);
  assert.equal(index.gapCounts['missing-timestamp'], 501);
  const before = await readFile(join(out, 'index.json'));
  await assert.rejects(exec(process.execPath, [join(scripts, 'collect-sessions.mjs'), '--home', root, '--out', out, '--from', from, '--to', to]), e => e.code === 1);
  assert.deepEqual(await readFile(join(out, 'index.json')), before);
});


test('large alphanumeric tool results finish without truncation or credential leakage', async t => {
  const root = await fixture(t);
  await put(root, 'codex-home/sessions/ascii.jsonl', [{ timestamp: from, result: 'a'.repeat(512 * 1024), database: 'postgresql://user:dbpassword@database', customUrl: 'a+'.repeat(100) + 'custom://user:longpassword@host', serviceUrl: 'custom://user:opaquevalue@host', note: 'visible ghp_abcdefghijk text' }]);
  const { rows } = await run('collect-sessions.mjs', root);
  assert.equal(rows[0].raw.result, 'a'.repeat(512 * 1024));
  assert.equal(rows[0].raw.database, '[REDACTED: credential]');
  assert.equal(rows[0].raw.customUrl, '[REDACTED: credential]');
  assert.equal(rows[0].raw.serviceUrl, '[REDACTED: credential]');
  assert.equal(rows[0].raw.note, '[REDACTED: credential]');
});
