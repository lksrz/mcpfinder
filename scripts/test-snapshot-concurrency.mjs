/**
 * Multi-process safety of the snapshot data dir.
 *
 * Every check here stands in for two mcpfinder processes (Claude Desktop,
 * Cursor, Claude Code) sharing one `~/.mcpfinder/`: exclusive promotion, the
 * pointer never moving backwards, retention taking a database out from under a
 * peer without harming it, and a tool call landing inside the handle switch.
 *
 * The retention checks run against real SQLite databases with real WAL
 * sidecars, not stand-in text files — the property under test is that a peer
 * with the file *open* survives, which a synthetic sidecar cannot demonstrate.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const dir = mkdtempSync(join(tmpdir(), 'mcpf-snapshot-concurrency-'));
process.env.MCPFINDER_DATA_DIR = dir;

const {
  bootstrapFromSnapshot,
  initDatabase,
  getServerCount,
  publishSnapshotState,
  readSnapshotState,
  reconcileSnapshotPointer,
  resolveCurrentDbPath,
  sweepSnapshotFiles,
  versionedDbPath,
  writeSnapshotState,
} = await import('../packages/core/dist/index.js');
// Not part of the public surface — reached directly so the promotion primitive
// can be exercised without racing two real downloads.
const { promoteDownload } = await import('../packages/core/dist/snapshot.js');
const { createCatalog } = await import('../packages/mcp-server/dist/catalog.js');

// ─── Fixtures ───────────────────────────────────────────────────────────────

function buildSnapshotPayload(name, rows = 1) {
  const srcPath = join(dir, `${name}.src.db`);
  const db = initDatabase(srcPath);
  for (let i = 0; i < rows; i += 1) {
    db.prepare("INSERT INTO servers (id, slug, name, description) VALUES (?, ?, ?, '')").run(
      `io.example/${name}-${i}`,
      `${name}-${i}`,
      `io.example/${name}-${i}`,
    );
  }
  db.close();
  return gzipSync(readFileSync(srcPath));
}

const payload = buildSnapshotPayload('conc');
const payloadSha = createHash('sha256').update(payload).digest('hex');

function manifestFor(overrides = {}) {
  return JSON.stringify({
    publishedAt: '2026-08-26T00:00:00.000Z',
    serverCount: 1,
    sha256: payloadSha,
    sizeBytes: payload.length,
    url: `data.sqlite.gz?sha=${payloadSha}`,
    ...overrides,
  });
}

async function startOrigin(handler) {
  const server = createServer((req, res) => {
    Promise.resolve(handler(req, res)).catch(() => res.destroy());
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function serveOk(req, res) {
  if (req.url.startsWith('/manifest.json')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(manifestFor());
    return;
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream', etag: '"c1"' });
  res.end(payload);
}

function scratch(name) {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return join(path, 'data.db');
}

function ageFile(path, hours) {
  const when = new Date(Date.now() - hours * 3_600_000);
  utimesSync(path, when, when);
}

/** An open catalog DB with `rows` servers in it — and a live `-wal`/`-shm`. */
function openPeerDb(path, rows) {
  const db = initDatabase(path);
  for (let i = 0; i < rows; i += 1) {
    db.prepare("INSERT INTO servers (id, slug, name, description) VALUES (?, ?, ?, '')").run(
      `io.example/peer-${i}`,
      `peer-${i}`,
      `io.example/peer-${i}`,
    );
  }
  assert.ok(existsSync(`${path}-wal`), 'the fixture must have a real WAL sidecar');
  return db;
}

