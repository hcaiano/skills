import { inside, instant, main } from './io.mjs';
import { connect, payload, prefix, rows } from './db.mjs';

await main('t3', true, async (opts, out) => {
  const required = {
    threads: ['thread_id', 'payload_json'], messages: ['thread_id', 'created_at', 'payload_json'],
    turn_items: ['thread_id', 'run_id', 'payload_json'], runs: ['run_id', 'thread_id', 'requested_at', 'completed_at', 'status', 'payload_json'],
    run_attempts: ['run_id', 'thread_id', 'payload_json'], nodes: ['run_id', 'thread_id', 'payload_json'],
    subagents: ['thread_id', 'child_thread_id', 'payload_json'], provider_threads: ['thread_id', 'payload_json'],
  };
  const db = connect(opts, Object.fromEntries(Object.entries(required).map(([t, cols]) => [prefix + t, cols])));
  const active = new Set(), runIds = new Set(), activeProviders = new Set(), parents = new Map();
  const counts = out.index.counts = { messages: 0, items: 0, runs: 0, attempts: 0, activeThreads: 0, ancestorThreads: 0 };
  async function emit(table, row, raw, kind, timestamp) {
    await out.emit({ threadId: row.thread_id, runId: row.run_id, rowId: row.row_id, table: prefix + table, kind, timestamp, raw });
  }
  try {
    for (const row of rows(db, 'subagents')) {
      if (!row.child_thread_id) continue;
      if (parents.has(row.child_thread_id) && parents.get(row.child_thread_id) !== row.thread_id) out.gap('multiple-parents', { threadId: row.child_thread_id });
      parents.set(row.child_thread_id, row.thread_id);
    }
    for (const table of ['messages', 'turn_items']) {
      for (const row of rows(db, table)) {
        const raw = payload(row, out, table); if (!raw) continue;
        const times = table === 'messages' ? [row.created_at] : [raw.startedAt, raw.completedAt, raw.updatedAt];
        if (!times.some(v => Number.isFinite(instant(v)))) { out.gap('missing-database-timestamp', { table, rowId: row.row_id }); continue; }
        const timestamp = times.find(v => inside(v, opts));
        if (!timestamp) continue;
        active.add(row.thread_id);
        if (row.provider_thread_id || raw.providerThreadId) activeProviders.add(row.provider_thread_id || raw.providerThreadId);
        if (row.run_id) runIds.add(row.run_id);
        counts[table === 'messages' ? 'messages' : 'items']++;
        await emit(table, row, raw, 'activity', timestamp);
      }
    }
    for (const row of rows(db, 'runs')) {
      const raw = payload(row, out, 'runs'); if (!raw) continue;
      const start = instant(row.requested_at), end = instant(row.completed_at);
      if (!Number.isFinite(start)) { out.gap('missing-run-timestamp', { runId: row.run_id }); continue; }
      const ongoing = !row.completed_at && !['completed', 'failed', 'cancelled', 'interrupted'].includes(row.status);
      const timestamp = [row.requested_at, raw.startedAt, row.completed_at].find(v => inside(v, opts));
      if (!timestamp && !(start < opts.end && (end > opts.start || ongoing)) && !runIds.has(row.run_id)) continue;
      active.add(row.thread_id); runIds.add(row.run_id); counts.runs++;
      if (row.provider_thread_id || raw.providerThreadId) activeProviders.add(row.provider_thread_id || raw.providerThreadId);
      await emit('runs', row, raw, timestamp ? 'activity' : 'metadata', timestamp);
    }
    counts.activeThreads = active.size;
    const selected = new Set(active);
    for (const threadId of active) {
      const visited = new Set([threadId]); let current = threadId;
      while (parents.has(current)) {
        current = parents.get(current);
        if (visited.has(current)) { out.gap('cyclic-lineage', { threadId }); break; }
        visited.add(current); selected.add(current);
      }
    }
    counts.ancestorThreads = selected.size - active.size;
    const seen = new Set();
    for (const row of rows(db, 'threads')) {
      if (!selected.has(row.thread_id)) continue;
      const raw = payload(row, out, 'threads'); if (!raw) continue;
      seen.add(row.thread_id);
      await out.emit({ threadId: row.thread_id, parentThreadId: parents.get(row.thread_id), table: prefix + 'threads', rowId: row.row_id, kind: 'metadata', discoverPr: active.has(row.thread_id), ancestor: !active.has(row.thread_id), raw });
    }
    for (const threadId of selected) if (!seen.has(threadId)) out.gap('unresolved-thread', { threadId });
    out.index.nativeMappings = [];
    for (const row of rows(db, 'provider_threads')) {
      if (!selected.has(row.thread_id)) continue;
      const raw = payload(row, out, 'provider_threads'); if (!raw) continue;
      out.index.nativeMappings.push({ threadId: row.thread_id, parentThreadId: parents.get(row.thread_id), nativeThreadRef: raw.nativeThreadRef, providerSessionId: raw.providerSessionId, driver: raw.driver, activeInWindow: activeProviders.has(row.provider_thread_id || raw.id) });
      await emit('provider_threads', row, raw, 'metadata');
    }
    for (const table of ['run_attempts', 'nodes', 'subagents', 'turn_items']) {
      for (const row of rows(db, table)) {
        if (!runIds.has(row.run_id)) continue;
        const raw = payload(row, out, table); if (!raw) continue;
        if (table === 'turn_items' && [raw.startedAt, raw.completedAt, raw.updatedAt].some(v => inside(v, opts))) continue;
        if (table === 'run_attempts') counts.attempts++;
        await emit(table, row, raw, 'metadata');
      }
    }
    db.exec('COMMIT');
  } finally { db.close(); }
});
