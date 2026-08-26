# @mcpfinder/server

> The MCP server that finds MCP servers. Your AI's app store for tools.

[![npm](https://img.shields.io/npm/v/@mcpfinder/server.svg)](https://www.npmjs.com/package/@mcpfinder/server)
[![license](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue.svg)](https://www.gnu.org/licenses/agpl-3.0.en.html)
[![MCP Registry](https://img.shields.io/badge/MCP%20Registry-dev.mcpfinder%2Fserver-D4FF00)](https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder)

MCPfinder is a local MCP server that exposes a searchable index of 25,000+ MCP
servers across the **Official MCP Registry**, **Glama**, and **Smithery**.
Install it once as a capability on your AI client and from then on your
assistant can discover, inspect, and install any MCP server on demand — no
manual browsing required.

## Quick install

Add the snippet below to your client's MCP config file. First run downloads a
pre-built gzipped snapshot from `https://mcpfinder.dev/api/v1/snapshot`, so
bootstrap is a single download instead of a 10-minute live sync. Its size
tracks the size of the indexed corpus and grows with it — the current figure is
the `sizeBytes` field of the snapshot manifest at
`https://mcpfinder.dev/api/v1/snapshot/manifest.json`.
When a live refresh is needed, registries run sequentially as Official → Glama
→ Smithery so each later dedup index sees earlier inserts. A failed source is
reported but does not prevent attempts for the remaining sources.
Normal cold start uses the snapshot and does not pay the sum of live registry
budgets. The sequential worst case applies only when snapshot bootstrap is
explicitly disabled or fails while starting from an empty database; the order
is retained for deterministic cross-registry deduplication.

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

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

Restart Claude Desktop.

### Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

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

`.mcp.json` (project) or `~/.claude.json` (global) — same snippet as above.

### Cline / Roo Code (VS Code)

`.vscode/mcp.json`:

```json
{
  "servers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server"]
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json` — same snippet as Cursor.

## Tools exposed

Four canonical tools, optimized for AI consumption (typed `outputSchema` +
`structuredContent` for chaining, warning flags, confidence breakdown):

| Tool | Purpose |
| --- | --- |
| `search_mcp_servers` | Ranked full-text search by keyword, technology, or use case. |
| `get_server_details` | Trust signals, env vars, tool manifest, warnings before install. |
| `get_install_config` | Ready-to-paste JSON config for Claude Desktop, Cursor, Claude Code, Cline, or Windsurf. |
| `browse_categories` | Single-call category browser (omit `category` to list; pass `category` for top servers). |

## What MCPfinder returns to your AI

- Ranked results with `confidenceScore` plus a transparent
  `confidenceBreakdown` (`base`, `official`, `verified`, `popularity`,
  `multiSource`, `penalties`).
- `warningFlags`: `deprecated-npm`, `archived-repo`, `stale-over-18-months`,
  `single-source-only`, `missing-repository-url`, `install-method-unclear`.
- Install metadata: target file path per OS, required env vars (secrets
  marked), `safe_to_autoinstall` and `requires_user_secrets` signals.
- The `env` block of a generated config carries values, never prose: secrets
  get `<YOUR_VALUE>`, other variables get the registry-published `default`,
  then `placeholder`, then `<VALUE>`. Descriptions stay in the "Required
  environment variables" section under the snippet.

## Configuration

| Env var | Default | Effect |
| --- | --- | --- |
| `MCPFINDER_DATA_DIR` | `~/.mcpfinder/` | Where the local SQLite DB lives. |
| `MCPFINDER_DISABLE_SNAPSHOT` | unset | Set to `1` to skip snapshot bootstrap and do a live sync instead. |
| `MCPFINDER_SNAPSHOT_BASE` | `https://mcpfinder.dev/api/v1/snapshot` | Override the snapshot host for mirrors / testing. |
| `GLAMA_API_KEY` | unset | API key for Glama's registry ([create one](https://glama.ai/settings/api-keys)). Without it a live refresh skips Glama entirely — the sync is Official → Smithery, logged as `skipped`. Published snapshots normally carry Glama data, but a snapshot built while Glama was unavailable ships with `counts.glama = 0` (check `counts` in the manifest). |

Glama's API Data License requires visible Glama attribution on every page
displaying data obtained through its API
(<https://glama.ai/policies/terms-of-service>) — any surface rendering servers
whose `sources` include `glama` must carry it.

## Links

- **Source + issues:** https://github.com/mcpfinder/mcpfinder
- **MCP Registry:** [`dev.mcpfinder/server`](https://registry.modelcontextprotocol.io/v0/servers?search=dev.mcpfinder)
- **Website:** https://mcpfinder.dev
- **AI-facing summary:** https://mcpfinder.dev/llms.txt

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.en.html) — free for
personal, internal, and commercial use; modifications exposed as a network
service must be published under the same license.
