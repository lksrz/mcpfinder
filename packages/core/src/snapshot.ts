/**
 * Pre-built DB snapshot bootstrap.
 *
 * Downloads a gzipped SQLite file produced by a scheduled builder and installs
 * it into the data dir as a new, immutable, sha-named file. This replaces the
 * ~11 min cold-start sync with a single download on first run.
 *
 * Protocol (served by api-worker):
 *   GET <base>/manifest.json   → { publishedAt, serverCount, sha256, sizeBytes, url, brotli? }
 *   GET <base>/data.sqlite.gz?sha=<sha256>   → immutable gzipped SQLite file
 *   GET <base>/data.sqlite.br?sha=<brSha256> → the same DB, brotli (~21% smaller)
 *
 * The brotli artifact is preferred when the manifest announces one, but it is
 * strictly an optimisation: any failure on that path — 404, transport error,
 * corrupt stream, wrong digest — falls back to the gz artifact rather than
 * failing the bootstrap. A brotli object that turns out to be broken in
 * production therefore costs bandwidth, not availability.
 *
 * Nothing is ever overwritten: the verified download becomes `data-<sha16>.db`
 * and a pointer file switches over to it (see snapshot-state.ts for why). Peer
 * processes on the same data dir keep running against whichever file they
 * opened. Everything between "the bytes are good" and "the caller can open
 * them" — taking a name, adopting a peer's file, proving it is really this
 * snapshot — lives in snapshot-install.ts.
 *
 * Failure policy: every path returns `{ ok: false, reason }`. Nothing here ever
 * rejects — the caller runs before the MCP handshake, where an unhandled
 * rejection would kill the process instead of degrading to a live sync.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip } from 'node:zlib';
import { Readable, Transform } from 'node:stream';
import { getDataDir } from './db.js';
import {
  discardStandIn,
  fileExistsNonEmpty,
  fileIdentity,
  promoteDownload,
  promoteTo,
} from './snapshot-install.js';
import {
  downloadTempPath,
  isValidSha256,
  publishSnapshotState,
  readSnapshotState,
  reconcileSnapshotPointer,
  resolveCurrentDbPath,
  sweepSnapshotFiles,
  variantDbPath,
  versionedDbPath,
  type SnapshotState,
} from './snapshot-state.js';

export const DEFAULT_SNAPSHOT_BASE = 'https://mcpfinder.dev/api/v1/snapshot';

/** Manifest is a small JSON blob — a short, absolute timeout is enough. */
export const DEFAULT_MANIFEST_TIMEOUT_MS = 10_000;
/**
 * The DB itself is tens of megabytes, so an absolute timeout would cut off slow
 * but healthy links. Budget inactivity instead: the download is aborted only
 * after this long without a single received byte.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 60_000;

/** A downloadable compression of the snapshot database. */
export interface SnapshotArtifactRef {
  /** Relative or absolute URL of the compressed DB file. */
  url: string;
  /** Lowercase hex sha256 of *this* artifact's bytes. */
  sha256: string;
  sizeBytes: number;
}

export interface SnapshotManifest {
  publishedAt: string;
  serverCount: number;
  /**
   * Required, lowercase hex sha256 of the gzipped file — and the identity of
   * the snapshot itself: it is what the local pointer records and what every
   * freshness check compares against, whichever artifact was downloaded.
   */
  sha256: string;
  sizeBytes: number;
  /**
   * Uncompressed size of the database, when the builder recorded one. It is
   * what bounds how much either artifact is allowed to expand to on disk.
   */
  rawSizeBytes?: number;
  /** Relative or absolute URL of the gzipped DB file. */
  url: string;
  /**
   * Optional brotli encoding of the same database, with its own digest and
   * size. Absent in manifests published before 1.3.0; dropped here when
   * malformed, so a bad block degrades to the gz path instead of failing.
   */
  brotli?: SnapshotArtifactRef;
  /** Builder version / git SHA, for diagnostics. */
  builder?: string;
}

export interface BootstrapResult {
  ok: boolean;
  reason?: string;
  servers?: number;
  publishedAt?: string;
  /** Compressed bytes pulled over the wire, abandoned attempts included. */
  bytesDownloaded?: number;
  durationMs?: number;
  /** Manifest of the snapshot that was checked, when one was fetched. */
  manifest?: SnapshotManifest;
  /** Path of the DB file now current, when the install succeeded. */
  dbPath?: string;
}

