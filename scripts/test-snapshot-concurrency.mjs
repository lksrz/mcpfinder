/**
 * Multi-process safety of the snapshot data dir: promotion, the pointer, and
 * retention.
 *
 * Every check here stands in for two mcpfinder processes (Claude Desktop,
 * Cursor, Claude Code) sharing one `~/.mcpfinder/`: exclusive promotion, the
 * pointer never moving backwards, retention taking a database out from under a
 * peer without harming it, and a tool call landing inside the handle switch.
 * What happens when two peers meet each other's *installed* files — adoption,
 * variants, the stand-in a sweep can leave behind — is in
 * `test-snapshot-adoption.mjs`; the fixtures both use are in
 * `snapshot-concurrency-harness.mjs`.
 *
 * The retention checks run against real SQLite databases with real WAL
 * sidecars, not stand-in text files — the property under test is that a peer
 * with the file *open* survives, which a synthetic sidecar cannot demonstrate.
 */
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import {
  ageFile,
  bootstrapFromSnapshot,
  createCatalog,
  dir,
  getServerCount,
  initDatabase,
  openPeerDb,
  payload,
  payloadSha,
  promoteDownload,
  publishSnapshotState,
  readSnapshotState,
  reconcileSnapshotPointer,
  resolveCurrentDbPath,
  scratch,
  serveOk,
  startOrigin,
  stateFor,
  sweepSnapshotFiles,
  versionedDbPath,
  wait,
  writeSnapshotState,
} from './snapshot-concurrency-harness.mjs';

// ─── 1. Two installers of one digest: the loser adopts, never overwrites ────

