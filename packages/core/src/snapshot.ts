/**
 * Pre-built DB snapshot bootstrap.
 *
 * Downloads a gzipped SQLite file produced by a scheduled builder and installs
 * it into the data dir as a new, immutable, sha-named file. This replaces the
 * ~11 min cold-start sync with a single download on first run.
 *
 * Protocol (served by api-worker):
 *   GET <base>/manifest.json   → { publishedAt, serverCount, sha256, sizeBytes, url }
 *   GET <base>/data.sqlite.gz?sha=<sha256> → immutable gzipped SQLite file
 *
 * Nothing is ever overwritten: the verified download becomes `data-<sha16>.db`
 * and a pointer file switches over to it (see snapshot-state.ts for why). Peer
 * processes on the same data dir keep running against whichever file they
 * opened.
 *
 * Failure policy: every path returns `{ ok: false, reason }`. Nothing here ever
 * rejects — the caller runs before the MCP handshake, where an unhandled
 * rejection would kill the process instead of degrading to a live sync.
 */
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { getDataDir } from './db.js';
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

export interface SnapshotManifest {
  publishedAt: string;
  serverCount: number;
  /** Required, lowercase hex sha256 of the gzipped file. */
  sha256: string;
  sizeBytes: number;
  /** Relative or absolute URL of the gzipped DB file. */
  url: string;
  /** Builder version / git SHA, for diagnostics. */
  builder?: string;
}

export interface BootstrapResult {
  ok: boolean;
  reason?: string;
  servers?: number;
  publishedAt?: string;
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
  /** Progress callback for the DB download. `total` comes from the manifest. */
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

async function fileExistsNonEmpty(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
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
    return { ...manifest, sha256: manifest.sha256.toLowerCase() };
  } catch {
    return null;
  }
}

interface DownloadOutcome {
  status: 'ok' | 'not-modified' | 'failed';
  reason?: string;
  bytes: number;
  etag?: string;
}