export interface BootstrapOptions {
  /** Base URL for snapshot endpoint; defaults to mcpfinder.dev. */
  baseUrl?: string;
  /**
   * Nominal DB path, defaulting to `<data-dir>/data.db`. It names the *family*
   * of files, not the file that gets written: installs land beside it as
   * `data-<sha16>.db` and the pointer at `<db>.snapshot.json` selects one.
   */
  dbPath?: string;
  /** If true, download even when the current snapshot already matches. */
  force?: boolean;
  /**
   * If true, an existing install is refreshed when the published snapshot
   * differs from the recorded pointer (one conditional request, no full
   * download when it is already current).
   */
  refresh?: boolean;
  /** AbortSignal for cancellation. */
  signal?: AbortSignal;
  /** Timeout for the manifest request. */
  manifestTimeoutMs?: number;
  /** Inactivity (no bytes received) timeout for the DB download. */
  stallTimeoutMs?: number;
  /** Grace period before superseded DB files are swept. */
  retainHours?: number;
  /**
   * Progress callback for the DB download. Both figures are cumulative over
   * every attempt — a fallback adds to them rather than restarting — so
   * `total` is the sum of the attempted artifacts' manifest sizes.
   */
  onProgress?: (bytesDownloaded: number, total: number) => void;
  /**
   * Awaited after the new file is verified and in place, with its path — the
   * hook where a caller opens the new database and retires its old handle.
   * A throw here aborts the switch: the pointer is left on the previous
   * snapshot and the caller's existing handle is never touched.
   */
  activate?: (dbPath: string) => void | Promise<void>;
  /** Injectable fetch, for tests. */
  fetchImpl?: typeof fetch;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function combineSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((s): s is AbortSignal => Boolean(s));
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Fetch the snapshot manifest. Returns null on any error (including timeout)
 * and on any manifest that cannot be verified against.
 *
 * `sha256` is mandatory and must be a well-formed digest: without it the
 * download could not be checked, and installing unverified bytes is worse than
 * not installing at all.
 */
export async function fetchSnapshotManifest(
  baseUrl: string = DEFAULT_SNAPSHOT_BASE,
  signal?: AbortSignal,
  opts: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<SnapshotManifest | null> {
  const url = `${baseUrl.replace(/\/+$/, '')}/manifest.json`;
  const timeoutMs =
    opts.timeoutMs ?? envInt('MCPFINDER_SNAPSHOT_MANIFEST_TIMEOUT_MS', DEFAULT_MANIFEST_TIMEOUT_MS);
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(url, {
      signal: combineSignals([signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!res.ok) return null;
    const manifest = (await res.json()) as SnapshotManifest;
    if (!manifest || typeof manifest.url !== 'string') return null;
    if (!isValidSha256(manifest.sha256)) return null;
    const brotli = normalizeArtifactRef(manifest.brotli);
    const normalized: SnapshotManifest = { ...manifest, sha256: manifest.sha256.toLowerCase() };
    // Optional by construction: a manifest without a usable brotli block is a
    // perfectly good manifest, so drop the key rather than reject the snapshot.
    if (brotli) normalized.brotli = brotli;
    else delete normalized.brotli;
    return normalized;
  } catch {
    return null;
  }
}

/** Accept an optional artifact block only when every field can be relied on. */
function normalizeArtifactRef(ref: unknown): SnapshotArtifactRef | null {
  if (!ref || typeof ref !== 'object') return null;
  const candidate = ref as Partial<SnapshotArtifactRef>;
  if (typeof candidate.url !== 'string' || candidate.url.length === 0) return null;
  if (!isValidSha256(candidate.sha256)) return null;
  if (!Number.isSafeInteger(candidate.sizeBytes) || (candidate.sizeBytes as number) <= 0) {
    return null;
  }
  return {
    url: candidate.url,
    sha256: (candidate.sha256 as string).toLowerCase(),
    sizeBytes: candidate.sizeBytes as number,
  };
}

interface DownloadOutcome {
  status: 'ok' | 'not-modified' | 'failed';
  reason?: string;
  bytes: number;
  etag?: string;
}

/** One concrete thing to download, resolved to an absolute URL. */
interface DownloadPlan {
  /** Which compression — decides the decompressor and the pointer's etag. */
  encoding: 'gzip' | 'brotli';
  url: string;
  /** Digest of *these* bytes, which is what the download is checked against. */
  sha256: string;
  sizeBytes: number;
  /** Hard ceiling on the decompressed bytes this artifact may write to disk. */
  maxOutputBytes: number;
  /** Bytes already transferred by earlier attempts, so progress never rewinds. */
  progressBase: number;
}

function decompressorFor(encoding: DownloadPlan['encoding']): NodeJS.ReadWriteStream {
  return encoding === 'brotli' ? createBrotliDecompress() : createGunzip();
}

/**
 * Bound what a decompressor may write, because the bytes land on disk *before*
 * the digest can be checked — a manifest and object an attacker controls would
 * otherwise be a disk-fill primitive, and brotli's expansion ceiling at LGWIN
 * 24 is orders of magnitude above gzip's ~1032:1.
 *
 * zlib's own `maxOutputLength` does not do this: on a stream it caps a single
 * output buffer, not the total, so a counter is the only thing that holds.
 */
function outputLimiter(maxBytes: number): Transform {
  let written = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, callback) {
      written += chunk.length;
      if (written > maxBytes) {
        callback(new Error(`decompressed-size-limit-exceeded (max ${maxBytes} bytes)`));
        return;
      }
      callback(null, chunk);
    },
  });
}

async function downloadToTemp(
  plan: DownloadPlan,
  tmpPath: string,
  opts: BootstrapOptions,
  ifNoneMatch?: string,
): Promise<DownloadOutcome> {
  const stallMs =
    opts.stallTimeoutMs ?? envInt('MCPFINDER_SNAPSHOT_STALL_TIMEOUT_MS', DEFAULT_STALL_TIMEOUT_MS);
  const doFetch = opts.fetchImpl ?? fetch;
  const stallController = new AbortController();
  let stallTimer: NodeJS.Timeout | undefined;
  let stalled = false;
  const armStall = (): void => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      stallController.abort();
    }, stallMs);
    stallTimer.unref?.();
  };

  let bytesIn = 0;
  try {
    armStall();
    const res = await doFetch(plan.url, {
      signal: combineSignals([opts.signal, stallController.signal]),
      headers: ifNoneMatch ? { 'if-none-match': ifNoneMatch } : undefined,
    });
    if (res.status === 304) {
      return { status: 'not-modified', bytes: 0, etag: ifNoneMatch };
    }
    if (!res.ok || !res.body) {
      return { status: 'failed', reason: `download-failed-${res.status}`, bytes: 0 };
    }

    const hash = createHash('sha256');
    const compressed = Readable.fromWeb(res.body as never);
    compressed.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytesIn += chunk.length;
      armStall();
      try {
        // Cumulative across attempts, against a total that already includes
        // them: a fallback must not make the counter run backwards.
        opts.onProgress?.(plan.progressBase + bytesIn, plan.progressBase + (plan.sizeBytes ?? 0));
      } catch {
        // A caller's progress callback must not become an uncaught exception
        // out of a stream handler — that would kill the process the whole
        // "never rejects" contract exists to protect.
      }
    });

    try {
      await pipeline(
        compressed,
        decompressorFor(plan.encoding),
        outputLimiter(plan.maxOutputBytes),
        createWriteStream(tmpPath),
      );
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      const reason = stalled
        ? `download-stalled after ${stallMs}ms (${bytesIn} bytes received)`
        : `decompress-failed: ${errorMessage(err)}`;
      return { status: 'failed', reason, bytes: bytesIn };
    }

    // Checked against this artifact's own digest — the gz digest is the
    // snapshot's identity, not a description of the brotli bytes.
    const gotSha = hash.digest('hex');
    if (gotSha !== plan.sha256) {
      await unlink(tmpPath).catch(() => {});
      return {
        status: 'failed',
        reason: `sha256-mismatch (expected ${plan.sha256}, got ${gotSha})`,
        bytes: bytesIn,
      };
    }

    return { status: 'ok', bytes: bytesIn, etag: res.headers.get('etag') ?? undefined };
  } catch (err) {
    await unlink(tmpPath).catch(() => {});
    const reason = stalled
      ? `download-stalled after ${stallMs}ms (${bytesIn} bytes received)`
      : `download-error: ${errorMessage(err)}`;
    return { status: 'failed', reason, bytes: bytesIn };
  } finally {
    clearTimeout(stallTimer);
  }
}

