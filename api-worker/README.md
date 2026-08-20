# api-worker

Cloudflare Worker serving `mcpfinder.dev` support endpoints.

This Worker is no longer an MCP transport. The canonical MCPfinder interface is
the local stdio server installed via `npx -y @mcpfinder/server`.

## Endpoints

- `GET /api/v1/snapshot/manifest.json` — metadata for the latest published SQLite snapshot
- `GET /api/v1/snapshot/data.sqlite.gz?sha=<sha256>` — exact immutable SQLite snapshot selected by the manifest
- `GET /api/v1/snapshot/data.sqlite.gz` — durable current fallback, also compatible with older manifests
- `GET /.well-known/mcp-registry-auth` — served elsewhere for MCP Registry publisher proof

## Running locally

```bash
npm install
npx wrangler dev -c wrangler.toml
```

## Deploying

```bash
npx wrangler deploy -c wrangler.toml
```

Always pass `-c wrangler.toml` explicitly.

The same explicit config is used by `npm run cf-typegen`. `wrangler.toml` is
the sole Worker configuration and declares `[triggers] crons = []`: this
request-only Worker must not own a scheduled trigger. Snapshot scheduling lives
only in GitHub Actions, where the last-known-good quality gate runs before R2
upload.

Snapshot databases are stored under immutable
`snapshots/<sha256>.sqlite.gz` keys. The mutable `manifest.json` pointer is
uploaded only after immutable preflight, so a failed publication cannot break
the previous manifest/DB pair. The legacy `data.sqlite.gz` durable-current copy
is refreshed after the manifest publish, followed by
`data.sqlite.gz.sha256` as the final commit marker. Historical immutable
objects remain available throughout the 30-day retention window for cached
manifests.

CI preflights a newly uploaded object through this Worker and verifies the
response SHA-256 before publishing the new manifest pointer. Transient network,
404, 429, and 5xx failures get at most three bounded retries; integrity or
address mismatches fail immediately, and each attempt times out across the full
response body. Content-addressed
objects are retained for 30 days, far beyond the five-minute manifest cache;
the lifecycle rule is prefix-scoped and does not cover `manifest.json` or the
legacy `data.sqlite.gz`.

When an immutable object has expired, the Worker consults the bounded current
manifest and bounded commit marker. It uses `data.sqlite.gz` only when the
requested SHA, manifest SHA, and marker SHA are identical. It never substitutes
the current DB for a different historical SHA; missing/malformed/mismatched
proof fails safe with 404 without reading the durable DB. Thus a failed final
upload cannot expose stale bytes under a newly published SHA. The verified
current manifest/marker proof (including a negative or malformed result) is
coalesced and cached inside each Worker isolate for five minutes. Snapshot-SHA
404 responses carry the same five-minute public cache lifetime, so unrelated
unknown SHA requests do not repeatedly read both proof objects from R2.
R2 read failures are not negative-cached: the Worker returns a controlled 503
without public cache headers, clears the in-flight load, and retries storage on
the next request.

Apply the reviewed lifecycle configuration explicitly (this is not part of a
Worker deploy):

```bash
pnpm --filter cloudflare-workers-openapi r2:lifecycle:apply
```

`r2-lifecycle.json` also preserves the 7-day abort rule for incomplete
multipart uploads.

## Bindings

- `MCP_DB_SNAPSHOTS` — R2 bucket containing `manifest.json`, immutable `snapshots/*` objects, durable `data.sqlite.gz`, and its `.sha256` commit marker
