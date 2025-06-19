# MCPfinder API Worker Documentation

## Overview
This is the Cloudflare Workers API for MCPfinder, providing REST API endpoints and MCP (Model Context Protocol) support.

## MCP Endpoint

The API worker provides an MCP-compatible endpoint at `/mcp` that can be used with Claude and other MCP clients.

### Endpoint URL
- Production: `https://mcpfinder.dev/mcp`
- Local: `http://localhost:8787/mcp` or `http://localhost:8787/api/v1/mcp`

### Adding to Claude CLI

```bash
# Add the MCPfinder MCP server
claude mcp add --transport http mcpfinder https://mcpfinder.dev/mcp

# For local development
claude mcp add --transport http mcpfinder-local http://localhost:8787/mcp
```

### Available Tools

1. **search_mcp_servers** - Search for MCP servers in the registry
   - `query`: Search query (optional)
   - `tag`: Filter by tag (optional)
   - `capability`: Filter by capability type (tool/resource/prompt) (optional)
   - `limit`: Maximum results (default: 10)

2. **get_mcp_server_details** - Get detailed information about a specific server
   - `name`: Exact name of the MCP server (required)

3. **list_trending_servers** - List trending/popular MCP servers
   - `limit`: Number of servers to return (default: 10)

4. **test_echo** - Test connectivity
   - `message`: Message to echo back

## API Endpoints

### Search Tools
`GET /api/v1/search?q=<query>&tag=<tag>&limit=<limit>`

### Get Tool by ID
`GET /api/v1/tools/:id`

### Register Tool
`POST /api/v1/register`

### SSE Events Stream
`GET /api/v1/events`

## Deployment

### Important: KV Bindings

When deploying, you MUST use the explicit config flag to ensure KV bindings are included:

```bash
# Correct deployment command
npx wrangler deploy -c wrangler.toml

# This will show bindings being deployed:
# env.MCP_TOOLS_KV (...)
# env.MCP_SEARCH_INDEX_KV (...)
# env.MCP_MANIFEST_BACKUPS (...)
```

⚠️ **WARNING**: Deploying without `-c wrangler.toml` or from the Cloudflare dashboard will remove KV bindings!

### Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev
# or
npx wrangler dev

# Deploy to production
npm run deploy
# or
npx wrangler deploy -c wrangler.toml
```

### Environment Variables

- `MCP_REGISTRY_SECRET`: API secret for registration endpoint
- `MCPFINDER_API_URL`: Base URL for API (defaults to https://mcpfinder.dev)

### KV Namespaces

- `MCP_TOOLS_KV`: Main storage for registered MCP tools
- `MCP_SEARCH_INDEX_KV`: Search index (optional)

### Testing

```bash
# Test search
curl "https://mcpfinder.dev/api/v1/search?q=github&limit=3"

# Test MCP endpoint
curl -X POST https://mcpfinder.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
```

## Troubleshooting

### KV Namespace Not Available Error

If you see "KV namespace not available" errors:

1. Check that KV namespaces exist in Cloudflare dashboard
2. Verify namespace IDs in wrangler.toml match production
3. Always deploy with `npx wrangler deploy -c wrangler.toml`
4. Don't manually edit bindings in Cloudflare dashboard - they'll be overwritten on next deploy

### Search Returns No Results

1. Check if KV has data: `npx wrangler kv key list --namespace-id <id>`
2. Verify the tool data structure has correct fields (_id, name, description, etc.)

## Architecture

- Built with Hono framework
- Cloudflare Workers runtime
- KV storage for data persistence
- R2 for manifest backups
- MCP protocol support via HTTP/SSE transport