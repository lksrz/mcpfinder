/**
 * What two mcpfinder processes do to each other's *installed* snapshot files.
 *
 * Split out of `test-snapshot-concurrency.mjs` (which covers promotion, the
 * pointer and retention) when that file approached the 1000-line ceiling; the
 * fixtures both use are in `snapshot-concurrency-harness.mjs`. The seam is the
 * subject: everything here is about a peer meeting a file another peer put on
 * disk — adopting it instead of writing a second ~230MB copy, refusing it when
 * it is not really the snapshot, and surviving a sweep that takes it away
 * mid-switch.
 */
import assert from 'node:assert/strict';
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import {
  ageFile,
  bootstrapFromSnapshot,
  dir,
  discardStandIn,
  getServerCount,
  initDatabase,
  manifestFor,
  payload,
  payloadSha,
  promoteDownload,
  publishSnapshotState,
  readSnapshotState,
  resolveCurrentDbPath,
  scratch,
  serveOk,
  startOrigin,
  stateFor,
  sweepSnapshotFiles,
  versionedDbPath,
  writeSnapshotState,
} from './snapshot-concurrency-harness.mjs';

// ─── 1. Two bootstraps racing on one data dir install exactly one file ─────

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

// ─── 2. A returning name does not cost every peer its own copy ────────────

{
  // Stranded `-wal`/`-shm` at the canonical name push each installer onto a
  // variant, and the suffix is random — so before this scan two peers meeting
  // the same journal each wrote an independent ~230MB copy of identical bytes.
  const nominal = scratch('variant-dedupe');
  const folder = join(dir, 'variant-dedupe');
  const canonical = versionedDbPath(nominal, payloadSha);
  writeFileSync(`${canonical}-wal`, 'a peer still owns this journal');
  writeFileSync(`${canonical}-shm`, 'and this one');

  const variants = () =>
    readdirSync(folder).filter((f) =>
      new RegExp(`^data-${payloadSha.slice(0, 16)}-[0-9a-z]{6}\\.db$`).test(f),
    );

  const first = join(folder, 'data.db.download-a');
  writeFileSync(first, 'verified snapshot bytes');
  const a = await promoteDownload(first, canonical);
  assert.equal(a.status, 'ok');
  assert.notEqual(a.path, canonical, 'the stranded journal keeps the canonical name off-limits');
  assert.deepEqual(variants(), [basename(a.path)], 'peer A installs one variant');

  // Aged past any plausible retention grace, so peer B is adopting a file the
  // sweep would otherwise consider a leftover.
  ageFile(a.path, 24 * 30);
  const second = join(folder, 'data.db.download-b');
  writeFileSync(second, 'verified snapshot bytes');
  const b = await promoteDownload(second, canonical);
  assert.equal(b.status, 'ok');
  assert.equal(b.path, a.path, 'peer B adopts the variant already holding this digest');
  assert.deepEqual(variants(), [basename(a.path)], 'and writes no second copy');
  assert.equal(b.temp, second, "an adopting peer keeps its verified copy and says so");
  assert.equal(existsSync(second), true, 'the bytes it may still need are not discarded');
  assert.equal(existsSync(canonical), false, 'and the canonical name is still left alone');

  // Adoption is also a claim: the sweep decides by mtime, and the file peer B
  // just took up must not look untouched to it.
  assert.ok(
    Date.now() - statSync(a.path).mtimeMs < 60_000,
    'adopting a variant restarts its retention clock',
  );

  // An empty file at a variant name is not a snapshot anybody can open, so it
  // is not adopted — a fresh copy is installed instead.
  writeFileSync(join(folder, `data-${payloadSha.slice(0, 16)}-000000.db`), '');
  const third = join(folder, 'data.db.download-c');
  writeFileSync(third, 'verified snapshot bytes');
  const c = await promoteDownload(third, canonical);
  assert.equal(c.status, 'ok');
  assert.equal(c.path, a.path, 'the empty variant is skipped and the usable one adopted');
}

