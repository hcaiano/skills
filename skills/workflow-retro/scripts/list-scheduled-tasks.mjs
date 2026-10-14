import { main } from './io.mjs';
import { connect } from './db.mjs';
await main('scheduled-tasks', false, async (opts, out) => {
  const columns = ['task_id', 'title', 'prompt', 'enabled', 'schedule_json', 'project_id', 'thread_id', 'workspace_strategy_json', 'model_selection_json', 'runtime_mode', 'interaction_mode', 'created_at', 'updated_at', 'next_run_at', 'last_run_at', 'last_run_status', 'last_run_error', 'run_count'];
  const db = connect(opts, { scheduled_tasks: columns });
  try {
    for (const row of db.prepare(`SELECT ${columns.join(', ')} FROM scheduled_tasks`).iterate()) {
      const raw = Object.fromEntries(Object.entries(row).map(([k, v]) => [k, k.endsWith('_json') && v ? JSON.parse(v) : v]));
      await out.emit({ sessionId: row.task_id, threadId: row.thread_id, kind: 'task', raw });
    }
    db.exec('COMMIT');
  } finally { db.close(); }
});
