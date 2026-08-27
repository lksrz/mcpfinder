/**
 * Snapshot-backed catalog lifecycle.
 *
 * The hosted snapshot is tens of megabytes, so downloading it before the MCP
 * handshake would push `initialize` past the client's timeout and get the
 * process killed mid-download. Instead the server opens whatever DB it has
 * (possibly an empty one), connects, and pulls the snapshot in the background.
 *
 * Switching over is deliberately additive. The download lands in a temp file
 * and, once verified, becomes a new sha-named file — the previous one is never
 * touched, so a peer mcpfinder (Claude Desktop, Cursor and Claude Code each run
 * their own) keeps serving from it. In-process the order is: open the new file
 * *first*, publish the handle, and only then retire the old one. There is never
 * a moment without a live handle, so no tool call has to wait on a gate and
 * none can find a closed database.
 */
import type { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';
import {
  bootstrapFromSnapshot,
  closeDatabase,
  getCatalogDbPath,
  getServerCount,
  markSnapshotInstalled,
  readSnapshotState,
  resolveCurrentDbPath,
  sweepSnapshotFiles,
} from '@mcpfinder/core';

/** How old an installed snapshot may get before it is re-checked. */
export const DEFAULT_REFRESH_HOURS = 24;
/**
 * The staleness threshold is checked several times per period: with one tick
 * per period, a tick landing a hair early would skip and the refresh would
 * effectively happen every *other* period.
 */
export const CHECKS_PER_REFRESH_PERIOD = 4;
/** Shortest polling interval, so a tiny refreshHours cannot spin. */
export const MIN_CHECK_INTERVAL_HOURS = 0.25;
/** How long the retired handle is kept open after a switch. */
export const DEFAULT_LINGER_MS = 5_000;
/** How many times a retired handle's `close()` is retried fast before backing off. */
export const RETIRE_CLOSE_ATTEMPTS = 3;
/** Floor on the delay between those retries, so `lingerMs: 0` cannot spin. */
export const RETIRE_RETRY_MIN_MS = 50;
/**
 * Interval of the slow retry the fast attempts hand over to. Long enough that
 * a handle wedged for the life of the process costs a tick a minute, short
 * enough that a handle freed by a finishing statement is reclaimed promptly.
 */
export const RETIRE_SLOW_RETRY_MS = 60_000;

export interface CatalogDeps {
  /** Opens a handle on a specific catalog DB file (schema-migrating). */
  openDb: (dbPath: string) => DatabaseSync;
  getDb: () => DatabaseSync;
  setDb: (db: DatabaseSync) => void;
  /**
   * Awaited before the handle switch: the caller must settle any in-flight
   * writer (a live registry sync) so nothing is still writing through the
   * handle that is about to be retired.
   */
  quiesce?: () => Promise<void>;
  log?: (message: string) => void;
  /** Nominal DB path; defaults to `<data-dir>/data.db`. */
  dbPath?: string;
  baseUrl?: string;
  refreshHours?: number;
  /** Grace period before superseded DB files are swept. */
  retainHours?: number;
  /** How long the retired handle is kept open after a switch. */
  lingerMs?: number;
  /** Interval of the slow close retry that follows the fast attempts. */
  retireSlowRetryMs?: number;
}

export interface Catalog {
  /**
   * The DB file this data dir resolved to when the catalog was constructed —
   * the one the caller must open. Resolved once and handed out, so the handle
   * and the catalog's idea of the current file can never disagree.
   */
  readonly currentDbPath: string;
  /** Kicks off bootstrap (or a refresh check) in the background. Never throws. */
  start(): void;
  /**
   * Awaited by every tool call. Resolves to null when the DB is usable, or to
   * a human-readable notice when the catalog is still being downloaded and
   * there is nothing to serve yet. Never blocks on the download.
   */
  waitUntilUsable(): Promise<string | null>;
  /** True while a snapshot download or handle switch is in progress. */
  isBusy(): boolean;
  /** Resolves when the current background bootstrap/refresh settles. */
  settled(): Promise<void>;
}

function fileIsNonEmpty(path: string): boolean {
  try {
    const s = statSync(path);
    return s.isFile() && s.size > 0;
  } catch {
    return false;
  }
}

function refreshIntervalHours(explicit?: number): number {
  if (typeof explicit === 'number') return explicit;
  const raw = process.env.MCPFINDER_SNAPSHOT_REFRESH_HOURS;
  if (!raw) return DEFAULT_REFRESH_HOURS;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_REFRESH_HOURS;
}

function mb(bytes: number): string {
  return `${(bytes / 1e6).toFixed(1)}MB`;
}

export function createCatalog(deps: CatalogDeps): Catalog {
  const dbPath = deps.dbPath ?? getCatalogDbPath();
  // Resolved exactly once: the caller opens this very path, so there is no
  // second resolution that could land on a different file.
  const currentDbPath = resolveCurrentDbPath(dbPath);
  // Captured before the server opens (and thereby creates) the DB file, so a
  // cold start is still recognisable as a cold start.
  const hadDbAtStartup = fileIsNonEmpty(currentDbPath);
  const disabled = Boolean(process.env.MCPFINDER_DISABLE_SNAPSHOT);
  const baseUrl = deps.baseUrl ?? process.env.MCPFINDER_SNAPSHOT_BASE;
  const refreshHours = refreshIntervalHours(deps.refreshHours);
  const lingerMs = deps.lingerMs ?? DEFAULT_LINGER_MS;
  const retireSlowRetryMs = deps.retireSlowRetryMs ?? RETIRE_SLOW_RETRY_MS;
  const log = deps.log ?? ((message: string) => process.stderr.write(message));

  let downloading = false;
  let switching = false;
  let bytes = 0;
  let total = 0;
  let inFlight: Promise<void> | null = null;

  /**
   * Retire the previous handle after a delay. Nothing should still be using it
   * — every DB access dereferences the current handle at the point of use, and
   * `quiesce` has already settled the one writer that holds it across awaits —
   * but an already-running operation costs nothing to let finish.
   *
   * A peer sweeping the retired file out from under this handle is not a
   * hazard: the sweep unlinks the database and never its journal, and an open
   * database survives its own unlink.
   *
   * A close that keeps failing is never given up on. A stdio server lives as
   * long as the client that spawned it — days — and abandoning the handle would
   * park a file descriptor and a WAL lock on a superseded file for all of it,
   * on every refresh. So the fast attempts hand over to a slow ticker that
   * keeps trying indefinitely; whatever was holding the handle (a statement
   * still stepping) eventually finishes and the close lands. Every timer is
   * unref'd, so a handle that never closes cannot by itself keep the process
   * alive.
   */
  function retire(previous: DatabaseSync): void {
    let attempts = 0;
    let lastError: Error | null = null;

    /** True once the handle is actually gone. */
    const tryClose = (): boolean => {
      attempts += 1;
      try {
        // Checkpoints before closing, so the retired file does not keep a
        // journal the size of the last crawl parked beside it.
        closeDatabase(previous);
        return true;
      } catch (err) {
        lastError = err as Error;
        return false;
      }
    };

    const attempt = (): void => {
      if (tryClose()) return;
      if (attempts < RETIRE_CLOSE_ATTEMPTS) {
        const retry = setTimeout(attempt, Math.max(lingerMs, RETIRE_RETRY_MIN_MS));
        retry.unref?.();
        return;
      }
      // Said once, at the hand-over. The ticker itself stays silent: a minute's
      // interval over a multi-day session is thousands of identical lines on
      // the one stream an MCP client shows the user.
      log(
        `[mcpfinder] Could not close the retired catalog handle after ${attempts} attempts: ` +
          `${lastError?.message}. Retrying every ${Math.round(retireSlowRetryMs / 1000)}s.\n`,
      );
      const slow = setInterval(() => {
        if (!tryClose()) return;
        clearInterval(slow);
        // Worth a line only because the warning above was: it closes out a
        // problem the user was already told about.
        log(`[mcpfinder] Retired catalog handle closed after ${attempts} attempts.\n`);
      }, retireSlowRetryMs);
      slow.unref?.();
    };

    const timer = setTimeout(attempt, lingerMs);
    timer.unref?.();
  }

  /**
   * Take up a freshly installed snapshot file. Throwing here aborts the switch
   * and leaves the existing handle in place — deliberately: a server on stale
   * data still answers, a server on a closed handle does not.
   */
  async function activate(nextPath: string): Promise<void> {
    downloading = false;
    // Not a gate: no tool call waits on this. It only tells the live sync to
    // sit this round out, so nothing starts writing between quiesce and switch.
    switching = true;
    try {
      if (deps.quiesce) await deps.quiesce();
      const next = deps.openDb(nextPath);
      const previous = deps.getDb();
      deps.setDb(next);
      try {
        markSnapshotInstalled(next, getServerCount(next));
      } catch (err) {
        // Cosmetic bookkeeping for isSyncNeeded; a failure here must not undo
        // an otherwise good install.
        log(`[mcpfinder] Could not stamp snapshot install: ${(err as Error).message}\n`);
      }
      if (previous !== next) retire(previous);
    } finally {
      switching = false;
    }
  }

  async function runBootstrap(mode: 'bootstrap' | 'refresh'): Promise<void> {
    downloading = true;
    bytes = 0;
    total = 0;

    const result = await bootstrapFromSnapshot({
      baseUrl,
      dbPath,
      // A cold start has already created an empty DB file, so the
      // "db-already-exists" guard would otherwise veto the download.
      force: mode === 'bootstrap',
      refresh: mode === 'refresh',
      retainHours: deps.retainHours,
      onProgress: (received, expected) => {
        bytes = received;
        total = expected;
      },
      activate,
    });

    downloading = false;

    if (result.ok) {
      log(
        `[mcpfinder] ${mode === 'refresh' ? 'Refreshed' : 'Bootstrapped'} from snapshot: ` +
          `${result.servers} servers, ${mb(result.bytesDownloaded ?? 0)} in ${result.durationMs}ms ` +
          `(published ${result.publishedAt})\n`,
      );
      // An install that succeeded with a caveat — a peer's newer pointer left
      // in place, say — still has something to say.
      if (result.reason) log(`[mcpfinder] Snapshot ${mode} note: ${result.reason}\n`);
    } else if (result.reason !== 'db-already-exists' && result.reason !== 'snapshot-up-to-date') {
      log(`[mcpfinder] Snapshot ${mode} skipped: ${result.reason}\n`);
    }
  }

  /**
   * First check after start-up. A missing pointer means no snapshot has ever
   * been installed here, so we bootstrap regardless of the refresh setting —
   * `MCPFINDER_SNAPSHOT_REFRESH_HOURS=0` turns off *periodic re-checks*, not the
   * initial download that saves an upgrading install from an 11-minute crawl.
   */
  async function initialCheck(): Promise<void> {
    // Nothing to serve at all — the one case that must download right now.
    if (!hadDbAtStartup) {
      await runBootstrap('bootstrap');
      return;
    }
    const state = await readSnapshotState(dbPath);
    if (!state) {
      await runBootstrap('refresh');
      return;
    }
    if (refreshHours <= 0) return;
    await maybeRefresh();
  }

  async function maybeRefresh(): Promise<void> {
    const state = await readSnapshotState(dbPath);
    const lastChecked = Date.parse(state?.checkedAt ?? state?.installedAt ?? '');
    if (Number.isFinite(lastChecked) && Date.now() - lastChecked < refreshHours * 3_600_000) return;
    await runBootstrap('refresh');
  }

  function kick(task: () => Promise<void>): void {
    if (inFlight) return;
    // Set before the task runs, not inside it: both entry points await a
    // pointer read first, and a live sync starting in that window would be
    // writing through a handle the switch is about to retire.
    downloading = true;
    inFlight = task()
      .catch((err: unknown) => {
        log(`[mcpfinder] Snapshot bootstrap error: ${(err as Error).message}\n`);
      })
      .finally(() => {
        downloading = false;
        inFlight = null;
      });
  }

  return {
    currentDbPath,

    start(): void {
      if (disabled) return;
      // Reclaim superseded files and abandoned downloads. Age-gated, so a peer's
      // in-flight download and a peer's current database are both left alone.
      void sweepSnapshotFiles(dbPath, { retainHours: deps.retainHours }).catch(() => []);
      kick(initialCheck);
      if (refreshHours > 0) {
        const intervalHours = Math.max(
          refreshHours / CHECKS_PER_REFRESH_PERIOD,
          MIN_CHECK_INTERVAL_HOURS,
        );
        const timer = setInterval(() => kick(maybeRefresh), intervalHours * 3_600_000);
        timer.unref?.();
      }
    },

    async waitUntilUsable(): Promise<string | null> {
      // `switching` counts too: on a cold start the DB in hand is still the
      // empty one until the new handle is published, and answering "nothing
      // found" in that window is a definitive-looking negative for a server
      // that does exist.
      if (!downloading && !switching) return null;
      if (getServerCount(deps.getDb()) > 0) return null;
      if (!downloading) {
        return (
          'MCPfinder is installing the catalog snapshot it just downloaded. ' +
          'No results are available yet — retry this call in a few seconds.'
        );
      }
      const progress =
        total > 0
          ? ` (${mb(bytes)} of ${mb(total)}, ${Math.floor((bytes / total) * 100)}%)`
          : ` (${mb(bytes)} so far)`;
      return (
        `MCPfinder is still downloading its catalog snapshot${progress}. ` +
        'No results are available yet — retry this call in a few seconds.'
      );
    },

    isBusy(): boolean {
      return downloading || switching;
    },

    settled(): Promise<void> {
      return inFlight ?? Promise.resolve();
    },
  };
}