// ─── 3. Two peers installing one digest end up on one file and one pointer ─

{
  const nominal = scratch('peer-duplicate');
  const folder = join(dir, 'peer-duplicate');
  const origin = await startOrigin(serveOk);
  // The footprint of a digest published, swept, and published again while a
  // peer still holds the old file open.
  writeFileSync(`${versionedDbPath(nominal, payloadSha)}-wal`, 'still-owned-wal');

  const a = await bootstrapFromSnapshot({ baseUrl: origin.base, dbPath: nominal, force: true });
  const b = await bootstrapFromSnapshot({ baseUrl: origin.base, dbPath: nominal, force: true });
  assert.equal(a.ok, true, a.reason);
  assert.equal(b.ok, true, b.reason);
  assert.equal(b.dbPath, a.dbPath, 'the second install runs from the first one’s file');

  const installed = readdirSync(folder).filter(
    (f) => f.startsWith('data-') && f.endsWith('.db') && !f.includes('.download-'),
  );
  assert.deepEqual(installed, [basename(a.dbPath)], 'exactly one copy of the digest on disk');
  assert.equal((await readSnapshotState(nominal)).dbFile, basename(a.dbPath));
  assert.equal(resolveCurrentDbPath(nominal), a.dbPath, 'and the pointer aims at it');

  const db = initDatabase(resolveCurrentDbPath(nominal));
  assert.equal(getServerCount(db), 1, 'and it is the real snapshot');
  db.close();
  await origin.close();
}

// ─── 4. The pointer does not move between two copies of one digest ─────────

{
  // Belt to promoteDownload's braces: if a duplicate does get written — a lost
  // race, an older install — repointing at it buys identical bytes and drops
  // the file every peer is already serving from out of the sweep's protection.
  const nominal = scratch('pointer-same-digest');
  const sha = 'f'.repeat(64);
  const inUse = versionedDbPath(nominal, sha);
  const duplicate = join(dir, 'pointer-same-digest', `data-${sha.slice(0, 16)}-abc123.db`);
  writeFileSync(inUse, 'same bytes');
  writeFileSync(duplicate, 'same bytes');

  const state = stateFor(nominal, sha, '2026-08-26T12:00:00.000Z');
  assert.deepEqual(await publishSnapshotState(nominal, state), { status: 'written' });

  // Newer by publishedAt, so nothing but the digest check stands in its way.
  const onDuplicate = {
    ...state,
    dbFile: basename(duplicate),
    publishedAt: '2026-08-27T12:00:00.000Z',
  };
  const outcome = await publishSnapshotState(nominal, onDuplicate);
  assert.equal(outcome.status, 'superseded');
  assert.equal(outcome.by.dbFile, basename(inUse));
  assert.equal(resolveCurrentDbPath(nominal), inUse, 'the data dir stays on the file in use');

  // The guard defends a file that is actually there. Once it is gone the
  // duplicate is the only copy left and taking it up is the whole point.
  rmSync(inUse);
  assert.deepEqual(await publishSnapshotState(nominal, onDuplicate), { status: 'written' });
  assert.equal(resolveCurrentDbPath(nominal), duplicate);
}

// ─── 5. A sweep taking the adopted file away does not leave an empty catalog ─