/**
 * Resolve an artifact URL against the configured snapshot base, refusing
 * anything that leaves it.
 *
 * The digest that would catch substituted bytes comes out of the same document
 * as the URL, so it says nothing about *where* a client should connect. The
 * base URL — `MCPFINDER_SNAPSHOT_BASE`, or the default host — is what does, and
 * a manifest may not widen it. Relative URLs (what every published manifest
 * uses) keep resolving exactly as before; an absolute one is honoured only
 * while it stays inside the base.
 */
function resolveArtifactUrl(url: string, baseUrl: string): string | null {
  const base = `${baseUrl.replace(/\/+$/, '')}/`;
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(url);
  try {
    const resolved = new URL(absolute ? url : url.replace(/^\/+/, ''), base);
    const root = new URL(base);
    if (resolved.origin !== root.origin) return null;
    if (!resolved.pathname.startsWith(root.pathname)) return null;
    return resolved.toString();
  } catch {
    return null;
  }
}

/** Opt-out for a client that must not use the brotli artifact at all. */
function brotliDisabled(): boolean {
  return process.env.MCPFINDER_SNAPSHOT_NO_BROTLI === '1';
}

/**
 * How far a compressed artifact may expand before the download is abandoned.
 *
 * `rawSizeBytes` is the exact figure the builder recorded, so it only needs
 * slack for a manifest that is a build or two ahead of these constants. A
 * manifest without it (published before the field existed) falls back to a
 * generous multiple of the compressed size — still bounded, unlike brotli's
 * native expansion ceiling.
 */
