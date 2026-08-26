import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { runSnapshotBrotliChecks } from './snapshot-brotli-checks.mjs';
import { runSnapshotJournalChecks } from './snapshot-journal-checks.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mcpf-snapshot-bootstrap-'));
process.env.MCPFINDER_DATA_DIR = dir;

const {
  bootstrapFromSnapshot,
  initDatabase,
  isSyncNeeded,
  getServerCount,
  markSnapshotInstalled,
  readSnapshotState,
  writeSnapshotState,
  snapshotStatePath,
  resolveCurrentDbPath,
  versionedDbPath,
  sweepSnapshotFiles,
} = await import('../packages/core/dist/index.js');
const { createCatalog } = await import('../packages/mcp-server/dist/catalog.js');

// ─── Fixtures ───────────────────────────────────────────────────────────────

/** Build a real SQLite file with `rows` server rows, and return its gzipped bytes. */
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

const payload = buildSnapshotPayload('snap');
const payloadSha = createHash('sha256').update(payload).digest('hex');
const ETAG = '"snapshot-v1"';

const payload2 = buildSnapshotPayload('snap2', 2);
const payload2Sha = createHash('sha256').update(payload2).digest('hex');
const ETAG2 = '"snapshot-v2"';

function manifestFor(sha = payloadSha, overrides = {}) {
  const manifest = {
    publishedAt: '2026-08-26T00:00:00.000Z',
    serverCount: 1,
    sha256: sha,
    sizeBytes: payload.length,
    url: `data.sqlite.gz?sha=${sha}`,
    ...overrides,
  };
  for (const [key, value] of Object.entries(manifest)) {
    if (value === undefined) delete manifest[key];
  }
  return JSON.stringify(manifest);
}

/** Start an HTTP snapshot origin; returns { base, close, stats }. */
async function startOrigin(handler) {
  const stats = { manifest: 0, data: 0 };
  const server = createServer((req, res) => {
    if (req.url.startsWith('/manifest.json')) stats.manifest += 1;
    else stats.data += 1;
    handler(req, res, stats);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    stats,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

function serveOk(req, res) {
  if (req.url.startsWith('/manifest.json')) {
    res.writeHead(200, { 'content-type': 'application/json', etag: '"m1"' });
    res.end(manifestFor());
    return;
  }
  if (req.headers['if-none-match'] === ETAG) {
    res.writeHead(304, { etag: ETAG });
    res.end();
    return;
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream', etag: ETAG });
  res.end(payload);
}

function tmpDownloads(target, where = dir) {
  return readdirSync(where).filter((f) => f.startsWith(`${target}.download-`));
}

/** A scratch data dir of its own, so directory-wide sweeps stay isolated. */
function scratch(name) {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return join(path, 'data.db');
}

function ageFile(path, hours) {
  const when = new Date(Date.now() - hours * 3_600_000);
  utimesSync(path, when, when);
}

// ─── 1. Happy path: versioned install, pointer, provenance ──────────────────

{
  const origin = await startOrigin(serveOk);
  const nominal = scratch('happy');
  const result = await bootstrapFromSnapshot({ baseUrl: origin.base, dbPath: nominal });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.servers, 1);
  assert.ok(result.bytesDownloaded > 0);

  // The download became a sha-named file; the nominal path was never written.
  const installed = versionedDbPath(nominal, payloadSha);
  assert.equal(result.dbPath, installed);
  assert.ok(existsSync(installed));
  assert.equal(existsSync(nominal), false, 'the nominal path is never written to');
  assert.equal(resolveCurrentDbPath(nominal), installed);
  assert.equal(getServerCount(initDatabase(installed)), 1);

  const state = await readSnapshotState(nominal);
  assert.equal(state.sha256, payloadSha);
  assert.equal(state.etag, ETAG);
  assert.equal(state.dbFile, `data-${payloadSha.slice(0, 16)}.db`);
  assert.equal(state.publishedAt, '2026-08-26T00:00:00.000Z');
  assert.ok(existsSync(snapshotStatePath(nominal)));

  // A current install is left alone unless force/refresh is requested.
  const again = await bootstrapFromSnapshot({ baseUrl: origin.base, dbPath: nominal });
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'db-already-exists');

  // Refresh: manifest sha matches the pointer → no file download at all.
  const before = origin.stats.data;
  const refreshed = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    refresh: true,
  });
  assert.equal(refreshed.reason, 'snapshot-up-to-date');
  assert.equal(origin.stats.data, before, 'up-to-date check must not re-download the DB');

  await origin.close();
}

