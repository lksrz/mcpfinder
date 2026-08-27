/**
 * Shared fixtures for the snapshot data-dir concurrency checks.
 *
 * Two test files stand in for two mcpfinder processes sharing one
 * `~/.mcpfinder/`: `test-snapshot-concurrency.mjs` covers the promotion
 * primitive, the pointer and retention; `test-snapshot-adoption.mjs` covers
 * what happens when peers meet each other's files. They were one file until it
 * approached the 1000-line ceiling, and the seam is exactly that split — so the
 * temp data dir, the snapshot payload and the origin stub live here rather than
 * being written twice.
 *
 * Importing this module has side effects, in this order and for a reason:
 * it creates the temp data dir, points `MCPFINDER_DATA_DIR` at it, and only
 * *then* loads the core build, which reads that variable.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { gzipSync } from 'node:zlib';

export const dir = mkdtempSync(join(tmpdir(), 'mcpf-snapshot-concurrency-'));
process.env.MCPFINDER_DATA_DIR = dir;

// On `exit`, not at the end of the file: a failing assertion aborts the run
// wherever it happens, and a check that leaves a data dir behind on every red
// run litters `$TMPDIR` precisely when someone is iterating on it.
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));

export const {
  bootstrapFromSnapshot,
  initDatabase,
  getServerCount,
  pointerNamesStandIn,
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
export const { holdAdopted, promoteDownload, releaseAdopted, stillAdopted } =
  await import('../packages/core/dist/snapshot-install.js');
export const { createCatalog } = await import('../packages/mcp-server/dist/catalog.js');

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

export const payload = buildSnapshotPayload('conc');
export const payloadSha = createHash('sha256').update(payload).digest('hex');

export function manifestFor(overrides = {}) {
  return JSON.stringify({
    publishedAt: '2026-08-26T00:00:00.000Z',
    serverCount: 1,
    sha256: payloadSha,
    sizeBytes: payload.length,
    url: `data.sqlite.gz?sha=${payloadSha}`,
    ...overrides,
  });
}

export async function startOrigin(handler) {
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

export function serveOk(req, res) {
  if (req.url.startsWith('/manifest.json')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(manifestFor());
    return;
  }
  res.writeHead(200, { 'content-type': 'application/octet-stream', etag: '"c1"' });
  res.end(payload);
}

export function scratch(name) {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return join(path, 'data.db');
}

export function ageFile(path, hours) {
  const when = new Date(Date.now() - hours * 3_600_000);
  utimesSync(path, when, when);
}

/** An open catalog DB with `rows` servers in it — and a live `-wal`/`-shm`. */
export function openPeerDb(path, rows) {
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

export function stateFor(nominal, sha, publishedAt) {
  return {
    dbFile: basename(versionedDbPath(nominal, sha)),
    sha256: sha,
    publishedAt,
    installedAt: publishedAt,
    checkedAt: publishedAt,
  };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const skips = [];

/**
 * Record coverage this run could not exercise.
 *
 * A skip printed into an otherwise green run is a skip nobody reads: CI shows a
 * tick, and a check that silently stopped running looks exactly like a check
 * that passed. Container CI runs as root, where an EACCES fixture means
 * nothing, so this is not hypothetical — mutation testing found a build that
 * ran the whole suite to green with the one case that mattered skipped. So a
 * skip goes in the summary line where the reader is already looking, and the
 * suite says how many there were rather than how few.
 */
export function skip(reason) {
  skips.push(reason);
  console.log(`  (skipped: ${reason})`);
}

/** The suite's closing line, with any skips folded into it. */
export function reportPassed(label) {
  if (skips.length === 0) {
    console.log(`${label} passed`);
    return;
  }
  console.log(`${label} passed, with ${skips.length} check(s) SKIPPED:`);
  for (const reason of skips) console.log(`  - ${reason}`);
}
