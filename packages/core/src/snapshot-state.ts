/**
 * Versioned snapshot files and the pointer that selects the current one.
 *
 * A user typically runs several MCP clients at once — Claude Desktop, Cursor,
 * Claude Code — and each starts its *own* mcpfinder process against the same
 * data dir. Replacing `data.db` in place therefore meant unlinking a peer's
 * `-wal` without a checkpoint (losing its committed rows, stranding it on a
 * ghost inode) and, on Windows, failing the rename outright *after* the
 * sidecars were already gone.
 *
 * So nothing is ever replaced. Each snapshot is written to its own file named
 * after its `sha256` (`data-<sha16>.db`), and a small JSON pointer records
 * which one is current. A process only ever *adds* files; a peer holding an
 * older one keeps working against a file nobody touches.
 *
 * The pointer doubles as the provenance sidecar (`<db>.snapshot.json`). Keeping
 * them in one file is deliberate: the provenance always describes exactly the
 * file the pointer selects, so there is no way for the two to disagree, and a
 * switch is a single atomic rename instead of two writes that can interleave.
 *
 * Retention rests on one POSIX property: unlinking a DB file another process
 * has open is harmless to it — it keeps working against its inode. What is
 * never harmless is unlinking that file's `-wal`/`-shm`, because SQLite reaches
 * for those *by name*. So the sweep removes the database file and nothing else,
 * ever — including journals whose database is already gone. From the outside
 * an abandoned journal and one belonging to a peer that outlived its own
 * database file are indistinguishable, and deleting the second is corruption.
 *
 * The residue that leaves is real but much smaller than it used to be. A crawl
 * is applied in one transaction, so the journal grows to the size of the whole
 * write: 40MB of `-wal` and 1MB of `-shm` were measured beside a 323MB database
 * precisely because nothing ever trimmed them. Every successful sync now ends
 * with `PRAGMA wal_checkpoint(TRUNCATE)` (see `checkpointWal` in db.ts), so a
 * journal is folded back and truncated as it goes; what survives a process
 * killed with SIGKILL — how MCP clients usually stop stdio servers — is
 * whatever accumulated since the last checkpoint, not the whole crawl.
 *
 * Known, accepted consequence: when process A switches to a newer snapshot,
 * process B keeps writing live-sync results into the older file, and those
 * writes are lost the next time B switches. The published snapshot is the
 * source of truth for the catalog, so a dropped incremental crawl only costs a
 * later re-sync.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

/** How long a superseded DB file is kept before it may be swept. */
export const DEFAULT_RETAIN_HOURS = 48;
/** How long an abandoned partial download is kept before it may be swept. */
export const DEFAULT_DOWNLOAD_STALE_HOURS = 6;
/** Length of the sha256 prefix embedded in a versioned file name. */
const SHA_PREFIX_LEN = 16;
/** Length of the disambiguating suffix on a variant file name (see below). */
const VARIANT_SUFFIX_LEN = 6;

/**
 * Pointer + provenance for the installed snapshot, persisted next to the
 * nominal DB path as `<db>.snapshot.json`.
 */
export interface SnapshotState {
  /**
   * Basename of the versioned DB file this pointer selects. Absent on installs
   * that predate versioned files — those still run from the legacy `data.db`
   * until the first successful download produces a versioned one.
   */
  dbFile?: string;
  sha256: string;
  publishedAt: string;
  /** ETag of the gz file, replayed as If-None-Match on refresh checks. */
  etag?: string;
  serverCount?: number;
  sizeBytes?: number;
  /** When this snapshot was installed locally (ISO). */
  installedAt: string;
  /** When we last verified it against the manifest (ISO). */
  checkedAt: string;
}

/** Path of the pointer/provenance file for a nominal DB path. */
export function snapshotStatePath(nominalDbPath: string): string {
  return `${nominalDbPath}.snapshot.json`;
}

/** True for a syntactically valid lowercase-able sha256 digest. */
export function isValidSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value);
}

/** File name a snapshot with this digest is installed under. */
export function versionedDbPath(nominalDbPath: string, sha256: string): string {
  const ext = extname(nominalDbPath);
  const stem = basename(nominalDbPath, ext);
  return join(dirname(nominalDbPath), `${stem}-${sha256.slice(0, SHA_PREFIX_LEN)}${ext}`);
}

/**
 * A second, equally valid home for a digest whose canonical name is unusable.
 *
 * File names come from the digest, so the same name recurs: a snapshot swept
 * months ago can be published again. The sweep unlinks the DB file but never
 * its `-wal`/`-shm` (a peer may still be using those *by name*), so the
 * canonical name can be sitting there with a journal that belongs to somebody
 * else's database. Installing under it would adopt that journal — the exact
 * corruption the versioned layout exists to prevent — so the install goes to a
 * variant name instead, and the stranded sidecars are left to their owner.
 */
