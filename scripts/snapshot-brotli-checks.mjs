/**
 * Dual-artifact bootstrap: the brotli object is preferred when the manifest
 * announces one, verified against its *own* digest, and never load-bearing —
 * a 404, a corrupt stream, a wrong digest or a malformed manifest block all
 * degrade to the gzip artifact instead of failing the bootstrap.
 *
 * Also pins the things that go quietly wrong with two artifacts: the ETag
 * written into the pointer must describe the object actually downloaded, both
 * decompression paths must install a byte-identical database, a cancelled run
 * must not fall through to a full gz download, transfer accounting must cover
 * the abandoned attempt too, decompression must stay bounded, and an artifact
 * URL must not leave the configured base.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

const GZ_ETAG = '"gz-v1"';
const BR_ETAG = '"br-v1"';

/** Start an HTTP snapshot origin counting requests per artifact. */
async function startOrigin(handler) {
  const hits = { manifest: 0, br: 0, gz: 0 };
  const server = createServer((req, res) => {
    if (req.url.startsWith('/manifest.json')) hits.manifest += 1;
    else if (req.url.startsWith('/data.sqlite.br')) hits.br += 1;
    else hits.gz += 1;
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

export async function runSnapshotBrotliChecks(root) {
  const {
    bootstrapFromSnapshot,
    fetchSnapshotManifest,
    getServerCount,
    initDatabase,
    readSnapshotState,
    versionedDbPath,
  } = await import('../packages/core/dist/index.js');

  /** Open, assert, close — never leave a journal beside an installed file. */
  function withDatabase(path, assertions) {
    const db = initDatabase(path);
    try {
      assertions(db);
    } finally {
      db.close();
    }
  }

  /** A scratch data dir of its own, so directory-wide sweeps stay isolated. */
  function scratch(name) {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return join(path, 'data.db');
  }

  // One database, two encodings — exactly what the builder publishes.
  const rawPath = join(root, 'brotli-src.db');
  {
    const db = initDatabase(rawPath);
    for (let i = 0; i < 3; i += 1) {
      db.prepare("INSERT INTO servers (id, slug, name, description) VALUES (?, ?, ?, '')").run(
        `io.example/br-${i}`,
        `br-${i}`,
        `io.example/br-${i}`,
      );
    }
    db.close();
  }
  const raw = readFileSync(rawPath);
  const gz = gzipSync(raw);
  const gzSha = createHash('sha256').update(gz).digest('hex');
  const br = brotliCompressSync(raw);
  const brSha = createHash('sha256').update(br).digest('hex');
  assert.notEqual(brSha, gzSha, 'the two artifacts must have distinct digests');

  /** The manifest a post-1.3.0 builder publishes, with per-case overrides. */
  function manifestBody(overrides = {}) {
    return JSON.stringify({
      publishedAt: '2026-08-26T00:00:00.000Z',
      serverCount: 3,
      sha256: gzSha,
      sizeBytes: gz.length,
      url: `data.sqlite.gz?sha=${gzSha}`,
      brotli: { url: `data.sqlite.br?sha=${brSha}`, sha256: brSha, sizeBytes: br.length },
      ...overrides,
    });
  }

  /**
   * `brotli` decides what the manifest advertises and what the .br endpoint
   * does: 'ok', 'missing' (404), 'corrupt' (not brotli at all), 'wrong-digest'
   * (an advertised digest the served bytes do not have), 'malformed' (an
   * unusable brotli block) or 'absent' (a pre-1.3.0 manifest).
   */
  async function dualOrigin(brotli, { gzip = 'ok' } = {}) {
    return startOrigin((req, res) => {
      if (req.url.startsWith('/manifest.json')) {
        const manifest = {
          publishedAt: '2026-08-26T00:00:00.000Z',
          serverCount: 3,
          sha256: gzSha,
          sizeBytes: gz.length,
          url: `data.sqlite.gz?sha=${gzSha}`,
        };
        if (brotli === 'malformed') {
          manifest.brotli = { url: `data.sqlite.br?sha=${brSha}`, sha256: 'nope', sizeBytes: 1 };
        } else if (brotli !== 'absent') {
          const advertised = brotli === 'wrong-digest' ? gzSha : brSha;
          manifest.brotli = {
            url: `data.sqlite.br?sha=${advertised}`,
            sha256: advertised,
            sizeBytes: br.length,
          };
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(manifest));
        return;
      }
      if (req.url.startsWith('/data.sqlite.br')) {
        if (brotli === 'missing') {
          res.writeHead(404);
          res.end();
          return;
        }
        res.writeHead(200, { etag: BR_ETAG });
        res.end(brotli === 'corrupt' ? Buffer.from('not brotli at all') : br);
        return;
      }
      if (gzip === 'missing') {
        res.writeHead(500);
        res.end();
        return;
      }
      res.writeHead(200, { etag: GZ_ETAG });
      res.end(gz);
    });
  }

  // ─── 1. Announced brotli is preferred; the gz object is never requested ───

  const preferred = await dualOrigin('ok');
  const brNominal = scratch('brotli-preferred');
  const brResult = await bootstrapFromSnapshot({ baseUrl: preferred.base, dbPath: brNominal });
  assert.equal(brResult.ok, true, brResult.reason);
  assert.equal(brResult.servers, 3);
  assert.equal(preferred.hits.br, 1);
  assert.equal(preferred.hits.gz, 0);
  // The install is still named after the snapshot identity — the gz digest —
  // so a pointer written by either path means the same thing.
  const brInstalled = versionedDbPath(brNominal, gzSha);
  assert.equal(brResult.dbPath, brInstalled);
  // Closed straight away: an open handle leaves -wal/-shm beside the file the
  // byte-identity assertion below reads, and blocks the teardown on Windows.
  withDatabase(brInstalled, (db) => assert.equal(getServerCount(db), 3));
  const brState = await readSnapshotState(brNominal);
  assert.equal(brState.sha256, gzSha, 'snapshot identity stays the gz digest');
  // The pointer's ETag validates the gz object; a brotli install has none to
  // give, so it records nothing rather than the wrong object's validator.
  assert.equal(brState.etag, undefined, 'a brotli install must not store a gz validator');
  await preferred.close();

  // ─── 2. Brotli 404 → gz fallback, with the gz ETag stored ────────────────

  const missing = await dualOrigin('missing');
  const fbNominal = scratch('brotli-missing');
  const fbResult = await bootstrapFromSnapshot({ baseUrl: missing.base, dbPath: fbNominal });
  assert.equal(fbResult.ok, true, fbResult.reason);
  assert.equal(missing.hits.br, 1);
  assert.equal(missing.hits.gz, 1);
  const fbState = await readSnapshotState(fbNominal);
  assert.equal(fbState.etag, GZ_ETAG, 'the stored ETag must describe the artifact downloaded');
  await missing.close();

  // Both decompression paths must yield the same database, byte for byte.
  assert.deepEqual(
    readFileSync(brInstalled),
    readFileSync(versionedDbPath(fbNominal, gzSha)),
    'brotli and gzip installs must produce an identical database',
  );

  // ─── 3. A corrupt brotli stream is a fallback, not a dead end ────────────

  const corrupt = await dualOrigin('corrupt');
  const corruptNominal = scratch('brotli-corrupt');
  const progress = [];
  const corruptResult = await bootstrapFromSnapshot({
    baseUrl: corrupt.base,
    dbPath: corruptNominal,
    onProgress: (bytes, total) => progress.push([bytes, total]),
  });
  assert.equal(corruptResult.ok, true, corruptResult.reason);
  assert.equal(corrupt.hits.br, 1);
  assert.equal(corrupt.hits.gz, 1);
  // Reporting only the successful attempt would understate the transfer that
  // the whole two-artifact scheme exists to reduce.
  const corruptBrBytes = Buffer.byteLength('not brotli at all');
  assert.equal(
    corruptResult.bytesDownloaded,
    corruptBrBytes + gz.length,
    'bytesDownloaded must sum every attempt, abandoned ones included',
  );
  assert.ok(progress.length >= 2);
  for (let i = 1; i < progress.length; i += 1) {
    assert.ok(
      progress[i][0] >= progress[i - 1][0] && progress[i][1] >= progress[i - 1][1],
      `progress must never run backwards: ${progress[i - 1]} then ${progress[i]}`,
    );
  }
  assert.deepEqual(progress[progress.length - 1], [
    corruptBrBytes + gz.length,
    corruptBrBytes + gz.length,
  ]);
  withDatabase(versionedDbPath(corruptNominal, gzSha), (db) =>
    assert.equal(getServerCount(db), 3),
  );
  await corrupt.close();

  // ─── 4. A digest that does not match the brotli bytes → gz fallback ──────

  const wrongDigest = await dualOrigin('wrong-digest');
  const wrongNominal = scratch('brotli-wrong-digest');
  const wrongResult = await bootstrapFromSnapshot({
    baseUrl: wrongDigest.base,
    dbPath: wrongNominal,
  });
  assert.equal(wrongResult.ok, true, wrongResult.reason);
  assert.equal(wrongDigest.hits.br, 1);
  assert.equal(wrongDigest.hits.gz, 1);
  await wrongDigest.close();

  // ─── 5. A pre-brotli manifest never touches the brotli endpoint ──────────

  const legacy = await dualOrigin('absent');
  const legacyNominal = scratch('brotli-absent');
  const legacyResult = await bootstrapFromSnapshot({ baseUrl: legacy.base, dbPath: legacyNominal });
  assert.equal(legacyResult.ok, true, legacyResult.reason);
  assert.equal(legacy.hits.br, 0);
  assert.equal(legacy.hits.gz, 1);
  assert.equal((await readSnapshotState(legacyNominal)).etag, GZ_ETAG);
  await legacy.close();

  // ─── 6. A malformed brotli block is dropped from the manifest ────────────

  const malformed = await dualOrigin('malformed');
  const malformedNominal = scratch('brotli-malformed');
  const malformedResult = await bootstrapFromSnapshot({
    baseUrl: malformed.base,
    dbPath: malformedNominal,
  });
  assert.equal(malformedResult.ok, true, malformedResult.reason);
  assert.equal(malformed.hits.br, 0);
  assert.equal(malformed.hits.gz, 1);
  assert.equal('brotli' in (await fetchSnapshotManifest(malformed.base)), false);
  await malformed.close();

  // ─── 7. With both artifacts down, the failure names both attempts ────────

  const bothDown = await dualOrigin('missing', { gzip: 'missing' });
  const bothNominal = scratch('brotli-both-down');
  const bothResult = await bootstrapFromSnapshot({ baseUrl: bothDown.base, dbPath: bothNominal });
  assert.equal(bothResult.ok, false);
  assert.match(bothResult.reason, /download-failed-500/);
  assert.match(bothResult.reason, /brotli: download-failed-404/);
  await bothDown.close();

  // ─── 8. The opt-out keeps a client on the gz artifact ────────────────────

  const optOut = await dualOrigin('ok');
  const optOutNominal = scratch('brotli-opt-out');
  process.env.MCPFINDER_SNAPSHOT_NO_BROTLI = '1';
  try {
    const optOutResult = await bootstrapFromSnapshot({
      baseUrl: optOut.base,
      dbPath: optOutNominal,
    });
    assert.equal(optOutResult.ok, true, optOutResult.reason);
  } finally {
    delete process.env.MCPFINDER_SNAPSHOT_NO_BROTLI;
  }
  assert.equal(optOut.hits.br, 0);
  assert.equal(optOut.hits.gz, 1);
  await optOut.close();

  // ─── 9. A cancelled run does not fall through to a full gz download ──────

  const cancelled = new AbortController();
  const aborting = await startOrigin((req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestBody());
      return;
    }
    if (req.url.startsWith('/data.sqlite.br')) {
      // The caller gives up while the preferred artifact is in flight.
      cancelled.abort();
      return;
    }
    res.writeHead(200, { etag: GZ_ETAG });
    res.end(gz);
  });
  const abortedResult = await bootstrapFromSnapshot({
    baseUrl: aborting.base,
    dbPath: scratch('brotli-aborted'),
    signal: cancelled.signal,
  });
  assert.equal(abortedResult.ok, false);
  assert.equal(aborting.hits.br, 1);
  assert.equal(
    aborting.hits.gz,
    0,
    'a cancelled bootstrap must not proceed to the fallback artifact',
  );
  await aborting.close();

  // ─── 10. A brotli download that stalls falls back on the inactivity budget ─

  const stalling = await startOrigin((req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestBody());
      return;
    }
    if (req.url.startsWith('/data.sqlite.br')) {
      // Headers and a first byte, then nothing — the shape the inactivity
      // budget exists for, here on the artifact that is allowed to fail.
      res.writeHead(200, { etag: BR_ETAG });
      res.write(br.subarray(0, 1));
      return;
    }
    res.writeHead(200, { etag: GZ_ETAG });
    res.end(gz);
  });
  const stalledNominal = scratch('brotli-stalled');
  const stalledResult = await bootstrapFromSnapshot({
    baseUrl: stalling.base,
    dbPath: stalledNominal,
    stallTimeoutMs: 150,
  });
  assert.equal(stalledResult.ok, true, stalledResult.reason);
  assert.equal(stalling.hits.br, 1);
  assert.equal(stalling.hits.gz, 1);
  assert.equal((await readSnapshotState(stalledNominal)).etag, GZ_ETAG);
  await stalling.close();

  // ─── 11. A transport error is a fallback like any other ──────────────────

  const reset = await startOrigin((req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(manifestBody());
      return;
    }
    if (req.url.startsWith('/data.sqlite.br')) {
      // Connection reset, not an HTTP status: the fetch itself rejects.
      req.socket.destroy();
      return;
    }
    res.writeHead(200, { etag: GZ_ETAG });
    res.end(gz);
  });
  const resetResult = await bootstrapFromSnapshot({
    baseUrl: reset.base,
    dbPath: scratch('brotli-reset'),
  });
  assert.equal(resetResult.ok, true, resetResult.reason);
  assert.equal(reset.hits.br, 1);
  assert.equal(reset.hits.gz, 1);
  await reset.close();

  // ─── 12. Decompressed output is bounded before the digest can be checked ──
  //
  // The bytes go to disk before anything can verify them, so a manifest and an
  // object under the same control would otherwise be a disk-fill primitive.
  // Brotli's expansion ceiling makes that far cheaper than gzip's ~1032:1.

  const bomb = brotliCompressSync(Buffer.alloc(24 * 1024 * 1024, 0));
  const bombSha = createHash('sha256').update(bomb).digest('hex');
  const bombing = await startOrigin((req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        manifestBody({
          rawSizeBytes: raw.length,
          brotli: { url: `data.sqlite.br?sha=${bombSha}`, sha256: bombSha, sizeBytes: bomb.length },
        }),
      );
      return;
    }
    if (req.url.startsWith('/data.sqlite.br')) {
      res.writeHead(200, { etag: BR_ETAG });
      res.end(bomb);
      return;
    }
    // Down, so the brotli reason survives into the result.
    res.writeHead(500);
    res.end();
  });
  const bombResult = await bootstrapFromSnapshot({
    baseUrl: bombing.base,
    dbPath: scratch('brotli-bomb'),
  });
  assert.equal(bombResult.ok, false);
  assert.match(bombResult.reason, /brotli: decompress-failed: decompressed-size-limit-exceeded/);
  await bombing.close();

  // ─── 13. Artifact URLs may not leave the configured base ─────────────────

  const offsite = await startOrigin((req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        manifestBody({
          brotli: {
            url: `http://127.0.0.1:1/data.sqlite.br?sha=${brSha}`,
            sha256: brSha,
            sizeBytes: br.length,
          },
        }),
      );
      return;
    }
    res.writeHead(200, { etag: GZ_ETAG });
    res.end(gz);
  });
  const offsiteResult = await bootstrapFromSnapshot({
    baseUrl: offsite.base,
    dbPath: scratch('brotli-offsite'),
  });
  assert.equal(offsiteResult.ok, true, offsiteResult.reason);
  assert.equal(offsite.hits.br, 0, 'an artifact URL outside the base must never be fetched');
  assert.equal(offsite.hits.gz, 1);
  await offsite.close();

  // The same rule applied to the gz artifact leaves nothing to download, and
  // the manifest is refused rather than followed off-base.
  const offsiteGz = await startOrigin((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      manifestBody({ url: `http://127.0.0.1:1/data.sqlite.gz?sha=${gzSha}`, brotli: undefined }),
    );
  });
  const offsiteGzResult = await bootstrapFromSnapshot({
    baseUrl: offsiteGz.base,
    dbPath: scratch('brotli-offsite-gz'),
  });
  assert.equal(offsiteGzResult.ok, false);
  assert.equal(offsiteGzResult.reason, 'manifest-url-rejected');
  assert.equal(offsiteGz.hits.gz, 0);
  await offsiteGz.close();
}
