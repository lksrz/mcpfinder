# Testing MCPfinder with MCP Inspector

The MCP Inspector is running at: http://localhost:6274

## Access with auth token:
http://localhost:6274/?MCP_PROXY_AUTH_TOKEN=4674702a0790f76769742789a80db5ec589f4980a7c33997851dc9c3db96b8bd

## Testing Instructions:

### 1. Test STDIO variant (mcpfinder-server)

In the MCP Inspector web interface:
1. Click "New Connection"
2. Select "STDIO" transport
3. Enter command: `node`
4. Enter arguments: `/Users/lukasz/Git/mcpfinder/mcpfinder-server/index.js`
5. Click "Connect"

This will connect to the local mcpfinder-server that provides:
- search_mcp_servers
- get_mcp_server_details
- list_trending_servers
- add_mcp_server_config
- remove_mcp_server_config
- stream_mcp_events

### 2. Test HTTP/SSE variant (api-worker)

In the MCP Inspector web interface:
1. Click "New Connection"
2. Select "SSE" transport
3. Enter URL: `http://localhost:8787/mcp`
4. Click "Connect"

This will connect to the Cloudflare Worker endpoint that provides:
- search_mcp_servers
- get_mcp_server_details
- list_trending_servers
- test_echo

## What to test:

1. **List available tools** - Should show all tools for each variant
2. **Search for servers** - Try searching with query "github" or "cli"
3. **Get server details** - Try getting details for "mcp-cli-exec"
4. **List trending servers** - Should show recent servers from KV

## Expected differences:

- **STDIO variant**: Has additional tools for managing local MCP configurations
- **HTTP/SSE variant**: Works over HTTP, suitable for cloud deployment
- Both should return the same data from the MCPfinder registry