{
  // The chain this defends against: peer B adopts an aged variant, and a
  // `sweepSnapshotFiles` pass already under way in another process — one that
  // read that variant's mtime *before* B touched it — unlinks it afterwards.
  // `initDatabase` does not fail on the vanished name, it creates a fresh empty
  // database there, on top of the `-wal` the sweep left behind.
  const nominal = scratch('adopt-sweep-race');
  const folder = join(dir, 'adopt-sweep-race');
  const canonical = versionedDbPath(nominal, payloadSha);
  // A journal whose owner is still running keeps the canonical name off-limits,
  // so an installer of this digest has to look for a variant.
  writeFileSync(`${canonical}-wal`, 'still-owned-wal');
  // What it finds: real snapshot bytes under a variant name, aged past any
  // grace and named by no pointer — precisely the sweep's own target.
  const doomed = join(folder, `data-${payloadSha.slice(0, 16)}-aaaaaa.db`);
  writeFileSync(doomed, gunzipSync(payload));
  ageFile(doomed, 24 * 30);

  const origin = await startOrigin(serveOk);
  const opened = [];
  const result = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    force: true,
    activate: async (path) => {
      if (opened.length === 0) {
        // The interleaving itself: the sweep's unlink lands after the claim.
        // `retainHours: 0` stands in for the stale mtime it decided on.
        await sweepSnapshotFiles(nominal, { retainHours: 0 });
        assert.equal(existsSync(doomed), false, 'the fixture must really take the file away');
      }
      const db = initDatabase(path);
      opened.push({ path, servers: getServerCount(db) });
      db.close();
    },
  });
  await origin.close();

  assert.equal(result.ok, true, result.reason);
  assert.equal(opened.length, 2, 'the vanished file is noticed and a real one activated instead');
  assert.equal(opened[0].servers, 0, 'the first open really did land on an empty stand-in');
  assert.equal(opened.at(-1).servers, 1, 'and the caller does not stay there');
  assert.notEqual(opened.at(-1).path, doomed, 'the repair is a file of our own, not the swept name');
  assert.equal(result.dbPath, opened.at(-1).path, 'which is the file the bootstrap reports');
  assert.equal(
    (await readSnapshotState(nominal)).dbFile,
    basename(result.dbPath),
    'and the one the pointer selects',
  );

  const db = initDatabase(resolveCurrentDbPath(nominal));
  assert.equal(getServerCount(db), 1, 'so a process starting now sees the snapshot too');
  db.close();
  assert.equal(
    readdirSync(folder).filter((f) => f.includes('.download-')).length,
    0,
    'and the retained copy is released once it is no longer the only one',
  );
}

// ─── 6. A pointer whose file is gone is not "up to date" ───────────────────

{
  // What a lost race leaves behind, and the reason it is survivable: the digest
  // still matches the manifest, but `resolveCurrentDbPath` has fallen back to a
  // `data.db` that is nobody's snapshot. Answering `snapshot-up-to-date` here
  // is what would turn a transient race into a permanently empty catalog —
  // every later check matches too, so nothing ever installs again.
  const nominal = scratch('dangling-pointer');
  writeFileSync(nominal, 'the fallback, and not the snapshot');
  await writeSnapshotState(nominal, {
    dbFile: `data-${payloadSha.slice(0, 16)}-zzzzzz.db`,
    sha256: payloadSha,
    publishedAt: '2026-08-26T00:00:00.000Z',
    installedAt: '2026-08-26T00:00:00.000Z',
    checkedAt: '2026-08-26T00:00:00.000Z',
  });

  const origin = await startOrigin(serveOk);
  const result = await bootstrapFromSnapshot({ baseUrl: origin.base, dbPath: nominal, refresh: true });
  await origin.close();

  assert.equal(result.ok, true, `a pointer with no file must not count as current (${result.reason})`);
  const db = initDatabase(resolveCurrentDbPath(nominal));
  assert.equal(getServerCount(db), 1, 'the data dir is repaired instead of left on the fallback');
  db.close();
}
// ─── 7. The peer after a repaired race does not inherit the stand-in ────────

