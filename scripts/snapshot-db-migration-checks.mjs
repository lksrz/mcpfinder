import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

export async function runSnapshotDbMigrationChecks(dir) {
  const path = join(dir, 'legacy-sync-log.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE sync_log (
    source TEXT PRIMARY KEY, last_synced_at TEXT NOT NULL,
    server_count INTEGER DEFAULT 0, status TEXT DEFAULT 'ok', error TEXT
  )`);
  legacy.prepare('INSERT INTO sync_log VALUES (?, ?, ?, ?, ?)')
    .run('official', '2026-01-01T00:00:00.000Z', 10, 'ok', null);
  legacy.prepare('INSERT INTO sync_log VALUES (?, ?, ?, ?, ?)')
    .run('glama', '2026-01-02T00:00:00.000Z', 0, 'error', 'failed');
  legacy.close();

  const { initDatabase } = await import('../packages/core/dist/index.js');
  const migrated = initDatabase(path);
  const columns = migrated.prepare("PRAGMA table_info('sync_log')").all();
  assert.ok(columns.some((column) => column.name === 'last_successful_at'));
  assert.equal(
    migrated.prepare("SELECT last_successful_at FROM sync_log WHERE source = 'official'").get()
      .last_successful_at,
    '2026-01-01T00:00:00.000Z',
  );
  assert.equal(
    migrated.prepare("SELECT last_successful_at FROM sync_log WHERE source = 'glama'").get()
      .last_successful_at,
    null,
  );
  migrated.close();
}