// ─── 2. A 304 on a sha we do not have does not suppress the next retry ──────

{
  // The manifest advertises a newer sha while the durable gz still serves the
  // old bytes — the documented publication lag. Recording a successful check
  // here would silence the retry for a whole refresh interval.
  const origin = await startOrigin((req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestFor(payload2Sha));
      return;
    }
    res.writeHead(304, { etag: ETAG });
    res.end();
  });
  const nominal = scratch('lagging');
  const installed = versionedDbPath(nominal, payloadSha);
  writeFileSync(installed, 'current-db-bytes');
  const before = {
    dbFile: `data-${payloadSha.slice(0, 16)}.db`,
    sha256: payloadSha,
    publishedAt: '2026-08-25T00:00:00.000Z',
    etag: ETAG,
    installedAt: '2026-08-25T00:00:00.000Z',
    checkedAt: '2026-08-25T00:00:00.000Z',
  };
  await writeSnapshotState(nominal, before);

  const result = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    refresh: true,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'snapshot-not-yet-published');
  const after = await readSnapshotState(nominal);
  assert.equal(after.checkedAt, before.checkedAt, 'a lagging 304 must not stamp checkedAt');
  assert.equal(after.sha256, payloadSha, 'and must not adopt the unreceived sha');
  await origin.close();
}

// ─── 3. A manifest we cannot verify against is rejected outright ────────────

for (const [label, sha] of [
  ['missing sha256', undefined],
  ['short sha256', 'abc123'],
  ['non-hex sha256', 'z'.repeat(64)],
]) {
  const origin = await startOrigin((req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestFor(sha, sha === undefined ? { sha256: undefined } : {}));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(payload);
  });
  const nominal = scratch(`badmanifest-${label.split(' ')[0]}`);
  const result = await bootstrapFromSnapshot({ baseUrl: origin.base, dbPath: nominal });
  assert.equal(result.ok, false, label);
  assert.equal(result.reason, 'manifest-fetch-failed', label);
  assert.equal(origin.stats.data, 0, `${label}: unverifiable bytes must never be fetched`);
  assert.deepEqual(readdirSync(join(dir, `badmanifest-${label.split(' ')[0]}`)), [], label);
  await origin.close();
}

// A well-formed uppercase digest is accepted and normalised.
{
  const origin = await startOrigin((req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestFor(payloadSha.toUpperCase()));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(payload);
  });
  const nominal = scratch('upper');
  const result = await bootstrapFromSnapshot({ baseUrl: origin.base, dbPath: nominal });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.dbPath, versionedDbPath(nominal, payloadSha));
  await origin.close();
}

// ─── 4. Network failure never throws ────────────────────────────────────────

{
  // Nothing listening: the manifest request fails at the transport layer.
  const dead = await startOrigin(serveOk);
  const base = dead.base;
  await dead.close();

  const nominal = scratch('dead');
  const result = await bootstrapFromSnapshot({ baseUrl: base, dbPath: nominal });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'manifest-fetch-failed');
  assert.equal(existsSync(nominal), false);
}

{
  // Manifest fine, DB endpoint erroring.
  const origin = await startOrigin((req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestFor());
      return;
    }
    res.writeHead(503).end('nope');
  });
  const result = await bootstrapFromSnapshot({ baseUrl: origin.base, dbPath: scratch('err') });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'download-failed-503');
  await origin.close();
}

{
  // Connection reset mid-body.
  const origin = await startOrigin((req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestFor());
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(payload.subarray(0, 10));
    res.socket.destroy();
  });
  const nominal = scratch('reset');
  const result = await bootstrapFromSnapshot({ baseUrl: origin.base, dbPath: nominal });
  assert.equal(result.ok, false);
  assert.match(result.reason, /download-error|decompress-failed/);
  assert.equal(existsSync(versionedDbPath(nominal, payloadSha)), false);
  assert.deepEqual(tmpDownloads('data.db', join(dir, 'reset')), []);
  await origin.close();
}