{
  // The repair above leaves a footprint. Between the sweep's unlink and
  // `initDatabase` recreating the name, a ~53KB schema-only database ends up at
  // a variant name carrying a verified digest — and nothing re-hashes an
  // adopted file. So the *next* peer promoting this digest scanned, found the
  // stand-in, adopted it and activated a 0-server catalogue, with an intact
  // pointer and a matching digest: its next refresh answered
  // `snapshot-up-to-date` and it stayed there. The same wedge, one process
  // removed, and self-perpetuating — every adoption used to touch the mtime, so
  // the sweep never aged it out either.
  const nominal = scratch('adopt-sweep-successor');
  const folder = join(dir, 'adopt-sweep-successor');
  const canonical = versionedDbPath(nominal, payloadSha);
  writeFileSync(`${canonical}-wal`, 'still-owned-wal');
  const doomed = join(folder, `data-${payloadSha.slice(0, 16)}-aaaaaa.db`);
  writeFileSync(doomed, gunzipSync(payload));
  ageFile(doomed, 24 * 30);

  const origin = await startOrigin(serveOk);
  let swept = false;
  const first = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    force: true,
    activate: async (path) => {
      if (!swept) {
        swept = true;
        await sweepSnapshotFiles(nominal, { retainHours: 0 });
      }
      // The stand-in is created here, exactly as a real caller creates it.
      initDatabase(path).close();
    },
  });
  assert.equal(first.ok, true, first.reason);
  assert.equal(existsSync(doomed), false, 'the repair takes the stand-in away with it');

  // Peer two: a fresh install of the same digest, meeting the same stranded
  // journal and therefore scanning for a variant to adopt.
  const second = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    force: true,
    activate: (path) => initDatabase(path).close(),
  });
  await origin.close();

  assert.equal(second.ok, true, second.reason);
  assert.equal(second.dbPath, first.dbPath, 'and adopts the repaired file, not a stand-in');
  const db = initDatabase(second.dbPath);
  assert.equal(getServerCount(db), 1, 'the second peer must not land on a 0-server catalogue');
  db.close();
}

// ─── 8. A stand-in at a variant name is never adopted as the snapshot ───────

{
  // The cleanup above closes the steady state, not the window. A process killed
  // between `activate` and that unlink leaves the stand-in behind for good, and
  // on Windows the unlink simply fails while anything holds the file. So
  // adoption does not rest on the cleanup having happened: a variant name is a
  // *candidate*, and the file's length against the verified download in hand is
  // what decides.
  const nominal = scratch('standin-guard');
  const folder = join(dir, 'standin-guard');
  const canonical = versionedDbPath(nominal, payloadSha);
  writeFileSync(`${canonical}-wal`, 'still-owned-wal');
  // Exactly what `initDatabase` leaves at a swept name: the real schema, a
  // verified digest in the name, and not one server in it.
  const standIn = join(folder, `data-${payloadSha.slice(0, 16)}-aaaaaa.db`);
  initDatabase(standIn).close();
  // And the hard version of it: SQLite rounds a small database up to whole
  // pages, so this stand-in is byte-for-byte the *length* of the snapshot here.
  // Length alone would adopt it; the sampled bytes are what refuse it.
  assert.equal(
    statSync(standIn).size,
    gunzipSync(payload).length,
    'the fixture must be a real database indistinguishable by length',
  );
  // Old enough that a claim on it would be visible, young enough that the
  // install's own sweep leaves it alone.
  ageFile(standIn, 24);

  const origin = await startOrigin(serveOk);
  const result = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    force: true,
    activate: (path) => initDatabase(path).close(),
  });
  await origin.close();

  assert.equal(result.ok, true, result.reason);
  assert.notEqual(result.dbPath, standIn, 'the stand-in is not what the install runs from');
  const db = initDatabase(resolveCurrentDbPath(nominal));
  assert.equal(getServerCount(db), 1, 'and the catalogue is the snapshot, not the stand-in');
  db.close();
  // Nor is it touched on the way past: claiming a candidate before checking it
  // would restart its retention clock on every peer that met it, leaving a file
  // nothing may use and nothing may ever reclaim.
  assert.ok(
    Date.now() - statSync(standIn).mtimeMs > 3_600_000,
    'a refused candidate keeps its mtime, so the sweep can still age it out',
  );
}