function stateFor(nominal, sha, publishedAt) {
  return {
    dbFile: basename(versionedDbPath(nominal, sha)),
    sha256: sha,
    publishedAt,
    installedAt: publishedAt,
    checkedAt: publishedAt,
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 1. Two installers of one digest: the loser adopts, never overwrites ────

{
  const nominal = scratch('promote-race');
  const target = versionedDbPath(nominal, payloadSha);
  const tmpA = `${nominal}.download-111-aaaa`;
  const tmpB = `${nominal}.download-222-bbbb`;
  writeFileSync(tmpA, 'installer A');
  writeFileSync(tmpB, 'installer B');

  assert.deepEqual(await promoteDownload(tmpA, target), { status: 'ok', path: target });
  const winner = statSync(target);

  // B's existence check is irrelevant here: what protects A is that the create
  // itself refuses to replace an existing name.
  assert.deepEqual(
    await promoteDownload(tmpB, target),
    { status: 'ok', path: target },
    'the loser reports no error and lands on the same file',
  );
  const after = statSync(target);

  assert.equal(after.ino, winner.ino, "the winner's inode is never replaced");
  assert.equal(readFileSync(target, 'utf8'), 'installer A');
  assert.equal(existsSync(tmpA), false, "the winner's temp file is cleaned up");
  assert.equal(existsSync(tmpB), false, "and so is the loser's");
}

// ─── 2. A promotion that cannot create the target is reported, not swallowed ─

{
  const nominal = scratch('promote-fails');
  // A directory in the way makes both the exclusive create and the fallback
  // rename fail, and leaves nothing adoptable behind.
  const target = versionedDbPath(nominal, payloadSha);
  mkdirSync(target, { recursive: true });
  const tmp = `${nominal}.download-333-cccc`;
  writeFileSync(tmp, 'payload');

  const outcome = await promoteDownload(tmp, target);
  assert.equal(outcome.status, 'failed', 'a promotion that cannot create the target must say so');
  assert.ok(outcome.reason);

  // And the whole bootstrap surfaces it instead of claiming success.
  const origin = await startOrigin(serveOk);
  const result = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    force: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /install-failed/);
  assert.equal(await readSnapshotState(nominal), null, 'and never moves the pointer');
  await origin.close();
}

// ─── 3. The pointer never moves back to an older snapshot ───────────────────

{
  const nominal = scratch('pointer-order');
  const newerSha = 'a'.repeat(64);
  const olderSha = 'b'.repeat(64);
  writeFileSync(versionedDbPath(nominal, newerSha), 'newer');
  writeFileSync(versionedDbPath(nominal, olderSha), 'older');

  const newer = stateFor(nominal, newerSha, '2026-08-26T12:00:00.000Z');
  // Peer B wins the race with the fresher snapshot.
  assert.deepEqual(await publishSnapshotState(nominal, newer), { status: 'written' });

  // Peer A finishes its older download afterwards and must not roll the data
  // dir back — the newer file would fall out of the pointer and be swept.
  const older = {
    ...newer,
    dbFile: basename(versionedDbPath(nominal, olderSha)),
    sha256: olderSha,
    publishedAt: '2026-08-25T12:00:00.000Z',
  };
  const rejected = await publishSnapshotState(nominal, older);
  assert.equal(rejected.status, 'superseded');
  assert.equal(rejected.by.sha256, newerSha);
  assert.equal(resolveCurrentDbPath(nominal), versionedDbPath(nominal, newerSha));

  // Re-stating the snapshot already pointed at is always allowed (that is how
  // `checkedAt` gets stamped), and so is genuinely moving forward.
  assert.deepEqual(
    await publishSnapshotState(nominal, { ...newer, checkedAt: '2026-08-26T18:00:00.000Z' }),
    { status: 'written' },
  );
  const newestSha = 'c'.repeat(64);
  writeFileSync(versionedDbPath(nominal, newestSha), 'newest');
  assert.deepEqual(
    await publishSnapshotState(nominal, {
      ...newer,
      dbFile: basename(versionedDbPath(nominal, newestSha)),
      sha256: newestSha,
      publishedAt: '2026-08-27T00:00:00.000Z',
    }),
    { status: 'written' },
  );
  assert.equal(resolveCurrentDbPath(nominal), versionedDbPath(nominal, newestSha));
}

{
  // A pointer naming a file that is gone orders nothing — anything beats it.
  const nominal = scratch('pointer-dangling');
  await writeSnapshotState(nominal, {
    dbFile: 'data-deadbeefdeadbeef.db',
    sha256: 'd'.repeat(64),
    publishedAt: '2027-01-01T00:00:00.000Z',
    installedAt: '2027-01-01T00:00:00.000Z',
    checkedAt: '2027-01-01T00:00:00.000Z',
  });
  const sha = 'e'.repeat(64);
  writeFileSync(versionedDbPath(nominal, sha), 'real');
  const older = stateFor(nominal, sha, '2020-01-01T00:00:00.000Z');
  const outcome = await publishSnapshotState(nominal, older);
  assert.deepEqual(outcome, { status: 'written' });
}

// ─── 4. A failed pointer write is an error, not silence ─────────────────────

{
  const nominal = scratch('pointer-write-fails');
  // Nothing can be renamed onto a directory, so the pointer write cannot land.
  mkdirSync(`${nominal}.snapshot.json`, { recursive: true });

  const origin = await startOrigin(serveOk);
  let activated = null;
  const result = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    force: true,
    activate: (path) => {
      activated = path;
    },
  });
  assert.equal(result.ok, false, 'activation happened but the data dir did not switch');
  assert.match(result.reason, /pointer-write-failed/);
  assert.equal(activated, versionedDbPath(nominal, payloadSha));
  await origin.close();
}

