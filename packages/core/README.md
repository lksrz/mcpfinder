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
| `bootstrapFromSnapshot` | Fast cold-start via prebuilt SQLite snapshot. |
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