// ─── 9. A repair that collides with a peer's name still releases the copy ───

{
  // The unlikely branch of the repair above: the fresh variant name it draws is
  // already taken — by a peer's copy of these very bytes, since anything else is
  // refused. `promoteTo` then adopts rather than creates, and hands the verified
  // download back a second time. Discarding that hand-back leaks ~230MB into the
  // data dir permanently: the temp name is not a snapshot file, so no sweep
  // rule covers it, and the adopted file skips the identity check that would
  // catch the same theft twice.
  const nominal = scratch('repair-collision');
  const folder = join(dir, 'repair-collision');
  const canonical = versionedDbPath(nominal, payloadSha);
  writeFileSync(`${canonical}-wal`, 'still-owned-wal');
  const doomed = join(folder, `data-${payloadSha.slice(0, 16)}-aaaaaa.db`);
  writeFileSync(doomed, gunzipSync(payload));

  // The name the repair will draw, occupied in advance. `variantDbPath` takes
  // its suffix from `Math.random`, so pinning that is what turns a
  // one-in-two-billion collision into something a check can be written for.
  const fixedRandom = 0.4242424242;
  const suffix = fixedRandom.toString(36).slice(2, 8).padEnd(6, '0');
  const collision = join(folder, `data-${payloadSha.slice(0, 16)}-${suffix}.db`);
  writeFileSync(collision, gunzipSync(payload));

  const origin = await startOrigin(serveOk);
  const opened = [];
  const realRandom = Math.random;
  Math.random = () => fixedRandom;
  let result;
  try {
    result = await bootstrapFromSnapshot({
      baseUrl: origin.base,
      dbPath: nominal,
      force: true,
      activate: async (path) => {
        if (opened.length === 0) {
          // The unlink a sweep pass would do, done directly: `retainHours: 0`
          // would take the peer's fresh copy at the drawn name with it, and
          // that copy is the whole point of the fixture. Block 5 covers the
          // sweep interleaving itself.
          rmSync(doomed);
        }
        const db = initDatabase(path);
        opened.push({ path, servers: getServerCount(db) });
        db.close();
      },
    });
  } finally {
    Math.random = realRandom;
    await origin.close();
  }

  assert.equal(result.ok, true, result.reason);
  assert.equal(opened.at(-1).path, collision, "the repair lands on the peer's copy");
  assert.equal(opened.at(-1).servers, 1, 'and it is the real snapshot');
  assert.equal(result.dbPath, collision, 'which is what the bootstrap reports');
  assert.deepEqual(
    readdirSync(folder).filter((f) => f.includes('.download-')),
    [],
    'and the verified download is released, not left behind for nothing to reclaim',
  );
}

// ─── 10. A stand-in at the *canonical* name is not the snapshot either ──────

{
  // The variant scan is not the only way to meet one. `data-<sha16>.db` is a
  // name the sweep can reclaim and `initDatabase` can recreate just as easily,
  // and adoption there is the very first thing `promoteDownload` tries — before
  // any sidecar probe, before any scan. Trusting the name at that point hands
  // the caller an empty catalogue by the shortest route there is.
  const nominal = scratch('standin-canonical');
  const canonical = versionedDbPath(nominal, payloadSha);
  initDatabase(canonical).close();
  assert.equal(
    statSync(canonical).size,
    gunzipSync(payload).length,
    'the fixture must be a real database indistinguishable by length',
  );

  const origin = await startOrigin(serveOk);
  const result = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    force: true,
    activate: (path) => initDatabase(path).close(),
  });
  await origin.close();

  assert.equal(result.ok, true, result.reason);
  assert.notEqual(result.dbPath, canonical, 'the install does not run from the stand-in');
  const db = initDatabase(resolveCurrentDbPath(nominal));
  assert.equal(getServerCount(db), 1, 'and the catalogue is the snapshot');
  db.close();
}

