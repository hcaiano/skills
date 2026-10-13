import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [from, to, home = homedir()] = process.argv.slice(2);
const start = Date.parse(from), end = Date.parse(to);
if (!/Z$/.test(from || '') || !/Z$/.test(to || '') || !Number.isFinite(start) || !(start < end)) {
  throw new Error('Usage: measure-record-sizes.mjs FROM_UTC TO_UTC [HOME]');
}
const caps = [1, 2, 4, 8, 16, 32].map(mib => mib * 1024 ** 2);
const combined = new Map();
let errors = 0;
async function* files(root) {
  try {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) yield* files(path);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
    }
  } catch { errors++; }
}
function summary(histogram) {
  const sizes = [...histogram.keys()].sort((a, b) => a - b);
  const records = [...histogram.values()].reduce((sum, count) => sum + count, 0);
  const percentiles = {};
  for (const p of [50, 90, 95, 99, 99.9, 100]) {
    let count = 0;
    percentiles[p] = sizes.find(size => (count += histogram.get(size)) >= Math.ceil(records * p / 100)) ?? 0;
  }
  return { records, percentiles, caps: caps.map(limit => {
    const above = sizes.reduce((sum, size) => sum + (size > limit ? histogram.get(size) : 0), 0);
    return { limit, above, retainedPercent: records ? 100 * (records - above) / records : 100 };
  }) };
}
const providers = {};
for (const [provider, relative] of [['codex', 'codex-home/sessions'], ['claude', 'claude-home/projects'], ['grok', 'grok-home/sessions']]) {
  const histogram = new Map();
  let selected = 0, bytes = 0;
  for await (const path of files(join(home, '.t3', relative))) {
    try {
      const info = await stat(path);
      if (info.mtimeMs < start || info.mtimeMs >= end) continue;
      selected++; bytes += info.size;
      if (!info.size) continue;
      let size = 0, lastByte = 0;
      const record = () => {
        const length = size - (lastByte === 13 ? 1 : 0);
        if (length > 0) {
          histogram.set(length, (histogram.get(length) || 0) + 1);
          combined.set(length, (combined.get(length) || 0) + 1);
        }
        size = 0; lastByte = 0;
      };
      for await (const chunk of createReadStream(path, { end: info.size - 1 })) {
        let offset = 0;
        while (offset < chunk.length) {
          const newline = chunk.indexOf(10, offset);
          const stop = newline === -1 ? chunk.length : newline;
          size += stop - offset;
          if (stop > offset) lastByte = chunk[stop - 1];
          if (newline === -1) break;
          record(); offset = newline + 1;
        }
      }
      if (size) record();
    } catch { errors++; }
  }
  providers[provider] = { files: selected, bytes, ...summary(histogram) };
}
console.log(JSON.stringify({ from, to, selection: 'All nonempty JSONL lines in files with mtime in [from, to), including context and older events; CRLF excluded. No content parsed or written.', providers, combined: summary(combined), errors }));
if (errors) process.exitCode = 1;
