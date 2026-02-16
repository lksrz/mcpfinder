# MCPfinder — Search Engine for MCP Servers 🔍

**Find the right MCP server for any task.** MCPfinder aggregates the Official MCP Registry into a fast, searchable index with full-text search. Works as an MCP server itself — so your AI assistant can discover and install other MCP servers.

> Think of it as "Google for MCP" — search by keyword, use case, or technology.

## Features

- 🔍 **Full-text search** across 2000+ MCP servers (FTS5-powered)
- 📦 **Install commands** ready to paste into Claude Desktop, Cursor, or VS Code
- 🏷️ **Category browsing** — explore servers by domain (database, filesystem, AI, etc.)
- 🔄 **Auto-sync** with the Official MCP Registry (incremental updates)
- ⚡ **Zero config** — just add to your MCP client and start searching

## Quick Start

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

### Cursor / VS Code

Add to your MCP config:

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

## Tools

MCPfinder exposes 5 MCP tools:

| Tool | Description |
|------|-------------|
| `search_mcp_servers` | Search by keyword, use case, or technology. Supports filters for transport type and package registry. |
| `get_server_details` | Get full details for a specific server — description, version, repository, environment variables. |
| `get_install_command` | Get copy-paste install config for Claude Desktop, Cursor, VS Code, or generic MCP clients. |
| `list_categories` | Browse all server categories with counts. |
| `browse_category` | List servers within a specific category. |

## Examples

**"Find me a database server for PostgreSQL"**
→ `search_mcp_servers` with query "postgres database"

**"How do I install the filesystem server in Cursor?"**
→ `get_install_command` with name "filesystem", client "cursor"

**"What categories of MCP servers exist?"**
→ `list_categories`

## Architecture

```
mcpfinder/
├── packages/
│   ├── core/          # Database, sync engine, search logic (SQLite + FTS5)
│   └── mcp-server/    # MCP server exposing search tools via stdio
├── pnpm-workspace.yaml
└── package.json
```

- **@mcpfinder/core** — SQLite database with FTS5 full-text search, registry sync engine, search/browse/install logic
- **@mcpfinder/server** — MCP server (stdio transport) that exposes core functionality as tools

## Development

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm --filter @mcpfinder/core build
pnpm --filter @mcpfinder/server build

# Run the server locally
node packages/mcp-server/dist/index.js
```

## Data Source

MCPfinder syncs from the [Official MCP Registry](https://registry.modelcontextprotocol.io) — the canonical source for MCP servers. Data is cached locally in SQLite and refreshed automatically when stale.

## Roadmap

- [ ] Multi-registry support (Glama, Smithery)
- [ ] Server ranking algorithm (popularity + recency + quality)
- [ ] Web UI at findmcp.dev
- [ ] npm publish `@mcpfinder/server` v1.0.0

## License

MIT — Built by [Coder AI](https://coderai.dev)