// ─── 5. Retention takes the DB from under a live peer, but never its journal ─

{
  const nominal = scratch('sweep-open-peer');
  const currentSha = 'a'.repeat(64);
  const heldSha = 'b'.repeat(64);
  const current = versionedDbPath(nominal, currentSha);
  const held = versionedDbPath(nominal, heldSha);

  writeFileSync(current, 'current');
  const peer = openPeerDb(held, 2);
  await writeSnapshotState(nominal, stateFor(nominal, currentSha, '2026-08-26T00:00:00.000Z'));
  // Long past the grace period, current file included.
  for (const path of [current, held, `${held}-wal`, `${held}-shm`]) ageFile(path, 500);

  const removed = await sweepSnapshotFiles(nominal, { retainHours: 1 });
  assert.deepEqual(removed, [basename(held)], 'only the superseded database is reclaimed');
  assert.ok(existsSync(current), 'the file the pointer selects is never swept, at any age');
  assert.equal(existsSync(held), false, 'a superseded database goes even while a peer has it open');
  assert.ok(existsSync(`${held}-wal`), 'but its journal is never touched — SQLite finds it by name');
  assert.ok(existsSync(`${held}-shm`), 'nor its shared-memory index');

  // The whole rule rests on this: the peer works on through its own inode.
  assert.equal(getServerCount(peer), 2, 'the peer still reads its database');
  peer.prepare("INSERT INTO servers (id, slug, name, description) VALUES (?, ?, ?, '')").run(
    'io.example/after-sweep',
    'after-sweep',
    'io.example/after-sweep',
  );
  assert.equal(getServerCount(peer), 3, 'and still writes to it');
  peer.close();
}

// ─── 6. A name that comes back never inherits a stranded journal ────────────

{
  // The footprint the sweep leaves behind: a live journal, no database. The
  // same digest is then published again and lands on that very name.
  const nominal = scratch('name-returns');
  const target = versionedDbPath(nominal, payloadSha);
  const peer = openPeerDb(target, 3);
  rmSync(target);

  const origin = await startOrigin(serveOk);
  const result = await bootstrapFromSnapshot({ baseUrl: origin.base, dbPath: nominal, force: true });
  assert.equal(result.ok, true, result.reason);

  const installed = resolveCurrentDbPath(nominal);
  assert.notEqual(installed, target, 'never onto a name whose journal belongs to somebody else');
  assert.match(basename(installed), /^data-[0-9a-f]{16}-[0-9a-z]{6}\.db$/, installed);
  assert.equal(existsSync(`${installed}-wal`), false, 'the new file starts with no journal at all');
  assert.ok(existsSync(`${target}-wal`), "and the peer's journal is left exactly where it was");
  assert.equal(getServerCount(peer), 3, 'the peer is untouched');

  const fresh = initDatabase(installed);
  assert.equal(getServerCount(fresh), 1, "the installed file is the snapshot, not the peer's rows");
  fresh.close();
  peer.close();
  await origin.close();
}

// ─── 7. A routine freshness check stamps, and never rolls a peer back ───────