const DECOMPRESS_RAW_MARGIN = 1.5;
const DECOMPRESS_COMPRESSED_MARGIN = 50;
/** Enough headroom that no plausible small snapshot trips the limit. */
const DECOMPRESS_FLOOR_BYTES = 16 * 1024 * 1024;

function maxOutputBytesFor(manifest: SnapshotManifest, sizeBytes: number): number {
  const raw = manifest.rawSizeBytes;
  const budget =
    Number.isSafeInteger(raw) && (raw as number) > 0
      ? (raw as number) * DECOMPRESS_RAW_MARGIN
      : sizeBytes * DECOMPRESS_COMPRESSED_MARGIN;
  return Math.max(DECOMPRESS_FLOOR_BYTES, Math.ceil(budget));
}

/**
 * Artifacts to try, most preferred first; the gz artifact is always last.
 *
 * An artifact whose URL escapes the base is dropped here rather than fetched.
 * If that removes the gz artifact there is nothing left to try, and the caller
 * reports the manifest as unusable.
 */
function downloadPlans(manifest: SnapshotManifest, baseUrl: string): DownloadPlan[] {
  const gzUrl = resolveArtifactUrl(manifest.url, baseUrl);
  // A rejected gz URL condemns the whole manifest, brotli included: the gz
  // artifact is the snapshot's identity, so a manifest that cannot name it is
  // untrustworthy as a whole. Falling through to brotli would silently mask a
  // tampered or misconfigured manifest instead of reporting it.
  if (!gzUrl) return [];
  const plans: DownloadPlan[] = [];
  const brotliUrl = manifest.brotli ? resolveArtifactUrl(manifest.brotli.url, baseUrl) : null;
  if (manifest.brotli && brotliUrl && !brotliDisabled()) {
    plans.push({
      encoding: 'brotli',
      url: brotliUrl,
      sha256: manifest.brotli.sha256,
      sizeBytes: manifest.brotli.sizeBytes,
      maxOutputBytes: maxOutputBytesFor(manifest, manifest.brotli.sizeBytes),
      progressBase: 0,
    });
  }
  if (gzUrl) {
    plans.push({
      encoding: 'gzip',
      url: gzUrl,
      sha256: manifest.sha256,
      sizeBytes: manifest.sizeBytes,
      maxOutputBytes: maxOutputBytesFor(manifest, manifest.sizeBytes),
      progressBase: 0,
    });
  }
  return plans;
}