// ─── 5. Manifest timeout ────────────────────────────────────────────────────

{
  const origin = await startOrigin((req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(manifestFor());
      }, 2_000).unref();
      return;
    }
    res.writeHead(500).end();
  });
  const started = Date.now();
  const result = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: scratch('slow-manifest'),
    manifestTimeoutMs: 100,
  });
  assert.equal(result.reason, 'manifest-fetch-failed');
  assert.ok(Date.now() - started < 1_500, 'manifest timeout must not wait for the response');
  await origin.close();
}

// ─── 6. Stalled DL: aborted on inactivity, not on total elapsed time ────────

{
  const origin = await startOrigin((req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestFor());
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.write(payload.subarray(0, 8)); // then never another byte
  });
  const nominal = scratch('stalled');
  const result = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    stallTimeoutMs: 150,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /download-stalled/);
  assert.equal(existsSync(versionedDbPath(nominal, payloadSha)), false);
  assert.deepEqual(tmpDownloads('data.db', join(dir, 'stalled')), []);
  await origin.close();
}

{
  // Slow but progressing: chunks spaced under the stall budget must succeed
  // even though the total transfer exceeds it.
  const origin = await startOrigin(async (req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestFor());
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    const step = Math.ceil(payload.length / 6);
    for (let offset = 0; offset < payload.length; offset += step) {
      res.write(payload.subarray(offset, offset + step));
      await new Promise((r) => setTimeout(r, 60));
    }
    res.end();
  });
  const progress = [];
  const result = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: scratch('slow-progress'),
    stallTimeoutMs: 200,
    onProgress: (bytes, total) => progress.push([bytes, total]),
  });
  assert.equal(result.ok, true, result.reason);
  assert.ok(progress.length > 1, 'progress is reported incrementally');
  assert.equal(progress.at(-1)[1], payload.length);
  await origin.close();
}

// ─── 7. A throwing onProgress cannot escape the stream handler ──────────────

{
  const origin = await startOrigin(serveOk);
  const nominal = scratch('bad-progress');
  const uncaught = [];
  const onUncaught = (err) => uncaught.push(err);
  process.on('uncaughtException', onUncaught);

  const result = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    onProgress: () => {
      throw new Error('callback exploded');
    },
  });
  // Give any escaped exception a turn of the loop to surface.
  await new Promise((r) => setTimeout(r, 50));
  process.off('uncaughtException', onUncaught);

  assert.deepEqual(uncaught, [], 'a progress callback must never kill the process');
  assert.equal(result.ok, true, result.reason);
  assert.ok(existsSync(versionedDbPath(nominal, payloadSha)));
  await origin.close();
}

// ─── 8. Checksum mismatch leaves the existing DB untouched ──────────────────

{
  const origin = await startOrigin((req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestFor('0'.repeat(64)));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream' });
    res.end(payload);
  });
  const nominal = scratch('mismatch');
  writeFileSync(nominal, 'existing-db-bytes');
  const result = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    force: true,
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /^sha256-mismatch/);
  assert.equal(readFileSync(nominal, 'utf8'), 'existing-db-bytes');
  assert.deepEqual(tmpDownloads('data.db', join(dir, 'mismatch')), []);
  await origin.close();
}

// ─── 9. Migration: an existing data.db stays current until a newer snapshot ─

