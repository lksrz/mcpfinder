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

await Promise.all([
  syncOfficialRegistry(db),
  syncGlamaRegistry(db),
  syncSmitheryRegistry(db),
]);

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
requires every requested registry to have an `ok` row in `sync_log` and rejects
total or per-source count drops above 5% relative to the published manifest.
Glama and Smithery live syncs still return partial counts on upstream errors or
budget exhaustion for resilient local stdio use, but record `status=error`, so
that partial state cannot be published. Controlled corpus resets can override
only the count-regression check with `--allow-quality-regression` or
`MCPFINDER_SNAPSHOT_QUALITY_OVERRIDE=1`.

`MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES` can raise Glama's default 12-minute
wall-clock budget for batch builds. It accepts integer values from 1 through
120; invalid or unbounded values fail explicitly. The snapshot workflow uses 90
minutes within its 150-minute job timeout. Malformed HTTP 200 JSON pages are
retried at the same cursor before the sync records an error. The hard registry
budget includes consuming and parsing the terminal response body; a page that
finishes after its deadline is intentionally degraded rather than accepted as
healthy, keeping the enclosing job bounded.
Empty Glama pages may legally continue with a new non-empty cursor; missing or
previously seen continuation cursors are structural errors, preventing an
upstream pagination loop from running until the deadline.

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
| `syncOfficialRegistry / syncGlamaRegistry / syncSmitheryRegistry` | Live sync from upstream registries. |
| `bootstrapFromSnapshot` | Fast cold-start via prebuilt SQLite snapshot. |
| `searchServers` | Ranked full-text search + filters. |
| `getServerDetails` | Full metadata for one server (env vars, tools, trust signals). |
| `listCategories / getServersByCategory` | Category browsing. |
| `getInstallCommand` | Generate client-specific JSON install config. |
| `enrichSmitheryRepoUrls / enrichDeprecationFlags` | Build-time enrichment passes (GitHub probe, npm/GitHub deprecation flags). |

Full TypeScript types are exported — see the `.d.ts` files in `dist/`.

## Links

- **Source + issues:** https://github.com/mcpfinder/mcpfinder
- **Higher-level server:** [`@mcpfinder/server`](https://www.npmjs.com/package/@mcpfinder/server)
- **Website:** https://mcpfinder.dev

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.en.html)