// ─── 11. What a candidate has to match, at snapshot scale ──────────────────

{
  // The two checks above run against ~53KB fixtures, where one sampled window
  // covers the whole file and length adds nothing. At snapshot scale they are
  // different questions, so both are asked of a candidate built to pass the
  // other: a file 200KB long, deliberately not a database, because what is
  // under test here is the evidence `adopt` demands and nothing else.
  const body = Buffer.alloc(200 * 1024, 0x61);
  const install = async (name, candidateBytes) => {
    const nominal = scratch(name);
    const folder = join(dir, name);
    const canonical = versionedDbPath(nominal, payloadSha);
    // A stranded journal at the canonical name is what sends an installer to
    // the variant scan in the first place.
    writeFileSync(`${canonical}-wal`, 'still-owned-wal');
    const candidate = join(folder, `data-${payloadSha.slice(0, 16)}-bbbbbb.db`);
    writeFileSync(candidate, candidateBytes);
    ageFile(candidate, 24);
    const download = join(folder, 'data.db.download-999-zzzz');
    writeFileSync(download, body);
    return { candidate, outcome: await promoteDownload(download, canonical) };
  };

  // A truncated copy: every byte it has is the snapshot's, and every window
  // sampled inside it matches, because the offsets are taken from its own
  // length. Only the length itself gives it away.
  const short = await install('adopt-evidence-length', body.subarray(0, body.length - 4096));
  assert.equal(short.outcome.status, 'ok');
  assert.notEqual(
    short.outcome.path,
    short.candidate,
    'a truncated copy that matches everywhere it is sampled is not the snapshot',
  );

  // Identical length, identical opening window, one byte different well past
  // it — which is exactly what a single-window check cannot see.
  const tampered = Buffer.from(body);
  tampered[150 * 1024] = 0x62;
  const inner = await install('adopt-evidence-tail', tampered);
  assert.equal(inner.outcome.status, 'ok');
  assert.notEqual(
    inner.outcome.path,
    inner.candidate,
    'nor is one that differs only past the first sampled window',
  );
  // And once more in the window between the two, which neither of the others
  // reaches — the sample is three windows because two would leave this gap.
  const middled = Buffer.from(body);
  middled[100 * 1024] = 0x62;
  const centre = await install('adopt-evidence-middle', middled);
  assert.equal(centre.outcome.status, 'ok');
  assert.notEqual(
    centre.outcome.path,
    centre.candidate,
    'nor one that differs only between the first window and the last',
  );
  assert.ok(
    Date.now() - statSync(inner.candidate).mtimeMs > 3_600_000,
    'and none of them is claimed on the way past',
  );
}

// ─── 12. A pointer with no file replays no ETag ─────────────────────────────