{
  let serveSecond = false;
  const origin = await startOrigin((req, res) => {
    const sha = serveSecond ? payload2Sha : payloadSha;
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestFor(sha, { sizeBytes: serveSecond ? payload2.length : payload.length }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      etag: serveSecond ? ETAG2 : ETAG,
    });
    res.end(serveSecond ? payload2 : payload);
  });

  // A pre-versioning install: a real data.db plus a sidecar with no dbFile.
  const nominal = scratch('migrate');
  const legacyDb = initDatabase(nominal);
  legacyDb
    .prepare("INSERT INTO servers (id, slug, name, description) VALUES ('legacy','legacy','legacy','')")
    .run();
  legacyDb.close();
  const legacyBytes = readFileSync(nominal);
  await writeSnapshotState(nominal, {
    sha256: payloadSha,
    publishedAt: '2026-08-25T00:00:00.000Z',
    etag: ETAG,
    installedAt: '2026-08-25T00:00:00.000Z',
    checkedAt: '2026-08-25T00:00:00.000Z',
  });

  // Same sha as the manifest: no download, and data.db remains the current DB.
  assert.equal(resolveCurrentDbPath(nominal), nominal);
  const held = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    refresh: true,
  });
  assert.equal(held.reason, 'snapshot-up-to-date');
  assert.equal(origin.stats.data, 0, 'content we already have is not re-downloaded to migrate');
  assert.equal(resolveCurrentDbPath(nominal), nominal);

  // A genuinely newer snapshot performs the migration.
  serveSecond = true;
  const moved = await bootstrapFromSnapshot({
    baseUrl: origin.base,
    dbPath: nominal,
    refresh: true,
  });
  assert.equal(moved.ok, true, moved.reason);
  assert.equal(moved.dbPath, versionedDbPath(nominal, payload2Sha));
  assert.equal(resolveCurrentDbPath(nominal), versionedDbPath(nominal, payload2Sha));
  // The legacy file — possibly open in a peer process — is neither renamed nor
  // deleted nor rewritten.
  assert.ok(existsSync(nominal), 'the legacy data.db is left in place');
  assert.deepEqual(readFileSync(nominal), legacyBytes, 'and is left byte-identical');
  await origin.close();
}

// ─── 10. Sweeping: current file, peer temp files and young files survive ────

{
  const nominal = scratch('sweep');
  const currentSha = 'a'.repeat(64);
  const oldSha = 'b'.repeat(64);
  const current = versionedDbPath(nominal, currentSha);
  const superseded = versionedDbPath(nominal, oldSha);
  const young = versionedDbPath(nominal, 'c'.repeat(64));

  writeFileSync(current, 'current');
  writeFileSync(superseded, 'old');
  writeFileSync(`${superseded}-wal`, 'old-wal');
  writeFileSync(young, 'young');
  writeFileSync(nominal, 'legacy');
  // Two temp downloads: one abandoned long ago, one a peer is writing right now.
  const staleTmp = join(dir, 'sweep', 'data.db.download-1234-aaaaaaaa');
  const peerTmp = join(dir, 'sweep', 'data.db.download-5678-bbbbbbbb');
  writeFileSync(staleTmp, 'abandoned');
  writeFileSync(peerTmp, 'in flight');

  await writeSnapshotState(nominal, {
    dbFile: `data-${currentSha.slice(0, 16)}.db`,
    sha256: currentSha,
    publishedAt: '2026-08-26T00:00:00.000Z',
    installedAt: '2026-08-26T00:00:00.000Z',
    checkedAt: '2026-08-26T00:00:00.000Z',
  });

  for (const path of [current, superseded, `${superseded}-wal`, nominal, staleTmp]) {
    ageFile(path, 100);
  }

  await sweepSnapshotFiles(nominal, { retainHours: 48, downloadStaleHours: 6 });

  assert.ok(existsSync(current), 'the current DB is never swept, at any age');
  assert.ok(existsSync(young), 'a superseded file inside the grace period survives');
  assert.ok(existsSync(peerTmp), "a peer's in-flight download is never swept");
  assert.equal(existsSync(staleTmp), false, 'an abandoned download is reclaimed');
  assert.equal(existsSync(superseded), false, 'an aged superseded file is reclaimed');
  assert.ok(
    existsSync(`${superseded}-wal`),
    'but never its journal — a peer that still has the file open reaches for it by name',
  );
  assert.equal(existsSync(nominal), false, 'and so is an aged, superseded legacy data.db');
}

{
  // With no pointer at all, data.db *is* the current DB and must survive.
  const nominal = scratch('sweep-legacy-current');
  writeFileSync(nominal, 'legacy');
  ageFile(nominal, 1_000);
  await sweepSnapshotFiles(nominal, { retainHours: 1 });
  assert.ok(existsSync(nominal), 'an unsuperseded data.db is the current DB');
}

// ─── 11. A fresh snapshot counts as a fresh sync ────────────────────────────

