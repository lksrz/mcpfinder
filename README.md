# MCPfinder — Search Engine for MCP Servers 🔍

**Find the right MCP server for any task.** MCPfinder aggregates 5000+ servers from three registries — Official MCP Registry, Glama, and Smithery — into a fast, searchable index. Works as an MCP server itself, so your AI assistant can discover and install other MCP servers.

> "Google for MCP" — search by keyword, use case, or technology.

## Features

- 🔍 **Full-text search** across 5000+ MCP servers (FTS5-powered)
- 📦 **Install commands** ready to paste into Claude Desktop, Cursor, or VS Code
- 🏷️ **Category browsing** — explore servers by domain (database, filesystem, AI, etc.)
- 🔄 **Multi-registry sync** — Official MCP Registry + Glama + Smithery
- ⭐ **Popularity ranking** — servers ranked by usage data from Smithery
- 🔗 **Deduplication** — same server from multiple registries merged intelligently
- ⚡ **Zero config** — just add to your MCP client and start searching

## Quick Start

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server@beta"]
    }
  }
}
```

### Cursor / VS Code

Add to your MCP config:

```json
{
  "mcpServers": {
    "mcpfinder": {
      "command": "npx",
      "args": ["-y", "@mcpfinder/server@beta"]
    }
  }
}
```

> **Note:** First run syncs all registries (~2 min). Subsequent calls are instant (SQLite cache).

## Tools

MCPfinder exposes 5 MCP tools:

| Tool | Description |
|------|-------------|
| `search_mcp_servers` | Search by keyword, use case, or technology. Filter by transport type, package registry, or source registry. Results ranked by relevance + popularity. |
| `get_server_details` | Get full details — description, version, repository, environment variables, source registries, popularity. |
| `get_install_command` | Get copy-paste config for Claude Desktop, Cursor, VS Code, or generic MCP clients. |
| `list_categories` | Browse all server categories with counts. |
| `browse_category` | List servers within a specific category. |

### Search Filters

`search_mcp_servers` supports:
- `query` — keyword, use case, or technology (e.g., "postgres", "query databases")
- `limit` — max results (1-50, default 10)
- `transportType` — `stdio`, `streamable-http`, `sse`, or `any`
- `registryType` — `npm`, `pypi`, `oci`, or `any`
- `registrySource` — `official`, `glama`, `smithery`, or `any`

### Ranking

Results are ranked using a multi-factor algorithm:
- **FTS5 relevance** (40%) — how well the query matches
- **Popularity** (30%) — Smithery usage count (log-scaled)
- **Registry presence** (20%) — appears in more registries = more established
- **Recency** (10%) — recently updated servers ranked higher

### Source Badges

Search results show where each server comes from:
- 📦 Official — from the Official MCP Registry
- 🌟 Smithery — with usage count and ✓ for verified servers
- 🔍 Glama — from the Glama registry

## Examples

**"Find me a database server for PostgreSQL"**
→ `search_mcp_servers` with query "postgres database"

**"How do I install the filesystem server in Cursor?"**
→ `get_install_command` with name "filesystem", client "cursor"

**"What categories of MCP servers exist?"**
→ `list_categories`

**"Show me the most popular AI servers"**
→ `browse_category` with category "ai"

## Data Sources

MCPfinder syncs from three registries:

| Registry | Servers | Data |
|----------|---------|------|
| [Official MCP Registry](https://registry.modelcontextprotocol.io) | ~2000 | Packages, transport, env vars |
| [Glama](https://glama.ai/mcp/servers) | ~5000 | Repository, license, tools |
| [Smithery](https://smithery.ai) | ~3500 | Popularity (useCount), verification, icons |

Data is cached locally in SQLite and refreshed automatically when stale (every 15 minutes).

## Architecture

```
mcpfinder/
├── packages/
│   ├── core/          # Database, sync engine, search logic (SQLite + FTS5)
│   └── mcp-server/    # MCP server exposing search tools via stdio
├── pnpm-workspace.yaml
└── package.json
```

- **@mcpfinder/core** — SQLite + FTS5 database, multi-registry sync, deduplication, ranked search
- **@mcpfinder/server** — MCP server (stdio transport) exposing core functionality as tools

## Development

```bash
pnpm install
pnpm --filter @mcpfinder/core build
pnpm --filter @mcpfinder/server build
node packages/mcp-server/dist/index.js
```

## Roadmap

- [x] Official MCP Registry sync
- [x] Multi-registry support (Glama, Smithery)
- [x] Popularity ranking (Smithery useCount)
- [x] Source badges and deduplication
- [x] Published to npm
- [ ] Web UI at findmcp.dev
- [ ] Stable v1.0.0 release (currently beta)

## Links

- **npm:** [@mcpfinder/server](https://www.npmjs.com/package/@mcpfinder/server)
- **Website:** [mcpfinder.dev](https://mcpfinder.dev) / [findmcp.dev](https://findmcp.dev)
- **GitHub:** [lksrz/mcpfinder](https://github.com/lksrz/mcpfinder)

## License

MIT — Built by [Coder AI](https://coderai.dev)