export function variantDbPath(versionedPath: string): string {
  const ext = extname(versionedPath);
  const stem = basename(versionedPath, ext);
  const suffix = Math.random()
    .toString(36)
    .slice(2, 2 + VARIANT_SUFFIX_LEN)
    .padEnd(VARIANT_SUFFIX_LEN, '0');
  return join(dirname(versionedPath), `${stem}-${suffix}${ext}`);
}

/** Temp path for an in-flight download. Unique per process *and* per attempt. */
export function downloadTempPath(nominalDbPath: string): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `${nominalDbPath}.download-${process.pid}-${suffix}`;
}

function parseState(raw: string): SnapshotState | null {
  const parsed = JSON.parse(raw) as SnapshotState;
  if (!parsed || typeof parsed.sha256 !== 'string') return null;
  if (parsed.dbFile !== undefined && typeof parsed.dbFile !== 'string') return null;
  return parsed;
}

/** Read the pointer; returns null when absent or unreadable. */
export async function readSnapshotState(nominalDbPath: string): Promise<SnapshotState | null> {
  try {
    return parseState(await readFile(snapshotStatePath(nominalDbPath), 'utf8'));
  } catch {
    return null;
  }
}

/** Synchronous pointer read, for use before the server opens its handle. */
export function readSnapshotStateSync(nominalDbPath: string): SnapshotState | null {
  try {
    return parseState(readFileSync(snapshotStatePath(nominalDbPath), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Persist the pointer atomically. Never throws.
 *
 * The pointer is a few hundred bytes that nobody holds open, so writing beside
 * it and renaming over it is safe on every platform — unlike renaming over a
 * DB file a peer may have mapped.
 */
export async function writeSnapshotState(
  nominalDbPath: string,
  state: SnapshotState,
): Promise<void> {
  await tryWriteSnapshotState(nominalDbPath, state);
}

/** As `writeSnapshotState`, but reports what went wrong instead of shrugging. */
async function tryWriteSnapshotState(
  nominalDbPath: string,
  state: SnapshotState,
): Promise<string | null> {
  const target = snapshotStatePath(nominalDbPath);
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await mkdir(dirname(nominalDbPath), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(tmp, target);
    return null;
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => {});
    return err instanceof Error ? err.message : String(err);
  }
}

export type PublishOutcome =
  /** The pointer now selects `state`. */
  | { status: 'written' }
  /** A peer had already pointed the data dir at something at least as new. */
  | { status: 'superseded'; by: SnapshotState }
  /** The pointer could not be persisted; the data dir still selects the old file. */
  | { status: 'failed'; reason: string };

/** Ordering between two pointer candidates, by publication time. */
function isAtLeastAsNew(existing: SnapshotState, candidate: SnapshotState): boolean {
  const a = Date.parse(existing.publishedAt ?? '');
  const b = Date.parse(candidate.publishedAt ?? '');
  // A candidate we cannot place in time still wins: its bytes are already
  // verified and activated, and refusing would strand the caller on a pointer
  // that names a file it no longer runs.
  if (!Number.isFinite(b)) return false;
  if (!Number.isFinite(a)) return false;
  if (a !== b) return a > b;
  // Same instant, different builds: pick by digest so every peer that sees this
  // pair makes the same choice and the pointer stops flapping.
  return existing.sha256 > candidate.sha256;
}

/**
 * Move the pointer to a freshly installed snapshot, never backwards.
 *
 * Peers download independently, so a process that started fetching an older
 * snapshot can finish *after* a peer installed a newer one. Writing
 * unconditionally would roll the whole data dir back: the newer file drops out
 * of the pointer, the sweep reclaims it, and the next refresh pays for the full
 * download again.
 *
 * The check is read-compare-write, so it narrows the race rather than closing
 * it: two peers can still both read the same predecessor. That is deliberate.
 * The events being ordered are minutes to hours apart (a refresh interval is
 * never shorter than 15 minutes) while the window is the few milliseconds
 * between the read and the rename, and losing it costs nothing durable —
 * snapshot files are immutable and an open one survives its own unlink, so the
 * loser keeps serving valid data and the next refresh re-converges. A lock file
 * would close the window at the price of a far more common failure mode: a
 * stuck lock left by a killed process, blocking every future install.
 */
export async function publishSnapshotState(
  nominalDbPath: string,
  state: SnapshotState,
): Promise<PublishOutcome> {
  const existing = await readSnapshotState(nominalDbPath);
  if (
    existing &&
    existing.sha256 !== state.sha256 &&
    isNonEmptyFile(pointerTarget(nominalDbPath, existing)) &&
    isAtLeastAsNew(existing, state)
  ) {
    return { status: 'superseded', by: existing };
  }
  const reason = await tryWriteSnapshotState(nominalDbPath, state);
  return reason ? { status: 'failed', reason } : { status: 'written' };
}

/**
 * The database file an existing pointer stands for.
 *
 * `dbFile` names it outright. A pointer without one predates versioned files:
 * it stands for the legacy nominal `data.db`, or — once a versioned file for
 * its digest has been installed but `reconcileSnapshotPointer` has not caught
 * up — for that file. Resolving it matters because the ordering guard keys off
 * whether the file is still there: skipping the guard for a `dbFile`-less
 * pointer would let a *staler* snapshot overwrite it, which is precisely the
 * backwards move the pointer is supposed to make impossible.
 */
function pointerTarget(nominalDbPath: string, state: SnapshotState): string {
  if (state.dbFile) return join(dirname(nominalDbPath), basename(state.dbFile));
  if (isNonEmptyFile(nominalDbPath)) return nominalDbPath;
  return versionedDbPath(nominalDbPath, state.sha256);
}

function isNonEmptyFile(path: string): boolean {
  try {
    const s = statSync(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

/**
 * The DB file this data dir is currently serving from.
 *
 * Falls back to the nominal path (the legacy `~/.mcpfinder/data.db`) whenever
 * the pointer is missing or names a file that is gone — which is also how an
 * install predating versioned files keeps running: its `data.db` stays the
 * current database until a download produces a versioned replacement.
 */
export function resolveCurrentDbPath(nominalDbPath: string): string {
  const state = readSnapshotStateSync(nominalDbPath);
  if (state?.dbFile) {
    const candidate = join(dirname(nominalDbPath), basename(state.dbFile));
    if (isNonEmptyFile(candidate)) return candidate;
  }
  if (isNonEmptyFile(nominalDbPath)) return nominalDbPath;
  return freshNominalPath(nominalDbPath);
}

/**
 * The variant name this process fell back to for a nominal path, if any.
 *
 * Decided once and remembered, because two callers must agree: whoever opens
 * the database, and `sweepSnapshotFiles`, which asks the same question to work
 * out which file it must never reclaim. A second random draw would leave the
 * open file unprotected.
 */
const nominalFallbacks = new Map<string, string>();

/**
 * Where to put a *new* nominal database, given the name may not be free.
 *
 * The nominal name gets the same protection `promoteDownload` gives versioned
 * ones. Once the legacy `data.db` has been swept, its `-wal`/`-shm` stay behind
 * for their owner, and creating a fresh database at that name would adopt
 * somebody else's journal — verified locally: SQLite maps the stale `-shm` by
 * name and unlinks the abandoned `-wal` on close. Reopening the name is not a
 * hypothetical either; deleting the pointer is enough to send us back to it.
 * So, exactly as at install time, the new database goes to a variant name and
 * the stranded journal is left to whoever still needs it.
 *
 * Costs one small, sweepable empty database per process in that state, until a
 * successful download writes a pointer that names a file again.
 */
function freshNominalPath(nominalDbPath: string): string {
  const memo = nominalFallbacks.get(nominalDbPath);
  if (memo) return memo;
  if (!existsSync(`${nominalDbPath}-wal`) && !existsSync(`${nominalDbPath}-shm`)) {
    return nominalDbPath;
  }
  const variant = variantDbPath(nominalDbPath);
  nominalFallbacks.set(nominalDbPath, variant);
  return variant;
}

/**
 * Record that the pointer in force was verified against the manifest just now.
 *
 * This runs on every routine freshness check, which is far more often than an
 * install, so it re-reads the pointer instead of rewriting the copy this
 * process read minutes ago: a peer may have moved the data dir on to a newer
 * snapshot in between, and stamping our stale copy back would roll it back.
 * When that has happened there is nothing of ours left to stamp, so it is a
 * no-op.
 *
 * It also tidies a pointer that names no file at all — the shape written before
 * versioned files existed — up to the versioned file for its own digest, once
 * one is actually present. That state is otherwise perfectly valid and would
 * simply never be reconciled.
 */
export async function reconcileSnapshotPointer(
  nominalDbPath: string,
  sha256: string,
  checkedAt: string,
): Promise<void> {
  const current = await readSnapshotState(nominalDbPath);
  if (!current || current.sha256 !== sha256) return;
  const next: SnapshotState = { ...current, checkedAt };
  const versioned = basename(versionedDbPath(nominalDbPath, sha256));
  if (!current.dbFile && isNonEmptyFile(join(dirname(nominalDbPath), versioned))) {
    next.dbFile = versioned;
  }
  await writeSnapshotState(nominalDbPath, next);
}

export interface SweepOptions {
  /** Grace period before a superseded DB file may be removed. */
  retainHours?: number;
  /** Grace period before an abandoned partial download may be removed. */
  downloadStaleHours?: number;
  /** Injected clock, for tests. */
  now?: number;
}

function envHours(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Newest mtime across a DB file and its WAL sidecars, or 0 when absent. */
async function newestMtime(paths: string[]): Promise<number> {
  let newest = 0;
  for (const path of paths) {
    try {
      const s = await stat(path);
      if (s.mtimeMs > newest) newest = s.mtimeMs;
    } catch {
      /* missing sidecar — nothing to weigh in */
    }
  }
  return newest;
}

/**
 * Delete superseded snapshot files and abandoned partial downloads.
 *
 * Two rules for what may go, and one absolute prohibition:
 *
 * 1. the file the pointer selects is never a candidate, at any age;
 * 2. what is left must have been untouched for the whole grace period —
 *    sidecar mtimes count towards that, so a peer actively writing keeps its
 *    file young, and a peer's in-flight download is not mistaken for a
 *    leftover;
 * 3. a `-wal`/`-shm` is never removed. Not alongside its database, not once the
 *    database is gone, not at any age. A peer that has the file open reaches
 *    for its journal *by name*, and an orphaned journal is indistinguishable
 *    from one whose owner is still running — so unlinking it is the corruption
 *    this design exists to prevent. They are not the kilobytes an earlier
 *    version of this comment claimed: 40MB of `-wal` and 1MB of `-shm` were
 *    measured beside a 323MB database, because a crawl commits as one
 *    transaction; `checkpointWal` after each successful sync is what keeps that
 *    from being what a killed process leaves behind. A database name that comes
 *    back later is handled at install time instead (see `variantDbPath`).
 *
 * Removal failures are normal, not errors: on Windows an open file refuses to
 * go, so stale snapshots simply accumulate there until nothing holds them.
 */
export async function sweepSnapshotFiles(
  nominalDbPath: string,
  opts: SweepOptions = {},
): Promise<string[]> {
  const dir = dirname(nominalDbPath);
  const ext = extname(nominalDbPath);
  const stem = basename(nominalDbPath, ext);
  // Canonical `data-<sha16>.db`, the variant `data-<sha16>-<rand6>.db` a
  // returning name forces us onto, and the bare `data-<rand6>.db` an unusable
  // *nominal* name forces us onto — all ordinary snapshot files here.
  const versioned = new RegExp(
    `^${escapeRegExp(stem)}-([0-9a-f]{${SHA_PREFIX_LEN}}` +
      `(-[0-9a-z]{${VARIANT_SUFFIX_LEN}})?|[0-9a-z]{${VARIANT_SUFFIX_LEN}})${escapeRegExp(ext)}$`,
  );
  const downloadPrefix = `${basename(nominalDbPath)}.download-`;

  const retainMs =
    (opts.retainHours ?? envHours('MCPFINDER_SNAPSHOT_RETAIN_HOURS', DEFAULT_RETAIN_HOURS)) *
    3_600_000;
  const downloadMs =
    (opts.downloadStaleHours ??
      envHours('MCPFINDER_SNAPSHOT_DOWNLOAD_STALE_HOURS', DEFAULT_DOWNLOAD_STALE_HOURS)) *
    3_600_000;
  const now = opts.now ?? Date.now();

  const current = basename(resolveCurrentDbPath(nominalDbPath));
  const removed: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return removed;
  }

  for (const entry of entries) {
    const isVersioned = versioned.test(entry);
    const isLegacy = entry === basename(nominalDbPath);
    const isDownload = entry.startsWith(downloadPrefix);
    if (!isVersioned && !isLegacy && !isDownload) continue;
    // The database in use is never a candidate, whatever its age.
    if (entry === current) continue;

    const path = join(dir, entry);
    const grace = isDownload ? downloadMs : retainMs;
    const witnesses = isDownload ? [path] : [path, `${path}-wal`, `${path}-shm`];
    const mtime = await newestMtime(witnesses);
    if (mtime === 0 || now - mtime < grace) continue;

    // The DB file and nothing else. A peer holding it open is unaffected on
    // POSIX; on Windows the unlink simply fails and the file stays.
    await rm(path, { force: true }).catch(() => {});
    if (!existsSync(path)) removed.push(entry);
  }

  return removed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