{
  const db = initDatabase(join(dir, 'sync-state.db'));
  const stale = new Date(Date.now() - 48 * 3_600_000).toISOString();
  db.prepare(
    `INSERT INTO sync_log (source, last_synced_at, last_successful_at, server_count, status)
     VALUES ('official', ?, ?, 10, 'ok')`,
  ).run(stale, stale);

  // CI-built sync_log alone looks ancient → a live sync would fire immediately.
  assert.equal(isSyncNeeded(db), true);

  markSnapshotInstalled(db, 84_647);
  assert.equal(isSyncNeeded(db), false, 'a just-installed snapshot is fresh data');

  // Genuinely old data is still detected once the snapshot window lapses.
  assert.equal(isSyncNeeded(db, 15, 0), true);

  const old = new Date(Date.now() - 24 * 3_600_000).toISOString();
  db.prepare("UPDATE sync_log SET last_synced_at = ? WHERE source = 'snapshot'").run(old);
  assert.equal(isSyncNeeded(db), true);
  db.close();
}

// ─── Catalog harness ────────────────────────────────────────────────────────

/**
 * Wire a catalog the way the server does — the handle is sampled fresh on every
 * access, and the catalog is constructed before the empty DB file exists.
 */
function makeCatalog(nominal, origin, overrides = {}) {
  const logs = [];
  const handles = [];
  const state = { db: null, opens: 0 };
  const catalog = createCatalog({
    dbPath: nominal,
    baseUrl: origin?.base,
    lingerMs: 0,
    openDb: (path) => {
      state.opens += 1;
      if (overrides.openDb) return overrides.openDb(path, state.opens);
      const handle = initDatabase(path);
      handles.push(handle);
      return handle;
    },
    getDb: () => state.db,
    setDb: (next) => {
      state.db = next;
    },
    quiesce: overrides.quiesce,
    refreshHours: overrides.refreshHours,
    log: (message) => logs.push(message),
  });
  // Exactly as the real entry point does: the path the catalog resolved once.
  state.db = initDatabase(catalog.currentDbPath);
  handles.push(state.db);
  return { catalog, state, logs, handles };
}

/** An origin whose DB body is released only when the returned gate is opened. */
async function gatedOrigin() {
  let open;
  const gate = new Promise((resolve) => {
    open = resolve;
  });
  const origin = await startOrigin(async (req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestFor());
      return;
    }
    res.writeHead(200, { 'content-type': 'application/octet-stream', etag: ETAG });
    res.write(payload.subarray(0, 4));
    await gate;
    res.end(payload.subarray(4));
  });
  return { ...origin, open: () => open() };
}

// ─── 12. Tool calls mid-download get a notice, not a hang ───────────────────

{
  const origin = await gatedOrigin();
  const nominal = scratch('catalog');
  const { catalog, state, logs } = makeCatalog(nominal, origin);

  catalog.start();
  await new Promise((r) => setTimeout(r, 150));

  const notice = await catalog.waitUntilUsable();
  assert.ok(notice, 'an empty catalog mid-download must answer instead of hanging');
  assert.match(notice, /still downloading/i);
  assert.match(notice, /retry/i);
  assert.equal(getServerCount(state.db), 0);

  origin.open();
  await catalog.settled();

  // The handle was switched in place: no restart, full data, install stamped.
  assert.equal(await catalog.waitUntilUsable(), null);
  assert.equal(getServerCount(state.db), 1);
  assert.equal(isSyncNeeded(state.db), false);
  assert.ok(logs.some((line) => line.includes('Bootstrapped from snapshot')), logs.join(''));
  assert.equal(resolveCurrentDbPath(nominal), versionedDbPath(nominal, payloadSha));
  await origin.close();
}

// ─── 13. A tool call concurrent with the switch is served, not blocked ──────

