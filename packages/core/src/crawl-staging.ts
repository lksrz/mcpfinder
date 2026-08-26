/**
 * Disk-backed staging buffer for a registry crawl.
 *
 * A crawl is staged in full and only applied once its terminal page validated,
 * so a truncated or degraded upstream can never half-overwrite the local
 * last-known-good data. Holding that staging area in a JS array does not
 * scale: Glama alone returns ~78k entries of ~4 KB raw JSON, which is ~0.3 GB
 * of parsed objects on the heap next to the in-memory dedup index — enough to
 * OOM the snapshot job and take a required source down with it.
 *
 * Spilling the staged pages into a TEMP SQLite table keeps the same semantics
 * ("stage everything, then apply atomically, or discard the lot") while
 * holding only one chunk of entries in memory at a time. TEMP tables live on
 * the connection, never in the database file, and are dropped on close().
 */
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './db.js';

/** How many staged entries are materialized per read step. */
const READ_CHUNK_SIZE = 500;

export class CrawlStaging<T> {
  readonly #table: string;
  readonly #insertPage: (entries: T[]) => void;
  readonly #db: DatabaseSync;
  #size = 0;

  /** `label` names the source and must be a bare identifier (e.g. `glama`). */
  constructor(db: DatabaseSync, label: string) {
    if (!/^[a-z]+$/.test(label)) throw new Error(`Invalid crawl staging label: ${label}`);
    this.#db = db;
    this.#table = `mcpfinder_stage_${label}`;
    // Force the spill to disk: an in-memory temp store would reintroduce
    // exactly the heap pressure this staging area exists to avoid.
    db.exec('PRAGMA temp_store = FILE');
    db.exec(`DROP TABLE IF EXISTS temp.${this.#table}`);
    db.exec(`CREATE TEMP TABLE ${this.#table} (seq INTEGER PRIMARY KEY, payload TEXT NOT NULL)`);
    const insert = db.prepare(`INSERT INTO temp.${this.#table} (payload) VALUES (?)`);
    // One transaction per page rather than per row — 78k implicit commits
    // would cost more than the crawl itself.
    this.#insertPage = transaction(db, (entries: T[]) => {
      for (const entry of entries) insert.run(JSON.stringify(entry));
    });
  }

  /** Number of entries staged since the last reset. */
  get size(): number {
    return this.#size;
  }

  /** Stage one page of entries. */
  push(entries: T[]): void {
    if (entries.length === 0) return;
    this.#insertPage(entries);
    this.#size += entries.length;
  }

  /** Drop everything staged so far (a restarted crawl attempt starts clean). */
  reset(): void {
    this.#db.exec(`DELETE FROM temp.${this.#table}`);
    this.#size = 0;
  }

  /**
   * Iterate the staged entries in crawl order, materializing at most
   * `READ_CHUNK_SIZE` of them at a time. Safe to consume inside the apply
   * transaction: it only ever reads the TEMP table, which the apply loop
   * never writes.
   */
  *read(): Generator<T> {
    const select = this.#db.prepare(
      `SELECT seq, payload FROM temp.${this.#table} WHERE seq > ? ORDER BY seq LIMIT ?`,
    );
    let after = 0;
    while (true) {
      const rows = select.all(after, READ_CHUNK_SIZE) as Array<{ seq: number; payload: string }>;
      if (rows.length === 0) return;
      for (const row of rows) yield JSON.parse(row.payload) as T;
      after = rows[rows.length - 1].seq;
    }
  }

  /** Release the staging table. */
  close(): void {
    try {
      this.#db.exec(`DROP TABLE IF EXISTS temp.${this.#table}`);
    } catch {
      // A closed database (or a rolled-back connection) has nothing to drop.
    }
    this.#size = 0;
  }
}