/**
 * How many times the handle switch may re-install before giving up.
 *
 * See the loop in `bootstrapFromSnapshot`: each pass past the first needs a
 * fresh random variant name to collide with a peer's, so the cap is never
 * reached in practice. It exists so the loop cannot spin on a filesystem
 * behaving in a way this code did not anticipate.
 */
const MAX_SWITCH_PASSES = 4;

/**
 * Download the DB file — brotli when the manifest offers it, gzip otherwise or
 * on any brotli failure — verify sha256, install it as a new versioned
 * file and point the data dir at it.
 *
 * Never rejects: transport, filesystem and verification failures all surface as
 * `{ ok: false, reason }`.
 */
export async function bootstrapFromSnapshot(opts: BootstrapOptions = {}): Promise<BootstrapResult> {
  const t0 = Date.now();
  const baseUrl = (opts.baseUrl ?? DEFAULT_SNAPSHOT_BASE).replace(/\/+$/, '');
  const nominalPath = opts.dbPath ?? join(getDataDir(), 'data.db');

  try {
    const currentPath = resolveCurrentDbPath(nominalPath);
    const exists = await fileExistsNonEmpty(currentPath);
    if (exists && !opts.force && !opts.refresh) {
      return { ok: false, reason: 'db-already-exists' };
    }

    const previous = opts.force ? null : await readSnapshotState(nominalPath);

    const manifest = await fetchSnapshotManifest(baseUrl, opts.signal, {
      timeoutMs: opts.manifestTimeoutMs,
      fetchImpl: opts.fetchImpl,
    });
    if (!manifest) {
      return { ok: false, reason: 'manifest-fetch-failed' };
    }

    const now = new Date().toISOString();
    // A pointer whose own file is gone is *not* up to date, whatever digest it
    // records. `resolveCurrentDbPath` has silently fallen back to the nominal
    // name, which is at best an older database and at worst the empty one
    // `initDatabase` created there on the way past. Accepting the digest match
    // then wedges the data dir: every later check matches too, so the empty file
    // is served until a new digest is published. Re-installing costs one
    // download and repairs it, which is also what makes the pointer races below
    // self-healing rather than terminal.
    const pointerIntact =
      !previous?.dbFile || currentPath === join(dirname(nominalPath), basename(previous.dbFile));
    // Whether the pointer's provenance still describes a file we actually hold.
    // Everything the pointer records — its digest, its ETag — is a claim about
    // that file, and every use of those below is conditional on this.
    const holdsPointerFile = exists && pointerIntact;
    // Already running the published snapshot — including a pre-versioning
    // install still serving it out of the legacy `data.db`, which stays put
    // until a genuinely newer snapshot gives us a versioned file to switch to.
    if (previous && previous.sha256 === manifest.sha256 && holdsPointerFile) {
      // Re-reads the pointer rather than writing back the copy read above: this
      // runs on every routine freshness check, and a peer may have moved the
      // data dir on to a newer snapshot in the meantime.
      await reconcileSnapshotPointer(nominalPath, manifest.sha256, now);
      return { ok: false, reason: 'snapshot-up-to-date', manifest, dbPath: currentPath };
    }

    try {
      await mkdir(dirname(nominalPath), { recursive: true });
    } catch (err) {
      return { ok: false, reason: `data-dir-failed: ${errorMessage(err)}` };
    }
    const tmpPath = downloadTempPath(nominalPath);

    // Brotli first when offered, gzip always last. Everything but the final
    // candidate is best-effort: a failure there is recorded and the next
    // artifact is tried, so a broken brotli object degrades bandwidth, never
    // availability.
    const plans = downloadPlans(manifest, baseUrl);
    if (plans.length === 0) {
      return { ok: false, reason: 'manifest-url-rejected', manifest };
    }
    const attempted: string[] = [];
    let plan = plans[plans.length - 1];
    let outcome: DownloadOutcome = { status: 'failed', reason: 'no-artifact', bytes: 0 };
    // Every byte pulled over the wire, failed attempts included: a fallback
    // that hides the abandoned transfer would understate the very cost this
    // whole two-artifact scheme exists to reduce.
    let bytesTransferred = 0;
    for (const candidate of plans) {
      // The pointer's ETag describes the gz object (see SnapshotState.etag), so
      // it is only ever replayed as If-None-Match against the gz artifact — and
      // only while we still hold the file it validates. A validator is a
      // statement about bytes we have; sending one when we have none invites a
      // truthful 304 that leaves nothing to install. That is not academic: it
      // is exactly the repair path `pointerIntact` opens above, so replaying
      // the ETag there would wedge the data dir on an empty fallback until a
      // new digest is published — the failure that guard exists to end, and the
      // "the next refresh reinstalls" promise the pointer races rest on.
      const ifNoneMatch =
        candidate.encoding === 'gzip' && holdsPointerFile ? previous?.etag : undefined;
      const attempt = await downloadToTemp(
        { ...candidate, progressBase: bytesTransferred },
        tmpPath,
        opts,
        ifNoneMatch,
      );
      plan = candidate;
      outcome = attempt;
      bytesTransferred += attempt.bytes;
      if (attempt.status === 'ok') break;
      // The last candidate's outcome is the bootstrap's outcome. A cancelled
      // run stops here too: retrying the fallback would ignore the caller.
      if (candidate === plans[plans.length - 1] || opts.signal?.aborted) break;
      // 'not-modified' lands here as well: we sent no validator for a
      // non-gz artifact, so a 304 leaves us with nothing to install.
      attempted.push(`${candidate.encoding}: ${attempt.reason ?? attempt.status}`);
    }
    const withAttempts = (reason: string | undefined): string | undefined =>
      attempted.length > 0 ? `${reason ?? 'download-failed'} (after ${attempted.join('; ')})` : reason;

    if (outcome.status === 'not-modified' && !holdsPointerFile) {
      // Nothing went out for this to be an answer to — no validator is sent
      // while the pointer's file is missing. An origin or proxy that answers
      // 304 anyway leaves us with no bytes and no local copy, which is a failed
      // download and must be reported as one: `snapshot-not-yet-published`
      // asserts we already hold these bytes, and here we hold nothing.
      return {
        ok: false,
        reason: withAttempts('download-failed-304'),
        manifest,
        bytesDownloaded: bytesTransferred,
      };
    }
    if (outcome.status === 'not-modified') {
      // Our ETag still matches the bytes served for the manifest's sha, so the
      // durable file lags the manifest. Deliberately *not* stamping checkedAt:
      // recording a successful check here would suppress the retry for a whole
      // refresh interval over a discrepancy that resolves in minutes.
      return {
        ok: false,
        reason: withAttempts('snapshot-not-yet-published'),
        manifest,
        dbPath: currentPath,
        bytesDownloaded: bytesTransferred,
      };
    }
    if (outcome.status === 'failed') {
      return {
        ok: false,
        reason: withAttempts(outcome.reason),
        bytesDownloaded: bytesTransferred,
        manifest,
      };
    }

    const canonicalPath = versionedDbPath(nominalPath, manifest.sha256);
    const promoted = await promoteDownload(tmpPath, canonicalPath);
    if (promoted.status === 'failed') {
      await unlink(tmpPath).catch(() => {});
      return { ok: false, reason: `install-failed: ${promoted.reason}`, manifest };
    }
    // Not necessarily the canonical name for this digest — see promoteDownload.
    let targetPath = promoted.path;
    // Set only while `targetPath` is a file a peer installed rather than one we
    // created: the verified bytes stay in hand until that file is proved real.
    let spare = promoted.temp;

    /** Hand `targetPath` to the caller; the reason it refused, or null. */
    const activateNow = async (): Promise<string | null> => {
      try {
        if (opts.activate) await opts.activate(targetPath);
        return null;
      } catch (err) {
        // The caller could not take up the new file; leave the pointer where it
        // is (their old handle is still open and valid) and let the sweep
        // reclaim the orphan once its grace period lapses.
        return `activate-failed: ${errorMessage(err)}`;
      }
    };

    try {
      // Normally one pass, two when a repair is needed. A pass can only repeat
      // when the fresh variant name it drew was *already* taken by a file
      // `adopt` accepts as this very snapshot — a random six-character suffix
      // colliding with a peer's copy — so repetition is a lottery win, not a
      // loop condition. The cap makes termination a fact, not a probability.
      for (let pass = 0; ; pass += 1) {
        if (!spare) {
          const failure = await activateNow();
          if (failure) return { ok: false, reason: failure, manifest };
          break;
        }
        // A file somebody else installed can be unlinked out from under this
        // switch by a sweep pass that read its mtime before we claimed it, and
        // `initDatabase` does not fail on a name with no file at it: it creates
        // a brand-new empty database there, on top of the `-wal` the sweep
        // deliberately left behind. Presence therefore proves nothing *after*
        // the fact — the name is occupied either way — so what is compared is
        // identity. Same inode before and after means the caller opened the
        // snapshot; anything else means it opened a stand-in, and the verified
        // copy we are still holding is what repairs it.
        const adopted = await fileIdentity(targetPath);
        if (adopted !== null) {
          const failure = await activateNow();
          if (failure) return { ok: false, reason: failure, manifest };
          if ((await fileIdentity(targetPath)) === adopted) break;
          // The stand-in is unlinked as well as replaced. `adopt` refuses to
          // trust it, so leaving it would be survivable — but it wears a
          // verified digest in its name, every peer scanning for variants meets
          // it, and nothing else will ever remove it while peers keep touching
          // it. Both halves are wanted: the guard covers the crash between
          // these two lines, this covers the steady state.
          await discardStandIn(targetPath, spare);
        }
        if (pass + 1 >= MAX_SWITCH_PASSES) {
          return {
            ok: false,
            reason: `install-failed: adopted file kept changing under the switch (${targetPath})`,
            manifest,
          };
        }
        const reinstalled = await promoteTo(spare, variantDbPath(canonicalPath));
        if (reinstalled.status === 'failed') {
          return { ok: false, reason: `install-failed: ${reinstalled.reason}`, manifest };
        }
        targetPath = reinstalled.path;
        // Undefined when we created the file — the ordinary outcome, and the
        // one that ends the loop. Set only when the fresh name turned out to be
        // occupied by this very snapshot, in which case the verified bytes are
        // still ours to release and the new name is checked like any other.
        spare = reinstalled.temp;
      }
    } finally {
      // Released only here: past this point the caller holds the file open, and
      // on POSIX an open database survives its own unlink.
      if (spare) await unlink(spare).catch(() => {});
    }

    const state: SnapshotState = {
      dbFile: basename(targetPath),
      sha256: manifest.sha256,
      publishedAt: manifest.publishedAt,
      // Only ever the gz object's validator: replaying a brotli ETag against
      // the gz URL on a later refresh would be a validator for other bytes.
      etag: plan.encoding === 'gzip' ? outcome.etag : undefined,
      serverCount: manifest.serverCount,
      sizeBytes: manifest.sizeBytes,
      installedAt: now,
      checkedAt: now,
    };
    const published = await publishSnapshotState(nominalPath, state);
    if (published.status === 'failed') {
      // The handle switch already happened, so this is not a silent nicety: the
      // data dir still selects the *old* file, and every process that starts
      // from here — including this one, after a restart — reads that pointer.
      // Say so loudly; the next run repairs it by installing again.
      return {
        ok: false,
        reason: `pointer-write-failed: ${published.reason}`,
        bytesDownloaded: bytesTransferred,
        manifest,
        dbPath: targetPath,
      };
    }

    // Sweeping keys off the pointer, so it must not run when a peer's newer
    // pointer is the one in force — the file we just installed is not current.
    if (published.status === 'written') {
      await sweepSnapshotFiles(nominalPath, { retainHours: opts.retainHours }).catch(() => []);
    }

    return {
      ok: true,
      reason:
        published.status === 'superseded'
          ? published.by.sha256 === state.sha256
            ? // Not a rollback and not a loss: a peer installed these very bytes
              // first, so the pointer already selects a file with this digest.
              `pointer-retained-same-digest (${published.by.dbFile})`
            : `pointer-retained-newer-snapshot (${published.by.sha256.slice(0, 16)})`
          : undefined,
      servers: manifest.serverCount,
      publishedAt: manifest.publishedAt,
      bytesDownloaded: bytesTransferred,
      durationMs: Date.now() - t0,
      manifest,
      dbPath: targetPath,
    };
  } catch (err) {
    // Defence in depth: the caller runs before the MCP handshake.
    return { ok: false, reason: `bootstrap-error: ${errorMessage(err)}` };
  }
}