{
  const origin = await startOrigin(serveOk);
  const nominal = scratch('concurrent');
  let quiesceEntered;
  const entered = new Promise((resolve) => {
    quiesceEntered = resolve;
  });
  const { catalog, state } = makeCatalog(nominal, origin, {
    // Stands in for a live sync that takes far longer than any tool-call
    // timeout — the old DB is fully usable throughout, so nothing may wait.
    quiesce: async () => {
      quiesceEntered();
      await new Promise((r) => setTimeout(r, 600));
    },
  });

  const seeded = state.db;
  seeded
    .prepare("INSERT INTO servers (id, slug, name, description) VALUES ('old','old','old','')")
    .run();

  catalog.start();
  await entered;

  const started = Date.now();
  const notice = await catalog.waitUntilUsable();
  const count = getServerCount(state.db);
  const elapsed = Date.now() - started;

  assert.equal(notice, null, 'a usable DB never returns a notice mid-switch');
  assert.equal(count, 1, 'the old handle keeps serving until the new one is published');
  assert.ok(elapsed < 250, `a tool call must not wait for quiesce (waited ${elapsed}ms)`);

  await catalog.settled();
  assert.equal(getServerCount(state.db), 1, 'and the new handle serves the snapshot');
  assert.equal(state.db === seeded, false, 'the handle was actually replaced');
  await origin.close();
}

// ─── 14. A failed open of the new file leaves the old handle serving ────────

{
  const origin = await startOrigin(serveOk);
  const nominal = scratch('open-fails');
  const { catalog, state, logs } = makeCatalog(nominal, origin, {
    // The catalog only calls openDb to take up a new snapshot file.
    openDb: () => {
      throw new Error('cannot open new snapshot');
    },
  });
  const seeded = state.db;
  seeded
    .prepare("INSERT INTO servers (id, slug, name, description) VALUES ('old','old','old','')")
    .run();

  catalog.start();
  await catalog.settled();

  assert.equal(state.db, seeded, 'the handle is not replaced when the new file will not open');
  assert.equal(getServerCount(state.db), 1, 'and the old handle is still alive');
  assert.equal(await catalog.waitUntilUsable(), null);
  assert.ok(
    logs.some((line) => line.includes('activate-failed')),
    logs.join(''),
  );
  // The pointer stayed on the old database: nothing switched.
  const stateFile = await readSnapshotState(nominal);
  assert.equal(stateFile, null, 'a failed activation never writes the pointer');
  await origin.close();
}

// ─── 15. A rejected quiesce aborts the switch without closing anything ──────

{
  const origin = await startOrigin(serveOk);
  const nominal = scratch('quiesce-fails');
  const { catalog, state, logs } = makeCatalog(nominal, origin, {
    quiesce: async () => {
      throw new Error('sync would not settle');
    },
  });
  const seeded = state.db;
  seeded
    .prepare("INSERT INTO servers (id, slug, name, description) VALUES ('old','old','old','')")
    .run();

  catalog.start();
  await catalog.settled();

  assert.equal(state.db, seeded, 'the handle is untouched when quiesce rejects');
  assert.equal(getServerCount(state.db), 1, 'the old handle was never closed');
  assert.equal(catalog.isBusy(), false);
  assert.ok(
    logs.some((line) => line.includes('activate-failed')),
    logs.join(''),
  );
  assert.equal(await readSnapshotState(nominal), null);
  await origin.close();
}

// ─── 16. REFRESH_HOURS=0 disables re-checks, never the first bootstrap ──────

{
  const origin = await startOrigin(serveOk);
  const nominal = scratch('refresh-zero');
  const { catalog, state } = makeCatalog(nominal, origin, { refreshHours: 0 });
  catalog.start();
  await catalog.settled();
  assert.equal(getServerCount(state.db), 1, 'refreshHours=0 must not block the first bootstrap');
  assert.ok(origin.stats.data > 0);
  await origin.close();
}

{
  // An install that already carries a pointer does *not* re-check when disabled.
  const origin = await startOrigin(serveOk);
  const nominal = scratch('refresh-zero-installed');
  writeFileSync(
    versionedDbPath(nominal, payloadSha),
    readFileSync(join(dir, 'happy', `data-${payloadSha.slice(0, 16)}.db`)),
  );
  await writeSnapshotState(nominal, {
    dbFile: `data-${payloadSha.slice(0, 16)}.db`,
    sha256: payloadSha,
    publishedAt: '2026-08-25T00:00:00.000Z',
    installedAt: '2026-08-25T00:00:00.000Z',
    checkedAt: '2020-01-01T00:00:00.000Z', // ancient: would refresh if enabled
  });
  const { catalog } = makeCatalog(nominal, origin, { refreshHours: 0 });
  catalog.start();
  await catalog.settled();
  assert.equal(origin.stats.manifest, 0, 'refreshHours=0 suppresses periodic re-checks');
  await origin.close();
}