{
  const nominal = scratch('promote-race');
  const target = versionedDbPath(nominal, payloadSha);
  const tmpA = `${nominal}.download-111-aaaa`;
  const tmpB = `${nominal}.download-222-bbbb`;
  // The same bytes, because it is the same digest — which is also why the
  // loser may adopt at all. Two *different* payloads under one name is a
  // different scenario, and the one `test-snapshot-adoption.mjs` covers.
  writeFileSync(tmpA, 'verified snapshot bytes');
  writeFileSync(tmpB, 'verified snapshot bytes');

  assert.deepEqual(await promoteDownload(tmpA, target), { status: 'ok', path: target });
  const winner = statSync(target);

  // B's existence check is irrelevant here: what protects A is that the create
  // itself refuses to replace an existing name.
  assert.deepEqual(
    await promoteDownload(tmpB, target),
    { status: 'ok', path: target, temp: tmpB },
    'the loser reports no error and lands on the same file',
  );
  const after = statSync(target);

  assert.equal(after.ino, winner.ino, "the winner's inode is never replaced");
  assert.equal(readFileSync(target, 'utf8'), 'verified snapshot bytes');
  assert.equal(existsSync(tmpA), false, "the winner's temp file is cleaned up");
  // The loser's is *not* — adopting a file somebody else installed hands the
  // verified bytes back so the caller can fall back to them (see
  // `test-snapshot-adoption.mjs`, block 5).
  assert.equal(existsSync(tmpB), true, "the loser keeps its copy until the caller lets go");
  rmSync(tmpB);
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

// ─── 10. A retired handle that will not close is never abandoned ────────────

{
  // The old contract gave up after three attempts and kept the descriptor and
  // the WAL lock for the life of the process — unbounded for a stdio server
  // that lives as long as the client that spawned it. Now the fast attempts
  // hand over to a ticker that keeps trying, on unref'd timers so a handle
  // that never closes still cannot hold the process open.
  const nominal = scratch('close-fails');
  const origin = await startOrigin(serveOk);
  const HANDOVER = 'Could not close the retired catalog handle';
  // Stands in for the 60s production ticker; the property under test is that it
  // keeps ticking, not how far apart the ticks are. Also the ticker's
  // fingerprint below — no other timer in this block is given this delay.
  const retireSlowRetryMs = 20;
  const logs = [];
  /** How many closes the fast phase had tried when it gave up and backed off. */
  let attemptsAtHandover = null;
  const state = { db: null };
  // Captured before the globals are instrumented, so the polling below is not
  // mistaken for one of the catalog's own timers.
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const waitReal = (ms) => new Promise((r) => realSetTimeout(r, ms));

  // The delay is recorded alongside the kind because the catalog's own
  // periodic-refresh `setInterval` is created inside this window too, and an
  // assertion that cannot tell it from the retirement ticker asserts nothing.
  const timers = [];
  const record = (kind, delayMs, timer) => {
    const seen = { kind, delayMs, unrefd: false };
    timers.push(seen);
    const unref = timer.unref?.bind(timer);
    if (unref) {
      timer.unref = () => {
        seen.unrefd = true;
        return unref();
      };
    }
    return timer;
  };
  globalThis.setTimeout = (fn, ms, ...rest) =>
    record('timeout', ms, realSetTimeout(fn, ms, ...rest));
  globalThis.setInterval = (fn, ms, ...rest) =>
    record('interval', ms, realSetInterval(fn, ms, ...rest));

  // Fails through the whole fast phase and the first two slow ticks, then the
  // imaginary statement that was holding it finishes and the close lands.
  const closesUntilFree = 6;
  let closeAttempts = 0;
  const real = initDatabase(join(dir, 'close-fails', 'wedged.db'));
  let closed = false;
  state.db = new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'close') {
        return () => {
          closeAttempts += 1;
          if (closeAttempts < closesUntilFree) throw new Error('handle is wedged');
          closed = true;
          target.close();
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const catalog = createCatalog({
    dbPath: nominal,
    baseUrl: origin.base,
    lingerMs: 0,
    retireSlowRetryMs,
    openDb: (path) => initDatabase(path),
    getDb: () => state.db,
    setDb: (next) => {
      state.db = next;
    },
    log: (message) => {
      logs.push(message);
      // Sampled *in* the hand-over, not polled after it. The warning is written
      // synchronously between the last fast attempt and the creation of the
      // ticker, so this is the fast phase's attempt count by construction — a
      // poll that lands after the ticker's first tick would read one too many.
      if (attemptsAtHandover === null && message.includes(HANDOVER)) {
        attemptsAtHandover = closeAttempts;
      }
    },
  });

  catalog.start();
  await catalog.settled();

  const handover = () => logs.find((l) => l.includes(HANDOVER));
  for (let i = 0; i < 100 && !handover(); i += 1) await waitReal(20);
  assert.ok(handover(), `the hand-over is announced once: ${logs.join('')}`);
  assert.equal(
    attemptsAtHandover,
    3,
    'the fast phase runs exactly RETIRE_CLOSE_ATTEMPTS times before backing off',
  );
  assert.match(handover(), /Retrying every/, 'and says the retries continue');

  // The ticker takes over and keeps going past the point the old code stopped.
  for (let i = 0; i < 200 && !closed; i += 1) await waitReal(20);
  assert.ok(closed, `the ticker closed the handle eventually (attempts: ${closeAttempts})`);
  assert.equal(closeAttempts, closesUntilFree, 'and stopped at the attempt that succeeded');

  const success = () => logs.find((l) => l.includes('Retired catalog handle closed'));
  for (let i = 0; i < 100 && !success(); i += 1) await waitReal(20);
  assert.ok(success(), `the eventual close closes out the warning: ${logs.join('')}`);

  // Silence after that: the ticker is cleared, so no further attempt is made
  // and no further line is written however long we wait.
  const settledAttempts = closeAttempts;
  const settledLogs = logs.length;
  await waitReal(200);
  assert.equal(closeAttempts, settledAttempts, 'a closed handle is not retried again');
  assert.equal(logs.length, settledLogs, 'and nothing more is logged');
  assert.equal(
    logs.filter((l) => l.includes(HANDOVER)).length,
    1,
    'the warning is said once, not once per tick',
  );

  globalThis.setTimeout = realSetTimeout;
  globalThis.setInterval = realSetInterval;

  // A handle that never closes must not be able to keep the process alive.
  //
  // Identified by its delay: `retireSlowRetryMs` is a value only the retirement
  // ticker is given, so the catalog's periodic-refresh interval — created by
  // `start()` inside the same window, and also an unref'd `setInterval` —
  // cannot stand in for it.
  const slowRetries = timers.filter(
    (t) => t.kind === 'interval' && t.delayMs === retireSlowRetryMs,
  );
  assert.equal(
    slowRetries.length,
    1,
    `the slow retry is a ticker, not a one-shot: ${JSON.stringify(timers)}`,
  );

  // Everything the retirement path schedules is sub-second here (linger 0, the
  // fast retries, the ticker); the only other timer in flight is the refresh
  // interval, hours away. So this really is the retirement path's own set, and
  // it is non-empty — an empty filter would pass the `unrefd` check vacuously.
  const retirement = timers.filter((t) => t.delayMs < 1_000);
  assert.ok(
    retirement.length >= 4,
    `the retirement path schedules a linger, its fast retries and a ticker: ${JSON.stringify(timers)}`,
  );
  assert.deepEqual(
    retirement.filter((t) => !t.unrefd),
    [],
    'every timer the retirement path creates is unref’d',
  );

  await origin.close();
}
console.log('snapshot concurrency checks passed');
