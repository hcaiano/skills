import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function instant(value) {
  if (!['string', 'number'].includes(typeof value) || value === '') return NaN;
  const n = typeof value === 'number' ? value : /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  return Number.isFinite(n) ? (n < 1e11 ? n * 1000 : n) : Date.parse(value);
}

export function options(window = true) {
  const opts = { home: homedir(), machine: process.platform === 'darwin' ? 'mbp' : 'pc', 'part-bytes': 50 * 1024 ** 2, 'record-bytes': 2 * 1024 ** 2 };
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!/^--[a-z][a-z0-9-]*$/.test(process.argv[i]) || !process.argv[i + 1]) throw new Error('Expected --name value arguments');
    opts[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  if (!opts.out) throw new Error('--out is required; use a new directory');
  opts.limit = Number(opts['part-bytes']);
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1024) throw new Error('--part-bytes must be at least 1024');
  opts.recordLimit = Number(opts['record-bytes']);
  if (!Number.isSafeInteger(opts.recordLimit) || opts.recordLimit < 1024 || opts.recordLimit > 1024 ** 3) throw new Error('--record-bytes must be an integer between 1024 and 1073741824');
  if (window) {
    if (![opts.from, opts.to].every(v => typeof v === 'string' && /Z$/.test(v))) throw new Error('--from and --to must be UTC timestamps');
    opts.start = instant(opts.from); opts.end = instant(opts.to);
    if (!Number.isFinite(opts.start) || !(opts.start < opts.end)) throw new Error('Invalid window');
  }
  return opts;
}
export const inside = (value, opts) => instant(value) >= opts.start && instant(value) < opts.end;
const names = '(?:api[ _-]?key|private[ _-]?key|access[_-]?key(?:[_-]?id)?|secret[_-]?key|token|password|passwd|passphrase|secret|cookie|authorization|bearer|credential)(?:s|[_-]?(?:value|hash|digest))?';
const indicator = new RegExp(`${names}|(?:^|[\\s"'=])-[pP]`, 'i');
const label = new RegExp(`^(?:[A-Za-z0-9_.-]*${names}|-[pP])$`, 'i');
const flag = /^(?:--[\w-]+|-[pP])$/;
const assignment = new RegExp(`${names}["']?\\s*[:=]\\s*["']?\\s*[^\\s"'\x60;,}\\]]`, 'i');
const strongIndicators = [
  /\b(?:Cookie|Set-Cookie|Authorization|Proxy-Authorization)["']?\s*:/i,
  /\bBearer\s+[^\s"']+/i,
  assignment,
  /(?:^|[\s"'`])--(?:password|passwd|passphrase|token|api[-_]?key|secret|access-token|refresh-token|client-secret)(?:=|\s+)\s*["']?\s*[^\s"'`;,]/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{8,}|xai-[A-Za-z0-9_-]{32,}|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|xox[baprs]-[A-Za-z0-9-]+|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
  /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^@\s]+@/i,
];
const passwordClient = /\b(?:mysql(?:dump|admin|check|import|show|slap)?|mariadb(?:-dump|-admin|-check|-import|-show|-slap)?)\b/i;
const shortPassword = /(?:^|[\s"'`])-p\s*["']?\s*[^\s"'`;,=-]/;
function credential(key, value) {
  if (typeof key !== 'string') return false;
  const counter = /tokens$/i.test(key) && (typeof value === 'number' || typeof value === 'string' && /^["']?-?\d+(?:\.\d+)?["']?$/.test(value));
  return indicator.test(key) && !counter;
}
export function redact(value) {
  if (Array.isArray(value)) {
    if (value.length === 2 && typeof value[0] === 'string' && label.test(value[0]) && credential(value[0], value[1])) return [value[0], '[REDACTED]'];
    return value.map((v, i) => {
      if (flag.test(value[i - 1]) && credential(value[i - 1], v)) return '[REDACTED]';
      if (typeof v === 'string' && flag.test(v)) return v;
      return redact(v);
    });
  }
  if (value && typeof value === 'object') {
    const named = typeof value.name === 'string' && label.test(value.name) && credential(value.name, value.value);
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k,
      credential(k, v) || named && k === 'value' ? '[REDACTED]' : named && k === 'name' ? v : redact(v),
    ]));
  }
  if (typeof value !== 'string') return value;
  if (strongIndicators.some(pattern => pattern.test(value)) || passwordClient.test(value) && shortPassword.test(value)) return '[REDACTED: credential]';
  if (/^[\[{]/.test(value.trim())) {
    try { return JSON.stringify(redact(JSON.parse(value))); } catch { /* Plain tool output can start with a brace. */ }
  }
  return value;
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
export async function* jsonl(path, receipt, session) {
  const limit = receipt.opts.recordLimit;
  const buffer = Buffer.allocUnsafe(limit + 1);
  let line = 1, offset = 0, size = 0, lastByte = 0;
  const input = createReadStream(path);
  function record() {
    const bytes = size - (lastByte === 13 ? 1 : 0);
    if (bytes > limit) {
      receipt.gap('oversized-jsonl', { ...session(), path, line, offset, size: bytes, limit });
      return;
    }
    const text = buffer.subarray(0, bytes).toString('utf8');
    if (!text.trim()) return;
    try { return { raw: JSON.parse(text), line }; }
    catch { receipt.gap('malformed-jsonl', { path, line }); }
  }
  try {
    for await (const chunk of input) {
      let start = 0;
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start);
        const end = newline === -1 ? chunk.length : newline;
        const length = end - start;
        if (size < buffer.length) chunk.copy(buffer, size, start, start + Math.min(length, buffer.length - size));
        size += length;
        if (length) lastByte = chunk[end - 1];
        if (newline === -1) break;
        const parsed = record();
        if (parsed) yield parsed;
        offset += size + 1; line++; size = 0; lastByte = 0;
        start = end + 1;
      }
    }
    if (size) { const parsed = record(); if (parsed) yield parsed; }
  } catch (e) { receipt.gap('unreadable-file', { path, code: e.code }); }
  finally { input.destroy(); }
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
    if (record.kind !== 'context' && (record.kind !== 'metadata' || record.discoverPr)) {
      const key = redact(record.sessionId || record.threadId || record.prUrl || this.source);
      for (const match of JSON.stringify(record).matchAll(/https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)(?=$|[/?#\s"'\\<>,;)\]}])/g)) {
        const id = `${match[1]}/${match[2]}#${match[3].replace(/^0+(?=\d)/, '')}`;
        if (redact(id) !== id) continue;
        const refs = this.index.prs[id] ||= [];
        if (!refs.some(r => r.sessionId === key)) refs.push({ machine: this.opts.machine, sessionId: key });
      }
    }
    const safe = redact({ machine: this.opts.machine, source: this.source, ...record });
    const key = safe.sessionId || safe.threadId || safe.prUrl || this.source;
    const count = this.index.sessions[key] ||= { activity: 0, context: 0 };
    if (safe.provider) count.provider = safe.provider;
    count[safe.kind === 'context' || safe.kind === 'metadata' ? 'context' : 'activity']++;
    if (safe.parentSessionId) count.parentSessionId = safe.parentSessionId;
    if (safe.parentThreadId) count.parentThreadId = safe.parentThreadId;
    const encoded = JSON.stringify(safe);
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
    const gaps = Object.values(this.index.gapCounts).reduce((sum, count) => sum + count, 0);
    this.index.complete = gaps === 0;
    await writeFile(join(this.opts.out, 'index.json'), JSON.stringify(redact(this.index), null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ out: this.opts.out, records: this.index.records, sessions: Object.keys(this.index.sessions).length, gaps, complete: this.index.complete }));
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
