/**
 * The snapshot retention invariants, asserted across real OS processes.
 *
 * `test-snapshot-concurrency.mjs` models peers inside one process: real SQLite
 * handles, real WAL sidecars, but one address space and one page cache. The
 * deployment this design actually has to survive is different — independent
 * `npx @mcpfinder/server` invocations, started by different editors, sharing
 * one `~/.mcpfinder/`. Nothing they do is coordinated by a shared heap; all
 * they share is the filesystem.
 *
 * So every peer here is a genuine `node:child_process`, driven over a line
 * protocol on stdin/stdout, and every step waits on an observable event — a
 * line, an exit code — never on a sleep. The invariant under test is the one
 * the whole retention scheme rests on:
 *
 *   unlinking a database a peer has open is harmless; removing its journal
 *   is not.
 *
 * POSIX only. The unlink half of that sentence is simply false on Windows, so
 * this harness skips there rather than asserting something untrue.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';

if (process.platform === 'win32') {
  console.log('snapshot multiprocess checks skipped: POSIX unlink semantics only');
  process.exit(0);
}

const started = Date.now();
const here = dirname(fileURLToPath(import.meta.url));
const coreDist = pathToFileURL(join(here, '../packages/core/dist/index.js')).href;

const dir = mkdtempSync(join(tmpdir(), 'mcpf-snapshot-multiproc-'));
process.env.MCPFINDER_DATA_DIR = dir;

const { initDatabase, getServerCount, resolveCurrentDbPath, readSnapshotState, versionedDbPath } =
  await import(coreDist);

// ─── Child programs ─────────────────────────────────────────────────────────
//
// Each is a whole process. They talk over stdout lines so the parent can
// synchronise on facts rather than on elapsed time.

const INSERT =
  "INSERT INTO servers (id, slug, name, description) VALUES (?, ?, ?, '')";

const CHILDREN = {
  // A long-lived peer: opens the database, keeps it open, answers commands.
  'peer.mjs': `
import { createInterface } from 'node:readline';
const { initDatabase, getServerCount } = await import(process.env.CORE_DIST);
const [dbPath, rows] = process.argv.slice(2);
const db = initDatabase(dbPath);
const insert = (id) => db.prepare(${JSON.stringify(INSERT)}).run(\`io.example/\${id}\`, id, \`io.example/\${id}\`);
for (let i = 0; i < Number(rows); i += 1) insert(\`peer-\${i}\`);
// Fold the fixture into the database file itself, so anything found in the
// journal afterwards is exactly what this peer wrote after announcing READY.
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
console.log('READY ' + process.pid);
createInterface({ input: process.stdin }).on('line', (raw) => {
  const [cmd, arg] = raw.trim().split(' ');
  // Teardown is unconditional. Block 2 deliberately leaves this process with
  // its journal pulled out from under it, and a close() that throws must still
  // end the process — otherwise the peer lingers with stdin open and the parent
  // waits out its whole timeout on a child that is never going to exit.
  if (cmd === 'EXIT') {
    try {
      db.close();
    } catch (err) {
      console.log('ERR ' + String(err && err.message));
    }
    process.exit(0);
  }
  try {
    if (cmd === 'COUNT') console.log('COUNT ' + getServerCount(db));
    else if (cmd === 'WRITE') { insert(arg); console.log('WROTE ' + arg); }
  } catch (err) {
    console.log('ERR ' + String(err && err.message));
  }
});
`,
  // A cold reader: what a *newly started* mcpfinder sees in the data dir.
  'reader.mjs': `
const { initDatabase, getServerCount } = await import(process.env.CORE_DIST);
try {
  const db = initDatabase(process.argv[2]);
  console.log('COUNT ' + getServerCount(db));
  db.close();
} catch (err) {
  console.log('ERR ' + String(err && err.message));
  process.exitCode = 1;
}
`,
  // Retention, run by somebody else's process entirely.
  'sweep.mjs': `
const { sweepSnapshotFiles } = await import(process.env.CORE_DIST);
const [nominal, retainHours] = process.argv.slice(2);
console.log('SWEPT ' + JSON.stringify(await sweepSnapshotFiles(nominal, { retainHours: Number(retainHours) })));
`,
  // A raw unlink from another process — no product code involved, because the
  // point is to establish what the product code must never do.
  'unlink.mjs': `
import { rmSync } from 'node:fs';
for (const path of process.argv.slice(2)) rmSync(path, { force: true });
console.log('UNLINKED');
`,
  // An install. With --gate it announces itself and blocks until told to go,
  // which is how two of them are made to overlap without a sleep.
  'bootstrap.mjs': `
import { createInterface } from 'node:readline';
const { bootstrapFromSnapshot, resolveCurrentDbPath } = await import(process.env.CORE_DIST);
const [nominal, baseUrl, ...flags] = process.argv.slice(2);
const retain = flags.find((f) => f.startsWith('--retain='));
const run = async () => {
  const result = await bootstrapFromSnapshot({
    baseUrl,
    dbPath: nominal,
    force: true,
    ...(retain ? { retainHours: Number(retain.slice('--retain='.length)) } : {}),
  });
  console.log('RESULT ' + JSON.stringify({ ...result, manifest: undefined, current: resolveCurrentDbPath(nominal) }));
  process.exit(0);
};
if (flags.includes('--gate')) {
  console.log('READY ' + process.pid);
  createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() === 'GO') run();
  });
} else {
  await run();
}
`,
};

const childDir = join(dir, 'children');
mkdirSync(childDir, { recursive: true });
for (const [name, source] of Object.entries(CHILDREN)) {
  writeFileSync(join(childDir, name), source);
}

// ─── Process plumbing ───────────────────────────────────────────────────────

const live = new Set();

function killAll() {
  for (const handle of live) {
    if (handle.exited) continue;
    try {
      handle.proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  live.clear();
}

// Belt and braces: an assertion throwing anywhere below still tears down every
// child and the temp dir, because a failing test that leaks processes into CI
// is its own second bug.
process.on('exit', () => {
  killAll();
  rmSync(dir, { recursive: true, force: true });
});

function spawnChild(script, args = []) {
  const proc = spawn(process.execPath, [join(childDir, script), ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CORE_DIST: coreDist, MCPFINDER_DATA_DIR: dir },
  });
  const handle = {
    proc,
    name: `${script} ${args.join(' ')}`.trim(),
    lines: [],
    stderr: '',
    cursor: 0,
    exited: null,
    waiters: new Set(),
  };
  live.add(handle);

  // A child that has already gone turns the next write into an async EPIPE;
  // during teardown that is expected, not a test failure.
  proc.stdin.on('error', () => {});

  let buffered = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (chunk) => {
    buffered += chunk;
    let nl;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (line) handle.lines.push(line);
    }
    settle(handle);
  });
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (chunk) => {
    handle.stderr += chunk;
  });
  proc.on('exit', (code, signal) => {
    handle.exited = { code, signal };
    settle(handle);
  });
  return handle;
}

function settle(handle) {
  for (const waiter of [...handle.waiters]) {
    if (waiter.attempt()) handle.waiters.delete(waiter);
  }
}

function detail(handle) {
  const out = handle.lines.length ? ` stdout: ${handle.lines.join(' | ')}` : '';
  const err = handle.stderr ? ` stderr: ${handle.stderr.trim()}` : '';
  return `${out}${err}`;
}

/**
 * Resolve with the first unconsumed stdout line matching `match`.
 *
 * Bounded, and loud on timeout: a cross-process test that hangs teaches CI
 * nothing, and one that quietly passes a missing line teaches it less.
 */
