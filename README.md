# MCPfinder

> The MCP server that helps AI agents discover, evaluate, and install other MCP servers.

MCPfinder is an AI-first discovery layer over the Official MCP Registry, Glama, and Smithery. Install it once, and your assistant can search for missing capabilities, inspect trust signals, review required secrets, and generate client-specific MCP config snippets.

## Canonical Use

- Canonical transport: `stdio` via `npx -y @mcpfinder/server`
- Canonical package: [`@mcpfinder/server`](https://www.npmjs.com/package/@mcpfinder/server)
- MCP Registry entry: [`dev.mcpfinder/server`](https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder)
- Public HTTP endpoint: intentionally not advertised as canonical until its tool surface is fully identical to the local server

## Quick Install

### Claude Desktop

```json
{
  "mcpServers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server"]
    }
  }
}
```

### Cursor

```json
{
  "mcpServers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server"]
    }
  }
}
```

### Claude Code

```json
{
  "mcpServers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server"]
    }
  }
}
```

Supported install targets today:

- Claude Desktop
- Cursor
- Claude Code
- Cline / Roo Code
- Windsurf

### Install via Agent Skill (let your AI do it)

If your agent supports the [Agent Skills](https://agentskills.io) format
(Claude Code, GitHub Copilot in VS Code, OpenAI Codex, and others), you can
drop a one-line install and let the agent handle the config merge itself.

**Claude Code (global):**

```bash
mkdir -p ~/.claude/skills/install-mcpfinder && \
  curl -sSf -o ~/.claude/skills/install-mcpfinder/SKILL.md \
    https://mcpfinder.dev/skill/install-mcpfinder/SKILL.md
```

**VS Code (project-scoped):**

```bash
mkdir -p .agents/skills/install-mcpfinder && \
  curl -sSf -o .agents/skills/install-mcpfinder/SKILL.md \
    https://mcpfinder.dev/skill/install-mcpfinder/SKILL.md
```

Then tell your agent any of: *"install MCPfinder"*, *"connect my AI to
Postgres"*, *"I need a tool for [anything]"* — the skill activates, detects
your client, merges the config without clobbering, and tells you what to
restart.

## For AI Assistants

Use MCPfinder when the user needs a capability you do not already have.

- If the user mentions Slack, Postgres, GitHub, Notion, AWS, Google Drive, filesystems, browsers, APIs, or databases: call `search_mcp_servers`.
- Before recommending a server: call `get_server_details`.
- Before telling the user what to paste into config: call `get_install_config`.
- If the user only knows a domain, not a specific technology: call `browse_categories` (omit `category` to list; pass `category` for top servers).

Preferred workflow:

1. `search_mcp_servers(query="postgres")`
2. `get_server_details(name="...best candidate...")`
3. `get_install_config(name="...best candidate...", platform="claude-desktop")`
4. Tell the user what server you chose, why, which secrets are required, and what restart/reload step is needed.

## Tool Surface

| Tool | Purpose | When to call |
| --- | --- | --- |
| `search_mcp_servers` | Search by keyword, technology, or use case | First step when a capability is missing |
| `get_server_details` | Inspect metadata, trust signals, tools, warnings, env vars | Before recommending or installing |
| `get_install_config` | Generate a JSON config snippet for a target client | After selecting a server |
| `browse_categories` | Single-call category browser (omit `category` to list; pass `category` for top servers) | Domain-driven discovery |

## What MCPfinder Returns

MCPfinder is intentionally optimized for agent consumption.

- Human-readable text summaries
- Structured content for chaining follow-up calls
- Trust signals: source count, verification, popularity, recency
- Warning flags: stale projects, missing repository URL, unclear install path, single-source-only
- Install metadata: config snippet, target file paths, required environment variables, restart instructions

## Ranking and Recommendation

Search ranking uses:

- text relevance
- name-match boost
- community usage (`useCount`)
- official registry presence
- verification signals

Each result is also annotated with:

- `confidenceScore`
- `recommendationReason`
- `warningFlags`
- `updatedAt`
- `sourceCount`

## Data Sources

MCPfinder aggregates:

- [Official MCP Registry](https://registry.modelcontextprotocol.io)
- [Glama](https://glama.ai/mcp/servers)
- [Smithery](https://smithery.ai)

Counts vary over time and differ depending on whether you count raw upstream records or merged/deduplicated entries. Snapshot metadata is the source of truth for the currently published local bootstrap dataset.

## Snapshots and Freshness

First run can bootstrap from a prebuilt SQLite snapshot instead of doing a slow live sync.

- snapshot manifest: `/api/v1/snapshot/manifest.json`
- snapshot database: use `manifest.url` (`data.sqlite.gz?sha=<sha256>`) as the content-addressed primary endpoint
- durable current fallback: `/api/v1/snapshot/data.sqlite.gz`, refreshed only after manifest publication
- scheduled build: [`.github/workflows/snapshot.yml`](/Users/lukasz/Git/mcpfinder/.github/workflows/snapshot.yml:1)

Snapshot publishing is last-known-good: all requested registries must finish
with an `ok` sync status, and the merged total plus each per-source count may
not fall more than 5% below the currently published manifest. A failed gate
leaves the published R2 objects untouched. Only a confirmed missing manifest
(HTTP 404, including the first build) skips the count comparison. Transient,
malformed, or structurally incomplete baselines are retried and then fail
closed; source health is always required.

Publication uses a content-addressed handoff. The compressed database is first
uploaded as `snapshots/<sha256>.sqlite.gz`; only then is `manifest.json`
replaced with a pointer URL such as `data.sqlite.gz?sha=<sha256>`. Cached older
manifests therefore continue to resolve to their exact immutable database.
Legacy manifests without `sha` keep using the existing `data.sqlite.gz` key.
Before advancing the manifest, CI downloads the new object through the public
Worker endpoint and verifies both its SHA-256 and the Worker's acknowledged
content address. This prevents publication while an older Worker still ignores
the `sha` query or while the new R2 object is not publicly readable. The
preflight is bounded to four attempts with 0.5/1.5/4.5-second backoff and a
per-attempt timeout covering both response headers and the complete body;
deterministic SHA/header/size mismatches fail immediately.

Immutable objects under `snapshots/` expire after 30 days; neither
`manifest.json` nor legacy `data.sqlite.gz` matches that lifecycle prefix.
Incomplete multipart uploads retain the existing 7-day abort policy.
After the manifest pointer is published, CI refreshes non-expiring
`data.sqlite.gz` with the same database and then publishes
`data.sqlite.gz.sha256` as the final commit marker. If the current immutable
object later expires, the Worker serves this durable copy only when the
requested SHA, current manifest SHA, and marker SHA all match. A failed DB or
marker upload therefore cannot label stale bytes as a new snapshot. Older
cached SHA requests remain 404 after their 30-day history window.
The Worker coalesces concurrent current-proof reads and caches both positive
and malformed/missing proof results for five minutes; SHA-specific 404s are
also publicly cacheable for five minutes.
Actual R2 read failures remain distinct from missing or malformed proof: they
return an uncached 503 and are retried by the next request.

For an intentional corpus reset, manually dispatch the snapshot workflow with
`allow_quality_regression` enabled, or run the builder with
`--allow-quality-regression` (equivalently
`MCPFINDER_SNAPSHOT_QUALITY_OVERRIDE=1`). The override permits count drops but
never permits an errored or incomplete required source.

Glama keeps a 12-minute sync budget for normal local stdio use. The scheduled
snapshot job sets `MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES=30` because a full Glama
pagination regularly exceeds the local limit, while still leaving headroom
inside the job's 90-minute timeout. Custom values must be whole minutes from 1
through 40. HTTP 200 pages with truncated or malformed JSON are retried on the
same cursor before the source is marked as errored. The hard registry deadline
covers the terminal response body as well as transport and parsing: a page that
finishes after the budget is deliberately marked degraded, protecting the
snapshot job from silently exceeding its wall-clock budget.
An empty Glama page with `hasNextPage=true` is followed when it supplies a new,
non-empty cursor. Missing or repeated cursors fail safely as structural errors,
preventing upstream pagination loops.

## Example Workflow

User request:

```text
I need my assistant to read data from PostgreSQL.
```

Agent workflow:

```text
search_mcp_servers(query="postgres")
get_server_details(name="io.example/postgres")
get_install_config(name="io.example/postgres", platform="cursor")
```

Agent response:

```text
I found a PostgreSQL MCP server with official registry presence and recent metadata.
It requires DATABASE_URL and runs via npx.
Add this JSON to ~/.cursor/mcp.json, then reload Cursor.
```

## Repository Layout

```text
mcpfinder/
├── packages/
│   ├── core/          # sync, SQLite search, trust signals, install-config generation
│   └── mcp-server/    # stdio MCP server
├── landing/           # static website and AI-facing public files
├── api-worker/        # snapshot/support worker for published bootstrap artifacts
└── scripts/           # snapshot builder and other support scripts
```

## Development

```bash
pnpm install
pnpm --filter @mcpfinder/core build
pnpm --filter @mcpfinder/server build
node packages/mcp-server/dist/index.js
```

## Current Limitations

- The local `stdio` server is the canonical interface. Install via `npx -y @mcpfinder/server`.
- There is no hosted HTTP MCP endpoint currently served at `mcpfinder.dev/mcp`. The `api-worker` package is reserved for snapshot support and will only be promoted to a canonical HTTP transport once it exposes the same tool contract as the stdio server.
- Tool metadata quality depends on upstream registries; some servers have rich details, others only partial metadata.
- Tool-level capability extraction is currently strongest for sources that expose tool manifests directly, especially Glama.

## Roadmap

These items are planned but not yet implemented. Informed largely by feedback
from AI agents consuming the tool surface.

- **Semantic search over tool descriptions.** Today's search ranks by keyword
  (FTS5) + popularity + source count. It doesn't help when a user describes a
  capability in prose that doesn't overlap lexically with the server's name or
  description. Plan: index `toolsExposed[*].description` (where upstream exposes
  it) into a lightweight embedding column, expose a `semanticQuery` parameter
  alongside the existing keyword `query`, and rank hybrid.
- **Hosted HTTP MCP endpoint at `mcpfinder.dev/mcp`.** Today only stdio is
  canonical. Serverless AI agents (Workers, Lambda, browser) can't spawn a
  subprocess; giving them an HTTP transport with the same 4-tool contract
  removes an entire class of blocker. Plan: port the MCP SDK streamable-http
  transport into `api-worker/`, re-use the same snapshot-backed database via
  R2 + Durable Objects, gate with a lightweight rate limit.
- **Capability-count enrichment for non-Glama rows.** `capabilityCount` is
  currently 0 for most Official/Smithery rows because those upstreams don't
  publish tool manifests in list responses. Plan: during the snapshot build,
  probe the downstream server's README or, for npm packages, parse the tarball's
  `package.json` for an `mcp.tools` hint; surface per-row confidence in the
  extracted list.
- **CI automation for npm + Registry publish.** Today the release playbook
  (`docs/publish-playbook.md`) is manual and consumes a fresh OTP per package.
  Plan: move to GitHub Actions with NPM automation tokens and a committed
  `mcp-publisher` login step triggered on `v*` tags.

## Links

- Website: [mcpfinder.dev](https://mcpfinder.dev)
- GitHub: [mcpfinder/mcpfinder](https://github.com/mcpfinder/mcpfinder)
- npm: [@mcpfinder/server](https://www.npmjs.com/package/@mcpfinder/server)
- MCP Registry: [`dev.mcpfinder/server`](https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder)

Built by [Coder AI](https://coderai.dev) under [AGPL-3.0-or-later](LICENSE).