{
  // Block 6 refuses to call a dangling pointer up to date, and the whole
  // survivability argument for the pointer races rests on the reinstall that
  // follows. A validator undoes it: `If-None-Match` says "I already hold these
  // bytes", and on this path we hold nothing — so an origin that honours it
  // answers 304 truthfully, the install never happens, and the data dir stays
  // wedged on an empty fallback until a *new* digest is published. Block 6
  // passes without this only because its pointer records no ETag.
  const conditional = (etag) => async (req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestFor());
      return;
    }
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', etag });
    res.end(payload);
  };

  const nominal = scratch('dangling-pointer-etag');
  writeFileSync(nominal, 'the fallback, and not the snapshot');
  const dangling = {
    dbFile: `data-${payloadSha.slice(0, 16)}-zzzzzz.db`,
    sha256: payloadSha,
    publishedAt: '2026-08-26T00:00:00.000Z',
    etag: '"c1"',
    installedAt: '2026-08-26T00:00:00.000Z',
    checkedAt: '2026-08-26T00:00:00.000Z',
  };
  await writeSnapshotState(nominal, dangling);

  const origin = await startOrigin(conditional('"c1"'));
  const first = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    refresh: true,
  });
  assert.equal(first.ok, true, `the repair must fetch bytes, not revalidate (${first.reason})`);
  const repaired = initDatabase(resolveCurrentDbPath(nominal));
  assert.equal(getServerCount(repaired), 1, 'one refresh is enough to repair the data dir');
  repaired.close();

  // And the validator is not abandoned where it is true: a pointer whose file
  // *is* on disk still revalidates, and a 304 there really does mean the
  // durable object lags the manifest.
  const held = scratch('held-pointer-etag');
  const otherSha = 'a'.repeat(64);
  const heldFile = versionedDbPath(held, otherSha);
  writeFileSync(heldFile, gunzipSync(payload));
  await writeSnapshotState(held, {
    dbFile: basename(heldFile),
    sha256: otherSha,
    publishedAt: '2026-08-25T00:00:00.000Z',
    etag: '"c1"',
    installedAt: '2026-08-25T00:00:00.000Z',
    checkedAt: '2026-08-25T00:00:00.000Z',
  });
  const revalidated = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: held,
    refresh: true,
  });
  assert.equal(revalidated.ok, false);
  assert.match(
    revalidated.reason,
    /snapshot-not-yet-published/,
    'a file we do hold is still revalidated, and a 304 still reads as a lagging object',
  );
  assert.equal(revalidated.dbPath, heldFile, 'and the caller keeps the file it holds');
  await origin.close();

  // A 304 nobody asked for is a failed download, not a lagging object: with no
  // validator sent and no local copy, "not yet published" would assert we hold
  // bytes we do not have — and would keep asserting it every refresh.
  const unsolicited = scratch('unsolicited-304');
  writeFileSync(unsolicited, 'the fallback, and not the snapshot');
  await writeSnapshotState(unsolicited, { ...dangling, etag: undefined });
  const rude = await startOrigin(conditional(undefined));
  const answer = await bootstrapFromSnapshot({
    baseUrl: rude.base,
    dbPath: unsolicited,
    refresh: true,
  });
  await rude.close();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /download-failed-304/, 'an unbidden 304 is reported as what it is');
}

// ─── 13. Destroying a peer's database takes positive evidence ───────────────

{
  // `discardStandIn` is the one place that unlinks a file it did not create,
  // and the name it unlinks is a name a peer may have re-installed *genuine*
  // bytes under. So the comparison it rests on has three answers, not two:
  // "could not read it" is not "is not the snapshot", and a momentary EMFILE,
  // EIO or a mount that blinked mid-read of ~230MB must not cost somebody
  // their current database.
  const nominal = scratch('discard-evidence');
  const folder = join(dir, 'discard-evidence');
  const bytes = gunzipSync(payload);
  const verified = join(folder, 'data.db.download-999-zzzz');
  writeFileSync(verified, bytes);
  const peerCopy = (name) => {
    const path = join(folder, name);
    writeFileSync(path, bytes);
    return path;
  };

  // Positive evidence, both shapes: a different length, and the same length
  // with different bytes. These are the stand-ins the unlink exists for.
  const truncated = join(folder, 'truncated.db');
  writeFileSync(truncated, bytes.subarray(0, bytes.length - 1));
  await discardStandIn(truncated, verified);
  assert.equal(existsSync(truncated), false, 'a file of the wrong length is a stand-in');

  const tampered = join(folder, 'tampered.db');
  const altered = Buffer.from(bytes);
  altered[altered.length - 1] ^= 0xff;
  writeFileSync(tampered, altered);
  await discardStandIn(tampered, verified);
  assert.equal(existsSync(tampered), false, 'so is one whose bytes differ at the same length');

  // No yardstick: our own verified copy is gone, so nothing about the
  // candidate has been established and nothing may be destroyed.
  const noYardstick = peerCopy('no-yardstick.db');
  await discardStandIn(noYardstick, join(folder, 'never-existed.download'));
  assert.equal(
    existsSync(noYardstick),
    true,
    'with no verified copy to compare against, the peer’s database survives',
  );

  // A transient read failure on the candidate itself — the case the old
  // boolean could not express. EACCES stands in for EMFILE/EIO: `stat`
  // succeeds and agrees on the length, the read is what fails.
  // Named like a real variant, so the sweep below treats it as one.
  const unreadable = peerCopy(`data-${payloadSha.slice(0, 16)}-cccccc.db`);
  chmodSync(unreadable, 0o000);
  let reallyUnreadable = false;
  try {
    closeSync(openSync(unreadable, 'r'));
  } catch {
    reallyUnreadable = true;
  }
  if (reallyUnreadable) {
    await discardStandIn(unreadable, verified);
    assert.equal(
      existsSync(unreadable),
      true,
      'a read that fails is not proof the file is a stand-in',
    );
  } else {
    // Running as root, where mode 000 means nothing. Nothing to assert.
    console.log('  (skipped: EACCES injection needs a non-root user)');
  }
  chmodSync(unreadable, 0o600);

  // And the sweep is what eventually reclaims a stand-in we could not read, so
  // leaving it is a delay, not a leak.
  ageFile(unreadable, 24 * 30);
  await sweepSnapshotFiles(nominal, { retainHours: 0 });
  assert.equal(existsSync(unreadable), false, 'the usual retention clock still ages it out');
}

