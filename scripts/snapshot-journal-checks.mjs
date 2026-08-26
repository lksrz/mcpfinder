/**
 * Journal (`-wal`/`-shm`) lifecycle around the versioned snapshot layout: the
 * sweep's unconditional refusal to touch a journal, the nominal name's
 * stranded-journal guard, pointer ordering for pre-versioning states, and WAL
 * truncation after a good sync.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const runtime = (fetchImpl, now = () => 0, sleep = async () => {}) => ({ fetchImpl, now, sleep });

function ageFile(path, hours) {
  const when = new Date(Date.now() - hours * 3_600_000);
  utimesSync(path, when, when);
}

export async function runSnapshotJournalChecks(root) {
  const {
    checkpointWal,
    closeDatabase,
    initDatabase,
    publishSnapshotState,
    resolveCurrentDbPath,
    sweepSnapshotFiles,
    syncOfficialRegistry,
    versionedDbPath,
    writeSnapshotState,
  } = await import('../packages/core/dist/index.js');

  /** A data dir of its own, so directory-wide sweeps stay isolated. */
  function scratch(name) {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return join(path, 'data.db');
  }

  // ─── Journals are never swept, at any age, orphaned or not ───────────────

  {
    const nominal = scratch('journal-never-swept');
    const currentSha = 'a'.repeat(64);
    const goneSha = 'b'.repeat(64);
    const current = versionedDbPath(nominal, currentSha);
    const superseded = versionedDbPath(nominal, goneSha);
    const orphanSha = 'c'.repeat(64);
    const orphan = versionedDbPath(nominal, orphanSha);

    writeFileSync(current, 'current');
    writeFileSync(`${current}-wal`, 'live-wal');
    writeFileSync(`${current}-shm`, 'live-shm');
    writeFileSync(superseded, 'superseded');
    writeFileSync(`${superseded}-wal`, 'still-owned-wal');
    writeFileSync(`${superseded}-shm`, 'still-owned-shm');
    // Database already reclaimed by an earlier sweep; only its journal remains.
    writeFileSync(`${orphan}-wal`, 'orphan-wal');
    writeFileSync(`${orphan}-shm`, 'orphan-shm');

    await writeSnapshotState(nominal, {
      dbFile: `data-${currentSha.slice(0, 16)}.db`,
      sha256: currentSha,
      publishedAt: '2026-08-26T00:00:00.000Z',
      installedAt: '2026-08-26T00:00:00.000Z',
      checkedAt: '2026-08-26T00:00:00.000Z',
    });

    // Absurdly old — a year past anything that was ever a grace period — so the
    // assertion below can only be explained by the rule, not by a window.
    const sidecars = [
      `${current}-wal`,
      `${current}-shm`,
      `${superseded}-wal`,
      `${superseded}-shm`,
      `${orphan}-wal`,
      `${orphan}-shm`,
    ];
    for (const path of [...sidecars, current, superseded]) ageFile(path, 24 * 365);

    // Two runs: the second one sees `superseded`'s journal as a fresh orphan,
    // which under the withdrawn rule would have made it a candidate.
    await sweepSnapshotFiles(nominal, { retainHours: 1 });
    const removed = await sweepSnapshotFiles(nominal, { retainHours: 1 });

    assert.equal(existsSync(superseded), false, 'the aged superseded database is reclaimed');
    for (const path of sidecars) {
      assert.ok(existsSync(path), `the sweep never removes a journal: ${path}`);
    }
    assert.deepEqual(
      removed.filter((name) => name.endsWith('-wal') || name.endsWith('-shm')),
      [],
      'and never reports one, orphaned or not',
    );
  }

  // ─── The nominal name gets the guard the versioned names have ─────────────

  {
    const nominal = scratch('journal-nominal-guard');
    // The footprint of a swept legacy data.db whose holder is still running.
    writeFileSync(`${nominal}-wal`, 'somebody-elses-journal');
    writeFileSync(`${nominal}-shm`, 'somebody-elses-shm');

    const resolved = resolveCurrentDbPath(nominal);
    assert.notEqual(resolved, nominal, 'a stranded journal makes the nominal name unusable');
    assert.match(
      resolved,
      /data-[0-9a-z]{6}\.db$/,
      'and the fallback is a variant of it, as at install time',
    );
    assert.equal(
      resolveCurrentDbPath(nominal),
      resolved,
      'the choice is stable within a process, so the sweep protects what we opened',
    );

    const db = initDatabase(resolved);
    closeDatabase(db);
    assert.deepEqual(
      [existsSync(`${nominal}-wal`), existsSync(`${nominal}-shm`)],
      [true, true],
      "opening the variant leaves the stranded journal to its owner",
    );

    // The variant is an ordinary snapshot file: protected while current...
    writeFileSync(resolved, 'in-use');
    ageFile(resolved, 10_000);
    await sweepSnapshotFiles(nominal, { retainHours: 1 });
    assert.ok(existsSync(resolved), 'the file this process resolved to is never swept');
  }

  {
    // No stranded journal — the nominal name is used exactly as before.
    const nominal = scratch('journal-nominal-plain');
    assert.equal(resolveCurrentDbPath(nominal), nominal);
    writeFileSync(nominal, 'legacy');
    assert.equal(resolveCurrentDbPath(nominal), nominal);
  }

  // ─── Pointer ordering also holds for a state without `dbFile` ─────────────

  {
    const nominal = scratch('journal-pointer-legacy');
    writeFileSync(nominal, 'legacy-db');
    const legacyState = {
      sha256: 'f'.repeat(64),
      publishedAt: '2026-08-20T00:00:00.000Z',
      installedAt: '2026-08-20T00:00:00.000Z',
      checkedAt: '2026-08-20T00:00:00.000Z',
    };
    await writeSnapshotState(nominal, legacyState);

    const olderSha = '1'.repeat(64);
    const older = await publishSnapshotState(nominal, {
      dbFile: `data-${olderSha.slice(0, 16)}.db`,
      sha256: olderSha,
      publishedAt: '2026-08-01T00:00:00.000Z',
      installedAt: '2026-08-26T00:00:00.000Z',
      checkedAt: '2026-08-26T00:00:00.000Z',
    });
    assert.equal(older.status, 'superseded', 'a staler snapshot cannot overwrite a dbFile-less pointer');
    assert.equal(older.by.sha256, legacyState.sha256);

    const newerSha = '2'.repeat(64);
    const newer = await publishSnapshotState(nominal, {
      dbFile: `data-${newerSha.slice(0, 16)}.db`,
      sha256: newerSha,
      publishedAt: '2026-08-25T00:00:00.000Z',
      installedAt: '2026-08-26T00:00:00.000Z',
      checkedAt: '2026-08-26T00:00:00.000Z',
    });
    assert.equal(newer.status, 'written', 'a newer one still moves the pointer forward');
  }

  {
    // A dbFile-less pointer whose digest already has a versioned file on disk
    // stands for that file, not for a nominal database that is long gone.
    const nominal = scratch('journal-pointer-versioned');
    const heldSha = '3'.repeat(64);
    writeFileSync(versionedDbPath(nominal, heldSha), 'installed');
    await writeSnapshotState(nominal, {
      sha256: heldSha,
      publishedAt: '2026-08-20T00:00:00.000Z',
      installedAt: '2026-08-20T00:00:00.000Z',
      checkedAt: '2026-08-20T00:00:00.000Z',
    });
    const staleSha = '4'.repeat(64);
    const outcome = await publishSnapshotState(nominal, {
      dbFile: `data-${staleSha.slice(0, 16)}.db`,
      sha256: staleSha,
      publishedAt: '2026-08-01T00:00:00.000Z',
      installedAt: '2026-08-26T00:00:00.000Z',
      checkedAt: '2026-08-26T00:00:00.000Z',
    });
    assert.equal(outcome.status, 'superseded');
  }

  // ─── A successful sync trims the WAL it grew ─────────────────────────────

  {
    const dbPath = join(root, 'journal-sync.db');
    const db = initDatabase(dbPath);
    const insert = db.prepare(
      "INSERT INTO servers (id, slug, name, description) VALUES (?, ?, ?, ?)",
    );
    db.exec('BEGIN');
    for (let i = 0; i < 4_000; i += 1) {
      insert.run(`io.example/bulk-${i}`, `bulk-${i}`, `io.example/bulk-${i}`, 'x'.repeat(400));
    }
    db.exec('COMMIT');
    assert.ok(
      statSync(`${dbPath}-wal`).size > 1_000_000,
      'a single-transaction write leaves a WAL the size of the write',
    );

    const count = await syncOfficialRegistry(
      db,
      runtime(async () =>
        Response.json({
          servers: [{ server: { name: 'io.example/fresh', version: '1.0.0', description: '' } }],
          metadata: { count: 1 },
        }),
      ),
    );
    assert.equal(count, 1);
    assert.equal(statSync(`${dbPath}-wal`).size, 0, 'a successful sync truncates the WAL');

    // And the trim is idempotent / safe to call directly.
    checkpointWal(db);
    closeDatabase(db);
    assert.equal(existsSync(`${dbPath}-wal`), false, 'a clean close removes the journal entirely');
    assert.equal(existsSync(`${dbPath}-shm`), false);
  }
}