// ─── 17. An upgrading install with no pointer bootstraps immediately ────────

{
  const origin = await startOrigin(serveOk);
  const nominal = scratch('upgrade');
  const legacy = initDatabase(nominal);
  legacy
    .prepare("INSERT INTO servers (id, slug, name, description) VALUES ('old','old','old','')")
    .run();
  legacy.close();

  const { catalog, state } = makeCatalog(nominal, origin, { refreshHours: 0 });
  catalog.start();
  await catalog.settled();
  assert.equal(resolveCurrentDbPath(nominal), versionedDbPath(nominal, payloadSha));
  assert.equal(getServerCount(state.db), 1);
  await origin.close();
}

// ─── 18. MCPFINDER_DISABLE_SNAPSHOT keeps the network out of the picture ────

{
  process.env.MCPFINDER_DISABLE_SNAPSHOT = '1';
  const origin = await startOrigin(serveOk);
  const nominal = scratch('disabled');
  const { catalog } = makeCatalog(nominal, origin);
  catalog.start();
  await catalog.settled();
  assert.equal(origin.stats.manifest, 0);
  assert.equal(await catalog.waitUntilUsable(), null);
  delete process.env.MCPFINDER_DISABLE_SNAPSHOT;
  await origin.close();
}

// ─── 19. Two processes on one data dir do not disturb each other ────────────

{
  const origin = await startOrigin(serveOk);
  const nominal = scratch('peers');

  // Peer B is mid-download when peer A starts up and sweeps.
  const peerTmp = join(dir, 'peers', 'data.db.download-4242-cccccccc');
  writeFileSync(peerTmp, 'peer bytes');

  const a = makeCatalog(nominal, origin);
  a.catalog.start();
  await a.catalog.settled();
  assert.ok(existsSync(peerTmp), "start-up sweep must not touch a peer's in-flight download");

  const installed = versionedDbPath(nominal, payloadSha);
  assert.equal(resolveCurrentDbPath(nominal), installed);

  // Peer B now starts against the same dir: it finds the pointer, opens the
  // same file, and neither process rewrote or removed anything of the other's.
  const b = makeCatalog(nominal, origin);
  b.catalog.start();
  await b.catalog.settled();
  assert.ok(existsSync(installed), 'the current DB survives a second process starting');
  assert.equal(getServerCount(a.state.db), 1);
  assert.equal(getServerCount(b.state.db), 1);
  assert.equal(origin.stats.data, 1, 'the second process reuses the installed snapshot');
  await origin.close();
}

// ─── 20. The server reaches `initialize` even when the snapshot origin is down ─

{
  // A dead origin used to propagate out of the top-level await and kill the
  // process before the transport was connected.
  const dead = await startOrigin(serveOk);
  const base = dead.base;
  await dead.close();

  const serverDir = join(dir, 'handshake');
  const child = spawn(process.execPath, ['packages/mcp-server/dist/cli.js'], {
    cwd: new URL('..', import.meta.url).pathname,
    env: {
      ...process.env,
      MCPFINDER_DATA_DIR: serverDir,
      MCPFINDER_SNAPSHOT_BASE: base,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr = [];
  child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    })}\n`,
  );

  const response = await Promise.race([
    new Promise((resolve) => {
      let buffered = '';
      child.stdout.on('data', (chunk) => {
        buffered += chunk;
        const line = buffered.split('\n').find((l) => l.trim().startsWith('{'));
        if (line) resolve(JSON.parse(line));
      });
    }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`handshake timed out: ${stderr.join('')}`)), 15_000).unref(),
    ),
    new Promise((_, reject) =>
      child.on('exit', (code) =>
        reject(new Error(`server exited with ${code}: ${stderr.join('')}`)),
      ),
    ),
  ]);
  assert.equal(response.id, 1);
  assert.equal(response.result.serverInfo.name, 'mcpfinder');
  child.kill('SIGKILL');
}

await runSnapshotJournalChecks(dir);
await runSnapshotBrotliChecks(dir);

rmSync(dir, { recursive: true, force: true });
console.log('snapshot bootstrap checks passed');