{
  const nominal = scratch('reconcile');
  const mine = 'a'.repeat(64);
  const theirs = 'b'.repeat(64);
  writeFileSync(versionedDbPath(nominal, mine), 'mine');
  writeFileSync(versionedDbPath(nominal, theirs), 'theirs');
  await writeSnapshotState(nominal, stateFor(nominal, mine, '2026-08-25T00:00:00.000Z'));

  // The ordinary case: the check lands and nothing else moves.
  await reconcileSnapshotPointer(nominal, mine, '2026-08-26T06:00:00.000Z');
  let state = await readSnapshotState(nominal);
  assert.equal(state.checkedAt, '2026-08-26T06:00:00.000Z', 'checkedAt is stamped');
  assert.equal(state.sha256, mine);

  // A peer switches the data dir over while our check is in flight. This path
  // runs on every freshness check, so writing our own stale copy back here
  // would undo a peer's install several times a day.
  const peerState = stateFor(nominal, theirs, '2026-08-27T00:00:00.000Z');
  await writeSnapshotState(nominal, peerState);
  await reconcileSnapshotPointer(nominal, mine, '2026-08-26T07:00:00.000Z');
  assert.deepEqual(await readSnapshotState(nominal), peerState, "a peer's pointer is left alone");
  assert.equal(resolveCurrentDbPath(nominal), versionedDbPath(nominal, theirs));
}

{
  // A pointer written before versioned files existed is valid as it stands, and
  // must still be stamped — and tidied up once its own file is there.
  const nominal = scratch('reconcile-legacy');
  const sha = 'c'.repeat(64);
  writeFileSync(nominal, 'legacy db');
  await writeSnapshotState(nominal, {
    sha256: sha,
    publishedAt: '2026-08-25T00:00:00.000Z',
    installedAt: '2026-08-25T00:00:00.000Z',
    checkedAt: '2026-08-25T00:00:00.000Z',
  });

  await reconcileSnapshotPointer(nominal, sha, '2026-08-26T00:00:00.000Z');
  let state = await readSnapshotState(nominal);
  assert.equal(state.dbFile, undefined, 'with no versioned file there is nothing to point at');
  assert.equal(state.checkedAt, '2026-08-26T00:00:00.000Z', 'but the check is still recorded');
  assert.equal(resolveCurrentDbPath(nominal), nominal);

  writeFileSync(versionedDbPath(nominal, sha), 'versioned');
  await reconcileSnapshotPointer(nominal, sha, '2026-08-26T12:00:00.000Z');
  state = await readSnapshotState(nominal);
  assert.equal(state.dbFile, basename(versionedDbPath(nominal, sha)), 'now it is filled in');
  assert.equal(state.checkedAt, '2026-08-26T12:00:00.000Z');
  assert.equal(resolveCurrentDbPath(nominal), versionedDbPath(nominal, sha));
}

{
  // End to end: an up-to-date refresh stamps the pointer and changes nothing else.
  const nominal = scratch('uptodate-stamp');
  const origin = await startOrigin(serveOk);
  const first = await bootstrapFromSnapshot({ baseUrl: origin.base, dbPath: nominal, force: true });
  assert.equal(first.ok, true, first.reason);

  const before = await readSnapshotState(nominal);
  await writeSnapshotState(nominal, { ...before, checkedAt: '2020-01-01T00:00:00.000Z' });
  const again = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    refresh: true,
  });
  assert.equal(again.reason, 'snapshot-up-to-date');

  const after = await readSnapshotState(nominal);
  assert.notEqual(after.checkedAt, '2020-01-01T00:00:00.000Z', 'the check is stamped');
  assert.equal(after.dbFile, before.dbFile, 'and the pointer itself does not move');
  assert.equal(after.sha256, before.sha256);
  await origin.close();
}

// ─── 8. A tool call inside the switch window is told "preparing" ────────────

{
  const nominal = scratch('switch-window');
  const origin = await startOrigin(serveOk);
  const state = { db: null };
  let quiesceEntered;
  const entered = new Promise((resolve) => {
    quiesceEntered = resolve;
  });
  const catalog = createCatalog({
    dbPath: nominal,
    baseUrl: origin.base,
    lingerMs: 0,
    openDb: (path) => initDatabase(path),
    getDb: () => state.db,
    setDb: (next) => {
      state.db = next;
    },
    // A cold start with an empty DB: the switch is the only thing standing
    // between the caller and real data.
    quiesce: async () => {
      quiesceEntered();
      await wait(300);
    },
    log: () => {},
  });
  state.db = initDatabase(catalog.currentDbPath);

  catalog.start();
  await entered;

  assert.equal(getServerCount(state.db), 0, 'the empty DB is still the one in hand');
  const notice = await catalog.waitUntilUsable();
  assert.ok(notice, 'the switch window must not look like an empty catalog');
  assert.match(notice, /retry/i);

  await catalog.settled();
  assert.equal(await catalog.waitUntilUsable(), null);
  assert.equal(getServerCount(state.db), 1);
  await origin.close();
}

