# API Worker

The core REST API Worker for MCPfinder registry, providing registration and discovery endpoints. Also includes an MCP Server implementation with HTTP/SSE transport.

## Endpoints

### Registry API
- `POST /api/v1/register` - Register a new MCP tool
- `GET /api/v1/search` - Search for MCP tools  
- `GET /api/v1/tools/:name` - Get details for a specific tool
- `GET /api/v1/trending` - Get trending tools

### MCP Server Endpoint
- `GET /mcp` - SSE connection for MCP protocol
- `POST /mcp` - JSON-RPC requests for MCP protocol
- `OPTIONS /mcp` - CORS preflight handling

## MCP Server

The `/mcp` endpoint provides an HTTP/SSE transport variant of the mcpfinder MCP server, offering the same functionality as the stdio variant but accessible over the web.

### Supported MCP Tools
- `search_mcp_servers` - Search for MCP servers in the registry
- `get_mcp_server_details` - Get detailed information about a specific server
- `list_trending_servers` - Get a list of trending MCP servers
- `test_echo` - Test tool for connectivity verification

### Usage with Claude CLI

```bash
# Add HTTP transport configuration
claude mcp add mcpfinder-http http://localhost:8787/mcp

# Test the connection
claude mcp test mcpfinder-http

# Use tools
claude --mcp mcpfinder-http "search for weather tools"
```

### Usage with MCP Inspector

```bash
# Test stdio variant
cd mcp-inspector
npm run dev -- --transport stdio --command "node ../mcpfinder-server/index.js"

# Test HTTP/SSE variant  
npm run dev -- --transport http --url http://localhost:8787/mcp
```

## Development

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Deploy to Cloudflare
npx wrangler deploy
```

## Configuration

Configure in `wrangler.toml`:
- `MCP_TOOLS_KV` - KV namespace for tool storage
- `MCPFINDER_API_URL` - API base URL (default: https://mcpfinder.dev)
- `MCP_REGISTRY_SECRET` - Secret for tool registration