async function downloadToTemp(
  dataUrl: string,
  tmpPath: string,
  manifest: SnapshotManifest,
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
    const res = await doFetch(dataUrl, {
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
    const gzStream = Readable.fromWeb(res.body as never);
    gzStream.on('data', (chunk: Buffer) => {
      hash.update(chunk);
      bytesIn += chunk.length;
      armStall();
      try {
        opts.onProgress?.(bytesIn, manifest.sizeBytes ?? 0);
      } catch {
        // A caller's progress callback must not become an uncaught exception
        // out of a stream handler — that would kill the process the whole
        // "never rejects" contract exists to protect.
      }
    });

    try {
      await pipeline(gzStream, createGunzip(), createWriteStream(tmpPath));
    } catch (err) {
      await unlink(tmpPath).catch(() => {});
      const reason = stalled
        ? `download-stalled after ${stallMs}ms (${bytesIn} bytes received)`
        : `decompress-failed: ${errorMessage(err)}`;
      return { status: 'failed', reason, bytes: bytesIn };
    }

    const gotSha = hash.digest('hex');
    if (gotSha !== manifest.sha256) {
      await unlink(tmpPath).catch(() => {});
      return {
        status: 'failed',
        reason: `sha256-mismatch (expected ${manifest.sha256}, got ${gotSha})`,
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

/** Errors from `link` that mean "this filesystem has no hard links". */
const NO_HARDLINK_CODES = new Set(['EPERM', 'EOPNOTSUPP', 'ENOTSUP', 'ENOSYS', 'EXDEV', 'EMLINK']);

/** Where a verified download ended up, or why it could not be installed. */
export type PromoteOutcome =
  | { status: 'ok'; path: string }
  | { status: 'failed'; reason: string };

/** Discard our copy and run with the one already there. */
async function adopt(tmpPath: string, targetPath: string): Promise<PromoteOutcome> {
  await unlink(tmpPath).catch(() => {});
  return { status: 'ok', path: targetPath };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when the name has a journal but no database — the footprint of a file
 * the sweep reclaimed while a peer still had it open.
 */
async function hasStrandedSidecars(targetPath: string): Promise<boolean> {
  return (await pathExists(`${targetPath}-wal`)) || (await pathExists(`${targetPath}-shm`));
}

/**
 * Promote a verified download to its sha-named home, without ever overwriting.
 *
 * `rename` would happily replace the target, and two installers of the same
 * digest genuinely race here: both see no target, both promote, and the second
 * one strands the first on a ghost inode whose `-wal` no longer belongs to it.
 * `link` cannot do that — it fails with `EEXIST` atomically — so it, not the
 * existence check, is what makes this safe; the check ahead of it only saves a
 * pointless syscall in the common case.
 *
 * Whoever loses adopts the winner's file: same digest, same name, same bytes.
 *
 * Names recur, though: the sweep unlinks a superseded database but deliberately
 * leaves its `-wal`/`-shm` to whichever peer still has that file open, so a
 * digest published again months later can find a journal already sitting at its
 * name. Taking that name would mean opening somebody else's journal as our own.
 * Neither is deleting it an option — it is still in use. So the install goes to
 * a variant name and both databases end up with a journal of their own; the
 * caller is told which name it actually got. The canonical name is re-checked
 * immediately before that decision, because a peer landing there in the gap
 * would otherwise cost a second full copy of identical bytes.
 *
 * Filesystems without hard links (FAT/exFAT volumes, some network mounts) fall
 * back to `rename`, which is atomic but *not* exclusive. There the original
 * race window remains, narrowed to the gap between the check and the rename.
 */
export async function promoteDownload(
  tmpPath: string,
  targetPath: string,
): Promise<PromoteOutcome> {
  if (await fileExistsNonEmpty(targetPath)) return adopt(tmpPath, targetPath);
  if (!(await hasStrandedSidecars(targetPath))) return promoteTo(tmpPath, targetPath);
  const target = variantDbPath(targetPath);
  // Re-check the canonical name before committing to a variant: the sidecar
  // probe is check-then-act, and a peer that installed the canonical file
  // inside that window would otherwise leave us writing a *second* full
  // ~230MB copy of identical bytes and pointing the data dir at it. Cheap to
  // narrow; the remaining gap is the few syscalls before `link`.
  if (await fileExistsNonEmpty(targetPath)) return adopt(tmpPath, targetPath);
  return promoteTo(tmpPath, target);
}

async function promoteTo(tmpPath: string, targetPath: string): Promise<PromoteOutcome> {
  try {
    await link(tmpPath, targetPath);
    // The target now owns the content; the temp name is just a second link.
    await unlink(tmpPath).catch(() => {});
    return { status: 'ok', path: targetPath };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') {
      // A peer got there first — provided what landed is actually usable.
      if (await fileExistsNonEmpty(targetPath)) return adopt(tmpPath, targetPath);
      return { status: 'failed', reason: `target exists but is not a usable file: ${targetPath}` };
    }
    if (code && NO_HARDLINK_CODES.has(code)) {
      return promoteByRename(tmpPath, targetPath);
    }
    if (await fileExistsNonEmpty(targetPath)) return adopt(tmpPath, targetPath);
    return { status: 'failed', reason: errorMessage(err) };
  }
}

async function promoteByRename(tmpPath: string, targetPath: string): Promise<PromoteOutcome> {
  if (await fileExistsNonEmpty(targetPath)) return adopt(tmpPath, targetPath);
  try {
    await rename(tmpPath, targetPath);
    return { status: 'ok', path: targetPath };
  } catch (err) {
    if (await fileExistsNonEmpty(targetPath)) return adopt(tmpPath, targetPath);
    return { status: 'failed', reason: errorMessage(err) };
  }
}

/**
 * Download the gzipped DB file, verify sha256, install it as a new versioned
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
    // Already running the published snapshot — including a pre-versioning
    // install still serving it out of the legacy `data.db`, which stays put
    // until a genuinely newer snapshot gives us a versioned file to switch to.
    if (previous && previous.sha256 === manifest.sha256 && exists) {
      // Re-reads the pointer rather than writing back the copy read above: this
      // runs on every routine freshness check, and a peer may have moved the
      // data dir on to a newer snapshot in the meantime.
      await reconcileSnapshotPointer(nominalPath, manifest.sha256, now);
      return { ok: false, reason: 'snapshot-up-to-date', manifest, dbPath: currentPath };
    }

    const dataUrl = manifest.url.startsWith('http')
      ? manifest.url
      : `${baseUrl}/${manifest.url.replace(/^\/+/, '')}`;

    try {
      await mkdir(dirname(nominalPath), { recursive: true });
    } catch (err) {
      return { ok: false, reason: `data-dir-failed: ${errorMessage(err)}` };
    }
    const tmpPath = downloadTempPath(nominalPath);

    const outcome = await downloadToTemp(dataUrl, tmpPath, manifest, opts, previous?.etag);
    if (outcome.status === 'not-modified') {
      // Our ETag still matches the bytes served for the manifest's sha, so the
      // durable file lags the manifest. Deliberately *not* stamping checkedAt:
      // recording a successful check here would suppress the retry for a whole
      // refresh interval over a discrepancy that resolves in minutes.
      return { ok: false, reason: 'snapshot-not-yet-published', manifest, dbPath: currentPath };
    }
    if (outcome.status === 'failed') {
      return { ok: false, reason: outcome.reason, bytesDownloaded: outcome.bytes, manifest };
    }

    const promoted = await promoteDownload(tmpPath, versionedDbPath(nominalPath, manifest.sha256));
    if (promoted.status === 'failed') {
      await unlink(tmpPath).catch(() => {});
      return { ok: false, reason: `install-failed: ${promoted.reason}`, manifest };
    }
    // Not necessarily the canonical name for this digest — see promoteDownload.
    const targetPath = promoted.path;

    try {
      if (opts.activate) await opts.activate(targetPath);
    } catch (err) {
      // The caller could not take up the new file; leave the pointer where it
      // is (their old handle is still open and valid) and let the sweep reclaim
      // the orphan once its grace period lapses.
      return { ok: false, reason: `activate-failed: ${errorMessage(err)}`, manifest };
    }

    const state: SnapshotState = {
      dbFile: basename(targetPath),
      sha256: manifest.sha256,
      publishedAt: manifest.publishedAt,
      etag: outcome.etag,
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
        bytesDownloaded: outcome.bytes,
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
          ? `pointer-retained-newer-snapshot (${published.by.sha256.slice(0, 16)})`
          : undefined,
      servers: manifest.serverCount,
      publishedAt: manifest.publishedAt,
      bytesDownloaded: outcome.bytes,
      durationMs: Date.now() - t0,
      manifest,
      dbPath: targetPath,
    };
  } catch (err) {
    // Defence in depth: the caller runs before the MCP handshake.
    return { ok: false, reason: `bootstrap-error: ${errorMessage(err)}` };
  }
}
