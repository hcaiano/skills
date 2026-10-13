import { basename, dirname, join } from 'node:path';
import { access } from 'node:fs/promises';
import { candidate, files, inside, instant, json, jsonl, main } from './io.mjs';

await main('sessions', true, async (opts, out) => {
  const providers = [
    ['claude', 'claude-home/projects'], ['codex', 'codex-home/sessions'],
    ['grok', 'grok-home/sessions'], ['cursor', 'cursor-home/chats'],
  ];
  for (const [provider, relative] of providers) {
    const root = join(opts.home, '.t3', relative);
    try { await access(root); out.index.sources[provider] = { available: true, candidates: 0, probes: 0 }; }
    catch { out.index.sources[provider] = { available: false }; out.gap('missing-provider', { provider, path: root }); continue; }
    for await (const path of files(root, out)) {
      if (provider === 'cursor') {
        if (basename(path) !== 'meta.json' || !await candidate(path, opts, out)) continue;
        let meta;
        try { meta = await json(path); } catch { out.gap('invalid-cursor-meta', { path }); continue; }
        if (meta.hasConversation === false) { out.index.sources.cursor.probes++; continue; }
        if (meta.hasConversation !== true) { out.gap('unknown-cursor-meta', { path }); continue; }
        if (instant(meta.updatedAtMs) < opts.start) continue;
        const sessionId = basename(dirname(path));
        await out.emit({ provider, sessionId, path, kind: 'metadata', raw: meta });
        out.gap('cursor-timeline-required', { provider, sessionId, path, reason: 'store.db contains untimestamped blobs; recover timestamped events through T3 native mappings' });
        continue;
      }
      if (provider === 'grok' ? basename(path) !== 'updates.jsonl' : !path.endsWith('.jsonl')) continue;
      if (!await candidate(path, opts, out)) continue;
      out.index.sources[provider].candidates++;
      const parent = provider === 'claude' && path.includes('/subagents/') ? basename(dirname(dirname(path))) : null;
      let sessionId = provider === 'grok' ? basename(dirname(path)) : parent || basename(path, '.jsonl');
      let selected = false;
      for await (const { raw, line } of jsonl(path, out)) {
        if (!Number.isFinite(instant(raw.timestamp))) { out.gap('missing-timestamp', { provider, path, line }); continue; }
        if (!parent) sessionId = raw.sessionId || (raw.type === 'session_meta' && raw.payload?.id) || sessionId;
        if (!inside(raw.timestamp, opts)) continue;
        selected = true;
        await out.emit({ provider, sessionId, ...(parent ? { parentSessionId: parent, childSessionId: basename(path, '.jsonl') } : {}), path, line, timestamp: new Date(instant(raw.timestamp)).toISOString(), kind: 'activity', raw });
      }
      if (provider === 'grok' && selected) {
        const history = join(dirname(path), 'chat_history.jsonl');
        for await (const { raw, line } of jsonl(history, out)) await out.emit({ provider, sessionId, path: history, line, kind: 'context', raw });
      }
    }
  }
});