// ─── 14. An unreadable candidate is not adopted, and not claimed either ─────

{
  // The other half of the tri-state, and the opposite answer: where
  // `discardStandIn` must not destroy on "could not tell", `adopt` must not
  // *trust* on it. Serving a file we could not read a single window of would
  // be adoption on the strength of its name alone — the very thing the size
  // and sample checks exist to stop. Declining costs one download.
  const nominal = scratch('adopt-unreadable');
  const folder = join(dir, 'adopt-unreadable');
  const canonical = versionedDbPath(nominal, payloadSha);
  writeFileSync(`${canonical}-wal`, 'still-owned-wal');
  const bytes = gunzipSync(payload);
  const variant = join(folder, `data-${payloadSha.slice(0, 16)}-dddddd.db`);
  writeFileSync(variant, bytes);
  ageFile(variant, 24);
  const before = statSync(variant).mtimeMs;

  chmodSync(variant, 0o000);
  let reallyUnreadable = false;
  try {
    closeSync(openSync(variant, 'r'));
  } catch {
    reallyUnreadable = true;
  }
  if (reallyUnreadable) {
    const download = join(folder, 'data.db.download-888-yyyy');
    writeFileSync(download, bytes);
    const outcome = await promoteDownload(download, canonical);
    chmodSync(variant, 0o600);
    assert.equal(outcome.status, 'ok');
    assert.notEqual(outcome.path, variant, 'a candidate we could not read is not adopted');
    assert.equal(
      statSync(variant).mtimeMs,
      before,
      'nor claimed on the way past — claiming restarts a retention clock on a file we refused',
    );

    // The same refusal at the *canonical* name, which no variant scan gates:
    // there `adopt` is the only thing standing between an unreadable file and
    // the caller opening it as the snapshot.
    const other = scratch('adopt-unreadable-canonical');
    const home = versionedDbPath(other, payloadSha);
    writeFileSync(home, bytes);
    chmodSync(home, 0o000);
    const spare = join(dir, 'adopt-unreadable-canonical', 'data.db.download-777-xxxx');
    writeFileSync(spare, bytes);
    const taken = await promoteDownload(spare, home);
    chmodSync(home, 0o600);
    assert.equal(taken.status, 'ok');
    assert.notEqual(taken.path, home, 'the canonical name is refused on the same evidence');
  } else {
    chmodSync(variant, 0o600);
    console.log('  (skipped: EACCES injection needs a non-root user)');
  }
}

console.log('snapshot adoption checks passed');
