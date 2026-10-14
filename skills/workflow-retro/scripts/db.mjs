import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
export const prefix = 'orchestration_v2_projection_';
export function connect(opts, tables) {
  const path = opts.db || join(opts.home, '.t3/userdata/statev2.sqlite');
  const db = new DatabaseSync(`file:${path}?mode=ro`, { readOnly: true });
  try {
    db.exec('PRAGMA query_only=ON; BEGIN');
    for (const [table, required] of Object.entries(tables)) {
      const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name));
      for (const column of required) if (!columns.has(column)) throw new Error(`Missing ${table}.${column}`);
    }
    return db;
  } catch (e) { db.close(); throw e; }
}
export function payload(row, out, table) {
  try { return JSON.parse(row.payload_json); }
  catch { out.gap('invalid-database-payload', { table, rowId: row.row_id }); return null; }
}
export function* rows(db, table) { yield* db.prepare(`SELECT rowid AS row_id, * FROM ${prefix}${table}`).iterate(); }