function waitForLine(handle, match, timeoutMs = 20_000) {
  const test = typeof match === 'string' ? (line) => line.startsWith(match) : match;
  return new Promise((resolve, reject) => {
    const waiter = {
      attempt() {
        for (let i = handle.cursor; i < handle.lines.length; i += 1) {
          if (test(handle.lines[i])) {
            handle.cursor = i + 1;
            clearTimeout(timer);
            resolve(handle.lines[i]);
            return true;
          }
        }
        if (handle.exited) {
          clearTimeout(timer);
          reject(
            new Error(
              `${handle.name} exited (code ${handle.exited.code}) without the expected line.${detail(handle)}`,
            ),
          );
          return true;
        }
        return false;
      },
    };
    const timer = setTimeout(() => {
      handle.waiters.delete(waiter);
      reject(new Error(`timed out waiting on ${handle.name} for a line.${detail(handle)}`));
    }, timeoutMs);
    handle.waiters.add(waiter);
    if (waiter.attempt()) handle.waiters.delete(waiter);
  });
}

function waitForExit(handle, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    if (handle.exited) {
      resolve(handle.exited);
      return;
    }
    const onExit = (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    };
    const timer = setTimeout(() => {
      handle.proc.removeListener('exit', onExit);
      reject(new Error(`timed out waiting for ${handle.name} to exit.${detail(handle)}`));
    }, timeoutMs);
    handle.proc.on('exit', onExit);
  });
}