// ─── 9. The catalog is busy from the instant it starts, not one await later ─

{
  const nominal = scratch('busy-window');
  const origin = await startOrigin(serveOk);
  // An install already in place, so start-up goes through the pointer read
  // rather than the cold-start shortcut.
  const first = await bootstrapFromSnapshot({ baseUrl: origin.base, dbPath: nominal, force: true });
  assert.equal(first.ok, true, first.reason);
  const installed = await readSnapshotState(nominal);
  await writeSnapshotState(nominal, { ...installed, checkedAt: '2020-01-01T00:00:00.000Z' });

  const state = { db: null };
  const catalog = createCatalog({
    dbPath: nominal,
    baseUrl: origin.base,
    lingerMs: 0,
    openDb: (path) => initDatabase(path),
    getDb: () => state.db,
    setDb: (next) => {
      state.db = next;
    },
    log: () => {},
  });
  state.db = initDatabase(catalog.currentDbPath);

  catalog.start();
  // The pointer read is the first await. A live sync launched in that window
  // would be writing through a handle the switch is about to retire.
  assert.equal(catalog.isBusy(), true, 'busy is set before the first await, not after it');
  await catalog.settled();
  assert.equal(catalog.isBusy(), false, 'and cleared once the check settles');
  state.db.close();
  await origin.close();
}

// ─── 10. A retired handle that will not close is retried, then reported ─────

{
  const nominal = scratch('close-fails');
  const origin = await startOrigin(serveOk);
  const logs = [];
  const state = { db: null };
  const catalog = createCatalog({
    dbPath: nominal,
    baseUrl: origin.base,
    lingerMs: 0,
    openDb: (path) => initDatabase(path),
    getDb: () => state.db,
    setDb: (next) => {
      state.db = next;
    },
    log: (message) => logs.push(message),
  });

  const real = initDatabase(catalog.currentDbPath);
  let closeAttempts = 0;
  state.db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'close') {
        return () => {
          closeAttempts += 1;
          throw new Error('handle is wedged');
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  catalog.start();
  await catalog.settled();
  // Retirement is deferred, and each failed close is retried on a short timer.
  for (let i = 0; i < 60 && !logs.some((l) => l.includes('Could not close')); i += 1) {
    await wait(50);
  }

  assert.ok(closeAttempts > 1, `a failed close is retried (attempts: ${closeAttempts})`);
  assert.ok(
    logs.some((line) => line.includes('Could not close the retired catalog handle')),
    logs.join(''),
  );
  real.close();
  await origin.close();
}

// ─── 11. Two bootstraps racing on one data dir install exactly one file ─────

{
  const nominal = scratch('parallel-bootstrap');
  const origin = await startOrigin(serveOk);
  const [a, b] = await Promise.all([
    bootstrapFromSnapshot({ baseUrl: origin.base, dbPath: nominal, force: true }),
    bootstrapFromSnapshot({ baseUrl: origin.base, dbPath: nominal, force: true }),
  ]);

  assert.equal(a.ok, true, a.reason);
  assert.equal(b.ok, true, b.reason);
  const installed = readdirSync(join(dir, 'parallel-bootstrap')).filter(
    (f) => f.startsWith('data-') && f.endsWith('.db'),
  );
  assert.deepEqual(installed, [`data-${payloadSha.slice(0, 16)}.db`], 'exactly one snapshot file');
  assert.equal(
    readdirSync(join(dir, 'parallel-bootstrap')).filter((f) => f.includes('.download-')).length,
    0,
    'both temp files are cleaned up',
  );
  const db = initDatabase(resolveCurrentDbPath(nominal));
  assert.equal(getServerCount(db), 1, 'and it is the real snapshot');
  db.close();
  await origin.close();
}

rmSync(dir, { recursive: true, force: true });
console.log('snapshot concurrency checks passed');
