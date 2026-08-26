# @mcpfinder/core

> Shared library for MCPfinder: multi-registry sync, SQLite+FTS5 search, trust-signal enrichment, and install-config generation.

[![npm](https://img.shields.io/npm/v/@mcpfinder/core.svg)](https://www.npmjs.com/package/@mcpfinder/core)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.en.html)

This is the internal library that powers [`@mcpfinder/server`](https://www.npmjs.com/package/@mcpfinder/server)
— the MCP server that discovers and installs other MCP servers from the
Official MCP Registry, Glama, and Smithery.

Most users should install `@mcpfinder/server`, not this package directly.
Use `@mcpfinder/core` only when you want to embed the search/enrichment engine
into a custom tool (e.g. a web UI, a bot, or a batch job).

## Install

```bash
npm install @mcpfinder/core
# or
pnpm add @mcpfinder/core
```

Node.js 22.13+ required (built-in `node:sqlite`, no native build step).

## Quick start

```ts
import {
  initDatabase,
  syncOfficialRegistry,
  syncGlamaRegistry,
  syncSmitheryRegistry,
  searchServers,
  getServerDetails,
} from '@mcpfinder/core';

const db = initDatabase(); // stores in ~/.mcpfinder/data.db by default

// Keep this order: each later registry's dedup index sees earlier inserts.
// A failed source is reported without preventing the remaining attempts.
for (const [source, sync] of [
  ['Official', syncOfficialRegistry],
  ['Glama', syncGlamaRegistry],
  ['Smithery', syncSmitheryRegistry],
] as const) {
  try {
    await sync(db);
  } catch (error) {
    console.error(`${source} sync failed`, error);
  }
}

const results = searchServers(db, 'postgres', 5);
for (const r of results) {
  console.log(r.name, r.confidenceScore, r.warningFlags);
}

const detail = getServerDetails(db, results[0].name);
```

## Snapshot bootstrap (fast cold start)

Skip the ~10 minute live sync by downloading a prebuilt snapshot:

```ts
import { bootstrapFromSnapshot } from '@mcpfinder/core';

await bootstrapFromSnapshot(); // downloads from https://mcpfinder.dev/api/v1/snapshot
```

`bootstrapFromSnapshot` never rejects — transport, filesystem, and verification
failures all come back as `{ ok: false, reason }`, so a caller running before an
MCP handshake cannot be killed by an unhandled rejection. The manifest request
uses a short absolute timeout; the DB download uses an *inactivity* budget
instead, aborting only after a stretch with no bytes received, so a slow but
healthy link is not cut off. `onProgress(bytes, total)` reports transfer
progress (`total` is the manifest's `sizeBytes`); a throw from it is swallowed,
never escaping the stream handler.

The manifest's `sha256` is **mandatory** and must be a 64-character hex digest.
A manifest without one is rejected outright (`manifest-fetch-failed`) and the DB
is never fetched — unverifiable bytes are worse than no update.

### Versioned files, one pointer

Nothing is ever overwritten in place. A user normally runs several MCP clients
at once and each starts its *own* mcpfinder process against the same data dir,
so replacing `data.db` under them would unlink a peer's `-wal` without a
checkpoint (losing its committed rows) and would simply fail on Windows. Instead:

- the verified download becomes a new immutable file named after its digest,
  `data-<sha256[0:16]>.db`, written to a temp file first and promoted only after
  the checksum matches;
- a small pointer file, `<db>.snapshot.json`, records which file is current
  along with its provenance (`dbFile`, `sha256`, `publishedAt`, `etag`,
  `installedAt`, `checkedAt`). It is updated by writing beside it and renaming —
  atomic, and safe because nobody holds a pointer file open.

`resolveCurrentDbPath(nominalDbPath)` turns the nominal `<data-dir>/data.db`
into the file to open. Existing installs have no pointer or a pointer without
`dbFile`: their `data.db` is treated as the current database and is never
renamed, deleted or rewritten — it simply stays current until the first
successful download produces a versioned file for the pointer to move to.

`activate(dbPath)` is awaited after the new file is in place, with its path —
the hook where a caller opens the new database and retires its old handle. It
runs *before* the pointer is written, so a throw leaves the pointer on the
previous snapshot and the caller's existing handle untouched
(`activate-failed`).

Promotion to the sha-named file uses `link` + `unlink`, not `rename`: `link`
fails with `EEXIST` atomically instead of replacing, so two installers of the
same digest cannot strand each other on a ghost inode — the loser discards its
download and adopts the file already there. On filesystems without hard links
(FAT/exFAT, some network mounts) this falls back to `rename`, which is atomic
but *not* exclusive; there the check-then-rename window remains.

The pointer only ever moves **forward**. `publishSnapshotState` re-reads the
pointer and refuses to install over a strictly newer `publishedAt`
(`{ status: 'superseded' }`), so a process that started downloading an older
snapshot before a peer installed a newer one cannot roll the data dir back and
send everyone off to re-download 45MB. That holds for a pointer **without**
`dbFile` too — the pre-versioning shape. It stands for the legacy `data.db`, or
for the versioned file of its own digest once one exists, and is ordered against
whichever of those is actually on disk; skipping the comparison for it, as an
earlier version did, let a *staler* snapshot overwrite a perfectly good pointer. Equal timestamps with different digests
are broken by digest, so every peer picks the same winner. The comparison is
read-compare-write and therefore narrows the race rather than closing it — the
events it orders are minutes to hours apart while the window is milliseconds,
and the loser keeps serving valid data until its next refresh. A pointer write
that *fails* is reported (`pointer-write-failed`), never swallowed: activation
has already happened, so the caller must know the data dir still selects the old
file.

**What is and is not guaranteed.** A reader never observes a half-written or
vanished database: it opens a file that is complete before it is named. A file
another process is serving may well be *deleted* under it, and that is fine —
on POSIX an open file keeps working against its inode. What would not be fine
is losing its `-wal`/`-shm`, which SQLite reaches for by name, so those are
never removed while the database is there — and, once it is gone, only after
weeks (see [Retention](#retention)). The accepted trade-off is on the
write side — when process A switches to a newer snapshot, process B keeps
writing live sync results into the older file, and those writes are dropped when
B switches too. The published snapshot is the source of truth for the catalog,
so a dropped incremental crawl only costs a later re-sync.

### Retention

Superseded files are ~230MB unpacked, so `sweepSnapshotFiles(nominalDbPath)`
reclaims them. Two rules for what may go, and one absolute prohibition:

1. the pointer must not select it — the current database is never a candidate,
   at any age;
2. it must have been untouched for the full grace period
   (`MCPFINDER_SNAPSHOT_RETAIN_HOURS`, default 48). Sidecar mtimes count
   towards that, so a peer that is actively writing keeps its file young;
3. **a `-wal`/`-shm` is never unlinked.** Not alongside its database, not once
   the database is gone, not at any age. A peer that still has the database
   open is unaffected by losing the *name* — it holds the inode — but it looks
   its `-wal`/`-shm` up by name every time, so pulling those out from under it
   is precisely the corruption this layout exists to prevent.

Rule 3 used to be justified by the claim that sidecars are "kilobytes against
the ~230MB the database costs". That claim was wrong, and is retracted. A
registry crawl is applied as a **single transaction** — deliberately, so a
partial crawl can never land — which means the WAL grows to the size of the
entire write and stays that big until something checkpoints or closes the
database. Measured on a real install, before anything trimmed it:

```
~/.mcpfinder/data.db      323 MB
~/.mcpfinder/data.db-wal   40 MB
~/.mcpfinder/data.db-shm    1 MB
```

**Orphaned journals are not collected.** A `-wal`/`-shm` whose database file is
already gone looks exactly like the journal of a peer that is still running
against a file swept from under it, and unlinking the second one is corruption.
There is no age at which that ambiguity resolves — a peer that last wrote three
weeks ago may still be alive — so the sweep simply never touches a sidecar, and
the leak is documented rather than papered over.

What makes that acceptable is that the residue is now far smaller than the
numbers above. Every **successful** registry sync ends with
`PRAGMA wal_checkpoint(TRUNCATE)` (`checkpointWal`), which folds the journal back
into the database and truncates it to zero; the 40MB was measured precisely
because nothing ever trimmed it. This does not change the crawl's atomicity —
the truncation happens after the commit. A caller that knows it is finished with
a handle closes it explicitly through `closeDatabase` (checkpoint, then close),
which removes the journal outright; `catalog.ts` does that when it retires a
superseded handle. The library installs no `exit`/`SIGINT`/`SIGTERM` hooks of its
own — a library has no business changing a host application's signal
disposition — so what survives a process killed with `SIGKILL`, which is how MCP
clients usually stop stdio servers, is whatever accumulated since the last
checkpoint. That is the remaining, bounded leak.

Abandoned partial downloads are reclaimed on a shorter clock
(`MCPFINDER_SNAPSHOT_DOWNLOAD_STALE_HOURS`, default 6), which is what keeps a
peer's in-flight download safe. A superseded legacy `data.db` is eligible under
the same rules.

Two consequences worth knowing:

- **On Windows an open file cannot be unlinked**, so superseded snapshots
  accumulate there for as long as some process holds them, and are reclaimed on
  a later sweep once nothing does. Failure to remove a file is an ordinary
  outcome, never an error.
- **Sidecars can outlive their database.** A `data-<sha16>.db-wal` with no
  `data-<sha16>.db` beside it is the expected footprint of a swept file whose
  holder is still running. It is left alone for the whole orphan window above
  and only then reclaimed.

That second one has a sharp edge, because names come from digests and therefore
recur: a snapshot swept months ago can be published again under the same name.
Installing onto it would mean opening somebody else's journal as our own, and
deleting that journal is not an option either. So `promoteDownload` checks for
stranded sidecars at the target name and, when it finds them, installs to a
**variant name** — `data-<sha16>-<rand6>.db` — returning the name it actually
used so the pointer records the right one. Variant files are ordinary snapshot
files: the sweep reclaims them under the same rules. The pre-existing behaviour
is unchanged where the *database* is already there — the loser of a race adopts
the winner's file rather than overwriting it.

**The nominal `data.db` needs the same guard**, and gets it. Once a superseded
legacy `data.db` has been swept, its journal stays behind for its owner, and
anything that reopens *that* name — a client running an older release, or the
current code falling back to it after the pointer is deleted — would create a
fresh database beside a journal belonging to somebody else. (Verified locally:
SQLite maps the stale `-shm` by name and unlinks the abandoned `-wal` on close.)
So `resolveCurrentDbPath` refuses the nominal name when there is no database at
it but a journal is sitting there, and resolves to a variant — `data-<rand6>.db`,
the same mechanism `promoteDownload` uses — instead. The choice is made once per
process and remembered, so whoever opens the database and the sweep that decides
what is current cannot disagree. It costs one small, sweepable empty database
per process in that state, until a successful download writes a pointer that
names a file again.

The sidecar probe in `promoteDownload` is still check-then-act. The canonical
name is re-checked immediately before committing to a variant, so a peer that
installs it inside the window is normally adopted rather than duplicated; the
remaining gap is the few syscalls before `link`, and losing it costs a second
full copy of identical bytes under a variant name, which the sweep reclaims on
the usual clock. Closing it properly would need a lock file, whose failure mode
(a stuck lock from a killed process) is worse than the one it removes.

### Refresh

Pass `refresh: true` to re-check an install. When the manifest's `sha256`
matches the pointer's, the call returns
`{ ok: false, reason: 'snapshot-up-to-date' }` after a **single** manifest
request — the DB endpoint is not touched. When it differs, a **second**,
conditional (`If-None-Match`) request is made for the DB. If that answers 304 —
the documented window where the durable gz lags manifest publication — the call
returns `snapshot-not-yet-published` and deliberately does *not* stamp
`checkedAt`, so the next check retries instead of being suppressed for a whole
refresh interval. `force: true` re-downloads unconditionally.

After installing a snapshot, call `markSnapshotInstalled(db, serverCount)`. It
records the install in `sync_log` under the `snapshot` source, which
`isSyncNeeded` treats as a fresh sync — otherwise the CI-built `sync_log` inside
the snapshot looks hours old and a full live sync fires seconds after the
download. That grace period is `MCPFINDER_SNAPSHOT_FRESH_MINUTES` (default 360);
once it lapses, normal staleness detection resumes.

| Env var | Default | Effect |
| --- | --- | --- |
| `MCPFINDER_SNAPSHOT_MANIFEST_TIMEOUT_MS` | `10000` | Timeout for the manifest request. |
| `MCPFINDER_SNAPSHOT_STALL_TIMEOUT_MS` | `60000` | Inactivity budget for the DB download. |
| `MCPFINDER_SNAPSHOT_RETAIN_HOURS` | `48` | Grace period before a superseded snapshot file may be swept. |
| `MCPFINDER_SNAPSHOT_DOWNLOAD_STALE_HOURS` | `6` | Grace period before an abandoned partial download may be swept. |
| `MCPFINDER_SNAPSHOT_FRESH_MINUTES` | `360` | How long an installed snapshot counts as a fresh sync in `isSyncNeeded`. |

Published snapshots use last-known-good semantics. The scheduled builder
requires every *required* registry — Official and Smithery — to have an `ok` row
in `sync_log`, and rejects total or per-source count drops above 5% relative to
the published manifest. Glama is **best-effort**: since it closed its public API
on 2026-08-26 an errored, skipped, or budget-exceeded Glama only warns, and the
snapshot still publishes with `counts.glama = 0`. Because `counts.*` are raw
upstream record counts while `serverCount` is a deduplicated row count, an absent
Glama cannot be subtracted from the baseline; instead the aggregate `serverCount`
regression check is **skipped** for that run with an explicit warning, and the
per-source raw-vs-raw checks on Official and Smithery keep the gate honest. An
Official regression still fails the build.
Official, Glama, and Smithery stage each complete crawl (spilled to a TEMP
SQLite table, so staging memory stays bounded regardless of corpus size) and
atomically apply only a fully validated terminal result. Upstream, structural, budget, or apply
failures discard/roll back staging, leave the existing last-known-good database
unchanged, and record `status=error` with a zero committed count. Controlled corpus resets can override
only the count-regression check with `--allow-quality-regression` or
`MCPFINDER_SNAPSHOT_QUALITY_OVERRIDE=1`.

`GLAMA_API_KEY` (from <https://glama.ai/settings/api-keys>) enables the Glama
sync; it is sent as `Authorization: Bearer <key>` and never logged, persisted in
`raw_data`, or written to the manifest. Without it `syncGlamaRegistry` skips
before issuing a request and records `status=skipped`; a 401/403 is treated as a
credential error and is never retried. Glama's API Data License requires visible
Glama attribution on every page displaying this data
(<https://glama.ai/policies/terms-of-service>).

`MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES` can raise Glama's default 12-minute
wall-clock budget for batch builds. It accepts integer values from 1 through
40; invalid or unbounded values fail explicitly. The snapshot workflow uses 30
minutes within its 90-minute job timeout. Malformed HTTP 200 JSON pages are
retried at the same cursor before the sync records an error. The hard registry
budget includes consuming and parsing the terminal response body; a page that
finishes after its deadline is intentionally degraded rather than accepted as
healthy, keeping the enclosing job bounded.
Empty Glama pages may legally continue with a new non-empty cursor; missing or
previously seen continuation cursors are structural errors, preventing an
upstream pagination loop from running until the deadline. A cross-page server
ID duplicate restarts the complete cursor crawl once within the same deadline;
intra-page or persistent duplicates fail closed. Like Smithery, Glama applies
only the completed retry in one SQLite transaction.
Official requires the upstream `metadata` object and per-page `count`, validates
that count against returned records, and follows `nextCursor` until it is empty,
null, or omitted by the terminal response. Repeated cursors or any failure
overwrite prior health with `status=error`; the entire cursor result is committed
in one transaction. Smithery always supplies a fixed
integer `seed` to select deep pagination (the unseeded reranker stops at 500).
Its `totalCount`/`totalPages` telemetry may drift while the catalogue changes,
so completion follows actual pages rather than one sampled aggregate. Every
non-empty final page, including a short candidate, is confirmed by an empty
next-page probe; a non-empty page after a short candidate is a truncation/gap
error. A cross-page `qualifiedName` duplicate restarts the entire seeded crawl
once within the same five-minute deadline, while persistent cross-page or any
intra-page duplicate fails closed. `currentPage` identity, non-negative typed
pagination metadata, and the requested maximum result size remain structural;
echoed `pageSize`, `totalCount`, and `totalPages` are advisory and may drift,
including on the empty terminal probe. Each attempt is staged in a TEMP SQLite
table rather than on the JS heap — a ~78k-entry Glama crawl would otherwise
hold hundreds of MB of parsed objects next to the dedup index — and only the
fully validated final attempt is applied in one SQLite transaction, so
abandoned retries,
network errors, structural failures, and deadline crossings cannot leak partial
Smithery records or provenance into the database.
Cross-registry matching builds one in-memory index per
Glama/Smithery sync, preserving repo/package/slug dedup semantics without a
full SQLite scan for every upstream record. Merges retain the combined
`sources`, richer canonical fields, deterministic keyword/environment unions,
repository host provenance (including `www.*` and protocol-less known-host
URLs), and source-specific raw payloads in the existing
`raw_data` envelope, including across a later Official re-sync. The envelope
stores one payload under `primary` with an explicit `primarySource`; only other
sources live in `bySource`, avoiding a duplicated primary payload. Readers also
accept and canonicalize legacy duplicated envelopes, preferring the historically
refreshed `bySource[primarySource]` copy when the copies disagree.
Keyword unions are rebuilt in fixed Official → Glama → Smithery order from the
current payload retained for each source, so complete envelopes remove obsolete
source-only terms without dropping terms still provided elsewhere. For invalid
or historically incomplete envelopes, valid incoming payloads are retained and
their current terms are combined fail-safe with legacy keywords until every
listed source has a replaceable payload. Smithery repository enrichment uses
the same metadata merge before deleting a duplicate row, preserving raw
payloads, env vars, keywords, sources, and repository provenance; shared-repo
monorepos merge only on a unique secondary name/slug match.
When Glama or Smithery refreshes a single-source stable ID, source-owned fields
(including repository URL/provenance, environment variables, counts, and sync
timestamp) exactly follow the current payload, including explicit removal. For
a multi-source row, canonical description, repository/provenance, remote, and
package fields are deterministically rebuilt from current payloads: the primary
source is preferred for non-empty structured fields, then Official → Glama →
Smithery, while the longest current description wins. Official-package and
Glama-schema environment contributions are replaced per source and re-unioned
through the same schema mapping the insert path uses, so a merged row keeps
`default`, `format`, `writeOnly`-derived `isSecret`, and schema `required`
instead of collapsing to name/description; unattributable legacy/enrichment
entries are retained fail-safe. Smithery
remains authoritative for its usage count, verification, and icon, so those
may decrease without clearing other-source metadata. Invalid or missing source
payloads retain existing aggregates rather than risking data loss.

`sync_log.last_synced_at` records every attempt and throttles local background
refreshes after both success and failure. `last_successful_at` advances only on
healthy syncs. Official uses it for `updated_since` only when the latest attempt
is also healthy, so a failure is throttled locally while its next allowed
attempt remains a full sync.

The previous manifest is optional only when its endpoint returns 404. Network,
5xx, JSON, or missing/zero count failures are retried and then fail closed.
Successful publication first uploads `snapshots/<sha256>.sqlite.gz`, then
verifies that object through the public Worker endpoint, and only then
atomically advances `manifest.json` to `data.sqlite.gz?sha=<sha256>`. Immutable
snapshot objects have a 30-day prefix-scoped R2 lifecycle. After manifest
publication, CI refreshes the non-expiring legacy key with the same current DB;
it then publishes a `.sha256` commit marker. The Worker may use the durable key
only when requested, manifest, and marker SHA all match, preventing a failed
fallback upload from presenting stale bytes as current.

## Exports

| Export | Purpose |
| --- | --- |
| `initDatabase(path?)` | Open (or create) the local SQLite DB with FTS5 schema. |
| `getLastSyncTimestamp / getLastSuccessfulSyncTimestamp` | Read the latest attempt or latest incrementally safe successful sync timestamp. |
| `syncOfficialRegistry / syncGlamaRegistry / syncSmitheryRegistry` | Live sync from upstream registries. |
| `bootstrapFromSnapshot` | Fast cold-start via prebuilt SQLite snapshot; also refreshes an installed one. |
| `readSnapshotState / writeSnapshotState / snapshotStatePath` | Pointer + provenance of the installed snapshot (`dbFile`, `sha256`, `publishedAt`, `etag`). |
| `resolveCurrentDbPath / versionedDbPath` | Map the nominal `data.db` path to the file actually in use, and to a digest's file name. |
| `publishSnapshotState` | Move the pointer to a new snapshot — forward only, and reports a failed write. |
| `sweepSnapshotFiles` | Reclaim superseded snapshot files and abandoned downloads, age-gated; a `-wal`/`-shm` is never removed, at any age. |
| `closeDatabase / checkpointWal` | Close a handle cleanly (checkpoint, then close) when the caller knows it is done with it, and truncate the WAL a single-transaction crawl left behind. |
| `reconcileSnapshotPointer` | Stamp `checkedAt` on the pointer *in force*, without rolling a peer's newer one back. |
| `variantDbPath` | Alternative home for a digest whose canonical name still has a peer's journal at it. |
| `markSnapshotInstalled / getSnapshotInstalledAt` | Record and read when a snapshot was installed, for `isSyncNeeded`. |
| `searchServers` | Ranked full-text search + filters. |
| `getServerDetails` | Full metadata for one server (env vars, tools, trust signals). |
| `listCategories / getServersByCategory` | Category browsing. |
| `getInstallCommand` | Generate client-specific JSON install config. |
| `buildEnvPlaceholders / envPlaceholderValue` | Fill an `env` block from registry env var definitions: `<YOUR_VALUE>` for secrets, otherwise `default`, then `placeholder`, then `<VALUE>`. |
| `enrichSmitheryRepoUrls / enrichDeprecationFlags` | Build-time enrichment passes (GitHub probe, npm/GitHub deprecation flags). |

Full TypeScript types are exported — see the `.d.ts` files in `dist/`.

## Links

- **Source + issues:** https://github.com/mcpfinder/mcpfinder
- **Higher-level server:** [`@mcpfinder/server`](https://www.npmjs.com/package/@mcpfinder/server)
- **Website:** https://mcpfinder.dev

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.en.html)