function send(handle, line) {
  handle.proc.stdin.write(`${line}\n`);
}

/** Ask a live peer a question and get its answer. */
async function ask(handle, command, match = 'COUNT') {
  send(handle, command);
  return waitForLine(handle, match);
}

async function countFrom(handle) {
  const line = await ask(handle, 'COUNT');
  assert.match(line, /^COUNT \d+$/, line);
  return Number(line.slice('COUNT '.length));
}

/** A peer process with `rows` servers checkpointed into its database file. */
async function startPeer(dbPath, rows) {
  const peer = spawnChild('peer.mjs', [dbPath, String(rows)]);
  await waitForLine(peer, 'READY');
  assert.ok(existsSync(`${dbPath}-wal`), 'the fixture must have a real WAL sidecar');
  return peer;
}

/**
 * Ask a peer to go, then insist.
 *
 * Teardown must never be the slowest thing in the file. `EXIT` is the polite
 * path and takes milliseconds; anything that has not gone within `graceMs` is
 * wedged — block 2 leaves one peer in exactly that state on purpose — so it is
 * signalled rather than waited on. The bound on the whole thing is a couple of
 * seconds, not the 20s a bare `waitForExit` would spend.
 */
async function stopPeer(peer, graceMs = 2_000) {
  if (!peer.exited) send(peer, 'EXIT');
  try {
    await waitForExit(peer, graceMs);
  } catch {
    try {
      peer.proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    await waitForExit(peer, 5_000);
  }
  live.delete(peer);
}

/** Run a child to completion and return its stdout lines. */
async function run(script, args) {
  const handle = spawnChild(script, args);
  const exit = await waitForExit(handle);
  live.delete(handle);
  assert.equal(exit.code, 0, `${handle.name} failed.${detail(handle)}`);
  return handle.lines;
}

async function readCount(dbPath) {
  const [line] = await run('reader.mjs', [dbPath]);
  assert.match(line, /^COUNT \d+$/, `a cold reader could not read ${dbPath}: ${line}`);
  return Number(line.slice('COUNT '.length));
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

function buildSnapshotPayload(name, rows) {
  const srcPath = join(dir, `${name}.src.db`);
  const db = initDatabase(srcPath);
  for (let i = 0; i < rows; i += 1) {
    db.prepare(INSERT).run(`io.example/${name}-${i}`, `${name}-${i}`, `io.example/${name}-${i}`);
  }
  db.close();
  const gz = gzipSync(readFileSync(srcPath));
  return { gz, sha: createHash('sha256').update(gz).digest('hex'), rows };
}

const v1 = buildSnapshotPayload('v1', 1);
const v2 = buildSnapshotPayload('v2', 2);
const bySha = new Map([
  [v1.sha, v1],
  [v2.sha, v2],
]);

/**
 * A local origin the children fetch over real HTTP.
 *
 * `gate` holds artifact responses until `n` of them are outstanding: that is
 * the barrier which makes two independent installs genuinely overlap, instead
 * of hoping a sleep lines them up.
 */
async function startOrigin(initial) {
  const state = { served: initial, gate: null };
  const server = createServer((req, res) => {
    if (req.url.startsWith('/manifest.json')) {
      const { sha, gz, rows } = state.served;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          publishedAt: sha === v1.sha ? '2026-08-26T00:00:00.000Z' : '2026-08-27T00:00:00.000Z',
          serverCount: rows,
          sha256: sha,
          sizeBytes: gz.length,
          url: `data.sqlite.gz?sha=${sha}`,
        }),
      );
      return;
    }
    const sha = new URL(req.url, 'http://x').searchParams.get('sha');
    const payload = bySha.get(sha) ?? state.served;
    const respond = () => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', etag: `"${sha}"` });
      res.end(payload.gz);
    };
    if (state.gate) {
      state.gate.held.push(respond);
      if (state.gate.held.length >= state.gate.n) {
        const { held } = state.gate;
        state.gate = null;
        for (const release of held) release();
      }
      return;
    }
    respond();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.unref();
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    serve: (payload) => {
      state.served = payload;
    },
    gate: (n) => {
      state.gate = { n, held: [] };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function scratch(name) {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return join(path, 'data.db');
}

const snapshotFiles = (nominal) =>
  readdirSync(dirname(nominal))
    .filter((f) => /^data-.*\.db$/.test(f))
    .sort();

const origin = await startOrigin(v1);

// ─── 1. Another process unlinks the database a peer has open ────────────────

{
  // The everyday retention event: peer A is serving out of a superseded file
  // when peer B's sweep reclaims it. On POSIX the name goes and the inode
  // stays, which is the only reason retention may run at all while peers live.
  const nominal = scratch('unlink-under-peer');
  const held = versionedDbPath(nominal, 'b'.repeat(64));
  const current = versionedDbPath(nominal, 'a'.repeat(64));
  writeFileSync(current, 'current');

  const peer = await startPeer(held, 2);
  await ask(peer, 'WRITE live-1', 'WROTE');
  assert.equal(await countFrom(peer), 3);

  // The pointer selects the other file, so `held` is a sweep candidate.
  writeFileSync(`${nominal}.snapshot.json`, JSON.stringify({
    dbFile: basename(current),
    sha256: 'a'.repeat(64),
    publishedAt: '2026-08-26T00:00:00.000Z',
    installedAt: '2026-08-26T00:00:00.000Z',
    checkedAt: '2026-08-26T00:00:00.000Z',
  }));

  const [swept] = await run('sweep.mjs', [nominal, '0']);
  assert.equal(swept, `SWEPT ${JSON.stringify([basename(held)])}`, swept);
  assert.equal(existsSync(held), false, 'the superseded database is gone from the directory');
  assert.ok(existsSync(current), 'the file the pointer selects is never a candidate');
  assert.ok(existsSync(`${held}-wal`), "a live peer's journal is never removed with its database");
  assert.ok(existsSync(`${held}-shm`), 'nor its shared-memory index');

  // The whole point: a different OS process took the file's *name* away and
  // this one did not notice.
  assert.equal(await countFrom(peer), 3, 'the peer still reads its own rows');
  await ask(peer, 'WRITE after-sweep', 'WROTE');
  assert.equal(await countFrom(peer), 4, 'and still commits new ones');
  await stopPeer(peer);
}

// ─── 2. Another process removes the journal: committed rows are destroyed ───

{
  // The prohibition, demonstrated rather than restated. Rows a peer has
  // committed live in the `-wal` until a checkpoint folds them in; unlink that
  // file and they are simply not in the database any more. The next process to
  // start — a fresh editor window opening the same data dir — reads a
  // catalogue that has silently lost the writes.
  const nominal = scratch('journal-removed');
  const path = versionedDbPath(nominal, 'c'.repeat(64));
  const peer = await startPeer(path, 2);

  for (const id of ['committed-1', 'committed-2', 'committed-3']) {
    await ask(peer, `WRITE ${id}`, 'WROTE');
  }
  assert.equal(await countFrom(peer), 5, 'the peer sees its own commits');
  assert.ok(statSync(`${path}-wal`).size > 0, 'and they are still only in the journal');

  // Control arm: right now another process reads all five, through the file
  // and its journal together.
  assert.equal(await readCount(path), 5, 'a second process sees the committed rows');

  await run('unlink.mjs', [`${path}-wal`, `${path}-shm`]);

  const after = await readCount(path);
  assert.equal(
    after,
    2,
    `removing a live peer's journal destroys committed data: 3 rows lost (saw ${after})`,
  );
  // Deliberately no assertion about the peer's own handle after this point:
  // what SQLite does to a process whose journal was pulled out from under it is
  // not something a test should pin down. That it is unpredictable is exactly
  // why the sweep must never do it.
  await stopPeer(peer);
}

// ─── 3. Two processes installing at once converge on one pointer ────────────

{
  const nominal = scratch('parallel-install');
  origin.serve(v1);
  // Neither child gets its bytes until both have asked, so the two installs
  // genuinely overlap — no sleep, and no dependence on scheduler luck.
  origin.gate(2);

  const a = spawnChild('bootstrap.mjs', [nominal, origin.base, '--gate']);
  const b = spawnChild('bootstrap.mjs', [nominal, origin.base, '--gate']);
  await Promise.all([waitForLine(a, 'READY'), waitForLine(b, 'READY')]);
  send(a, 'GO');
  send(b, 'GO');

  const [lineA, lineB] = await Promise.all([
    waitForLine(a, 'RESULT', 30_000),
    waitForLine(b, 'RESULT', 30_000),
  ]);
  await Promise.all([waitForExit(a), waitForExit(b)]);
  live.delete(a);
  live.delete(b);

  const resA = JSON.parse(lineA.slice('RESULT '.length));
  const resB = JSON.parse(lineB.slice('RESULT '.length));
  assert.equal(resA.ok, true, resA.reason);
  assert.equal(resB.ok, true, resB.reason);

  assert.deepEqual(
    snapshotFiles(nominal),
    [`data-${v1.sha.slice(0, 16)}.db`],
    'two concurrent installs of one digest leave exactly one database behind',
  );
  assert.equal(
    readdirSync(dirname(nominal)).filter((f) => f.includes('.download-')).length,
    0,
    'and no abandoned partial downloads',
  );

  const state = await readSnapshotState(nominal);
  assert.equal(state.sha256, v1.sha, 'one pointer, naming the digest both installed');
  assert.equal(state.dbFile, `data-${v1.sha.slice(0, 16)}.db`);
  assert.equal(resA.current, resB.current, 'both processes resolve the same current database');
  assert.equal(resA.current, resolveCurrentDbPath(nominal), 'and so does a third');
  assert.equal(await readCount(resA.current), v1.rows, 'the installed file is the real snapshot');
}

// ─── 4. An install never lands on a name a peer's journal belongs to ────────

{
  // The footprint block 1 leaves in a real data dir: a stranded `-wal` with no
  // database. If the same digest is published again, the canonical name is
  // taken by somebody else's journal — and a database created there adopts it.
  const nominal = scratch('name-returns');
  const canonical = versionedDbPath(nominal, v1.sha);
  const peer = await startPeer(canonical, 3);
  await run('unlink.mjs', [canonical]);
  assert.ok(existsSync(`${canonical}-wal`), 'the stranded journal is the precondition');

  origin.serve(v1);
  const [line] = await run('bootstrap.mjs', [nominal, origin.base]);
  const result = JSON.parse(line.slice('RESULT '.length));
  assert.equal(result.ok, true, result.reason);

  assert.notEqual(result.dbPath, canonical, "never onto a name another process's journal claims");
  assert.match(basename(result.dbPath), /^data-[0-9a-f]{16}-[0-9a-z]{6}\.db$/, result.dbPath);
  assert.equal(existsSync(`${result.dbPath}-wal`), false, 'the new file starts with no journal');
  assert.ok(existsSync(`${canonical}-wal`), "and the peer's journal is left exactly where it was");
  assert.equal(await countFrom(peer), 3, 'the peer is untouched');
  assert.equal(await readCount(result.dbPath), v1.rows, 'the install is the snapshot, not the peer');
  await stopPeer(peer);
}

// ─── 5. A peer serves straight through another process's install and sweep ──

{
  // Everything above, in the order it actually happens: editor A is running on
  // yesterday's snapshot when editor B starts, installs today's, and sweeps.
  const nominal = scratch('install-under-peer');
  origin.serve(v1);
  const [first] = await run('bootstrap.mjs', [nominal, origin.base]);
  const installed = JSON.parse(first.slice('RESULT '.length));
  assert.equal(installed.ok, true, installed.reason);

  const peer = await startPeer(installed.dbPath, 0);
  assert.equal(await countFrom(peer), v1.rows, 'the peer is serving the old snapshot');
  await ask(peer, 'WRITE peer-local', 'WROTE');

  origin.serve(v2);
  const [second] = await run('bootstrap.mjs', [nominal, origin.base, '--retain=0']);
  const upgraded = JSON.parse(second.slice('RESULT '.length));
  assert.equal(upgraded.ok, true, upgraded.reason);
  assert.notEqual(upgraded.dbPath, installed.dbPath, 'a genuinely different file was installed');

  assert.equal(
    (await readSnapshotState(nominal)).sha256,
    v2.sha,
    'the data dir now points at the new snapshot',
  );
  assert.deepEqual(
    snapshotFiles(nominal),
    [basename(upgraded.dbPath)],
    "the peer's database was reclaimed by the other process",
  );
  assert.ok(existsSync(`${installed.dbPath}-wal`), "but its journal was left alone");
  assert.equal(await readCount(upgraded.dbPath), v2.rows, 'a new process gets the new catalogue');
  assert.equal(
    await countFrom(peer),
    v1.rows + 1,
    'and the peer, mid-session, never noticed any of it',
  );
  await stopPeer(peer);
}

await origin.close();
killAll();
rmSync(dir, { recursive: true, force: true });
console.log(`snapshot multiprocess checks passed (${((Date.now() - started) / 1000).toFixed(1)}s)`);
