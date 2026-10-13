import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function instant(value) {
  if (!['string', 'number'].includes(typeof value) || value === '') return NaN;
  const n = typeof value === 'number' ? value : /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : Date.parse(value);
}

export function options(window = true) {
  const opts = { home: homedir(), machine: process.platform === 'darwin' ? 'mbp' : 'pc', 'part-bytes': 50 * 1024 ** 2 };
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!/^--[a-z][a-z0-9-]*$/.test(process.argv[i]) || !process.argv[i + 1]) throw new Error('Expected --name value arguments');
    opts[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  if (!opts.out) throw new Error('--out is required; use a new directory');
  opts.limit = Number(opts['part-bytes']);
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1024) throw new Error('--part-bytes must be at least 1024');
  if (window) {
    if (![opts.from, opts.to].every(v => typeof v === 'string' && /Z$/.test(v))) throw new Error('--from and --to must be UTC timestamps');
    opts.start = instant(opts.from); opts.end = instant(opts.to);
    if (!Number.isFinite(opts.start) || !(opts.start < opts.end)) throw new Error('Invalid window');
  }
  return opts;
}
export const inside = (value, opts) => instant(value) >= opts.start && instant(value) < opts.end;
const sensitive = /^(?:.*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|(?:client|webhook|signing)?[_-]?secret|authorization|private[_-]?key|credential)s?$/i;
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sensitive.test(k) && !(typeof v === 'number' && /tokens$/i.test(k)) ? '[REDACTED]' : redact(v)]));
  if (typeof value !== 'string') return value;
  if (/^[\[{]/.test(value.trim())) {
    try { return JSON.stringify(redact(JSON.parse(value))); } catch { /* Plain tool output can start with a brace. */ }
  }
  return value
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s"'\\,;]+/gi, 'Bearer [REDACTED]')
    .replace(/(\bAuthorization["']?\s*:\s*["']?Basic\s+)[^\s"'\\,;]+/gi, '$1[REDACTED]')
    .replace(/(["'](?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|credential)["']\s*:\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;}]+)/gi, '$1"[REDACTED]"')
    .replace(/(--(?:api-key|token|password|secret)(?:=|\s+))(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1[REDACTED]')
    .replace(/\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/(\b(?:[\w-]*[_-])?(?:api[_-]?key|token|password|passwd|secret|credential)s?\b\s*[=:]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^@\s]+@/gi, '$1[REDACTED]@');
}
export async function* files(root, receipt) {
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (e) { receipt.gap('unreadable-directory', { path: root, code: e.code }); return; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* files(path, receipt);
    else if (entry.isFile()) yield path;
  }
}
export async function* jsonl(path, receipt) {
  let line = 0;
  const input = createReadStream(path);
  const reader = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const text of reader) {
      line++;
      if (!text.trim()) continue;
      try { yield { raw: JSON.parse(text), line }; }
      catch { receipt.gap('malformed-jsonl', { path, line }); }
    }
  } catch (e) { receipt.gap('unreadable-file', { path, code: e.code }); }
  finally { reader.close(); input.destroy(); }
}
export async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
export async function candidate(path, opts, receipt) {
  try { return (await stat(path)).mtimeMs >= opts.start; }
  catch (e) { receipt.gap('unreadable-file', { path, code: e.code }); return false; }
}

export class Output {
  constructor(opts, source) {
    this.opts = opts; this.source = source; this.handle = null;
    this.index = { version: 1, machine: opts.machine, source, from: opts.from, to: opts.to, complete: false, records: 0, parts: [], sessions: Object.create(null), prs: Object.create(null), sources: Object.create(null), gapCounts: Object.create(null), gaps: [] };
  }
  async start() { await mkdir(this.opts.out, { mode: 0o700 }); }
  gap(kind, detail = {}) {
    this.index.gapCounts[kind] = (this.index.gapCounts[kind] || 0) + 1;
    if (this.index.gaps.length < 200) this.index.gaps.push(redact({ kind, ...detail }));
  }
  async line(record) {
    const data = JSON.stringify(record) + '\n';
    const bytes = Buffer.byteLength(data);
    if (bytes > this.opts.limit) throw new Error('Fragment exceeds part limit');
    let part = this.index.parts.at(-1);
    if (!part || part.bytes + bytes > this.opts.limit) {
      if (this.handle) await this.handle.close();
      part = { file: `part-${String(this.index.parts.length + 1).padStart(4, '0')}.jsonl`, bytes: 0, records: 0 };
      this.index.parts.push(part);
      this.handle = await open(join(this.opts.out, part.file), 'wx', 0o600);
    }
    await this.handle.writeFile(data);
    part.bytes += bytes; part.records++;
  }
  async emit(record) {
    const safe = redact({ machine: this.opts.machine, source: this.source, ...record });
    const key = safe.sessionId || safe.threadId || safe.prUrl || this.source;
    const count = this.index.sessions[key] ||= { activity: 0, context: 0 };
    if (safe.provider) count.provider = safe.provider;
    count[safe.kind === 'context' || safe.kind === 'metadata' ? 'context' : 'activity']++;
    if (safe.parentSessionId) count.parentSessionId = safe.parentSessionId;
    if (safe.parentThreadId) count.parentThreadId = safe.parentThreadId;
    const encoded = JSON.stringify(safe);
    if (safe.kind !== 'context' && (safe.kind !== 'metadata' || safe.discoverPr)) {
      for (const match of encoded.matchAll(/https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)\b/g)) {
        const url = `https://github.com/${match[1]}/${match[2]}/pull/${Number(match[3])}`;
        const refs = this.index.prs[url] ||= [];
        if (!refs.some(r => r.sessionId === key)) refs.push({ machine: this.opts.machine, sessionId: key });
      }
    }
    this.index.records++;
    if (Buffer.byteLength(encoded) + 1 <= this.opts.limit) return this.line(safe);
    const bytes = Buffer.from(encoded); const size = Math.floor((this.opts.limit - 512) * 3 / 4);
    const recordId = randomUUID(); const total = Math.ceil(bytes.length / size);
    for (let offset = 0, fragment = 0; offset < bytes.length; offset += size, fragment++) {
      await this.line({ machine: this.opts.machine, source: this.source, kind: 'fragment', recordId, fragment, total, encoding: 'base64', data: bytes.subarray(offset, offset + size).toString('base64') });
    }
  }
  async finish() {
    if (this.handle) { await this.handle.close(); this.handle = null; }
    this.index.complete = this.index.gaps.length === 0;
    await writeFile(join(this.opts.out, 'index.json'), JSON.stringify(redact(this.index), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ out: this.opts.out, records: this.index.records, sessions: Object.keys(this.index.sessions).length, gaps: this.index.gaps.length, complete: this.index.complete }));
    if (!this.index.complete) process.exitCode = 1;
  }
}
export async function main(source, window, action) {
  let output;
  try {
    const opts = options(window); output = new Output(opts, source); await output.start();
    try { await action(opts, output); }
    catch (e) { output.gap('collection-failed', { message: e.message }); }
    await output.finish();
  } catch (e) { console.error(redact(e.message)); process.exitCode = 1; }
}
