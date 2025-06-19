# MCP (Model Context Protocol) Endpoint Documentation

## Overview

MCPfinder provides a fully MCP-compatible HTTP endpoint that allows AI assistants like Claude to interact with the MCPfinder registry directly.

## Endpoint Details

### Production URL
```
https://mcpfinder.dev/mcp
```

### Protocol Support
- **HTTP Transport**: Standard JSON-RPC 2.0 over HTTP POST
- **SSE Support**: Server-Sent Events for real-time streaming (GET requests)

## Adding to Claude

### Via Claude CLI

```bash
# Add MCPfinder to Claude
claude mcp add --transport http mcpfinder https://mcpfinder.dev/mcp

# Verify installation
claude mcp list

# Use in Claude
# Type /mcp in Claude to see available tools
```

### Manual Configuration

If you prefer to configure manually, add to your Claude configuration:

```json
{
  "mcpServers": {
    "mcpfinder": {
      "url": "https://mcpfinder.dev/mcp",
      "transport": "http"
    }
  }
}
```

## Available Tools

### 1. search_mcp_servers
Search for MCP servers in the registry.

**Parameters:**
- `query` (string, optional): Search query to find servers by name, tags, or description
- `tag` (string, optional): Filter results by a specific tag
- `capability` (string, optional): Filter by capability type (`tool`, `resource`, or `prompt`)
- `limit` (number, optional): Maximum number of results to return (default: 10)

**Example:**
```json
{
  "query": "github",
  "tag": "git",
  "capability": "tool",
  "limit": 5
}
```

### 2. get_mcp_server_details
Get detailed information about a specific MCP server.

**Parameters:**
- `name` (string, required): Exact name of the MCP server

**Example:**
```json
{
  "name": "@modelcontextprotocol/server-github"
}
```

### 3. list_trending_servers
Get a list of trending/popular MCP servers.

**Parameters:**
- `limit` (number, optional): Number of servers to return (default: 10)

**Example:**
```json
{
  "limit": 5
}
```

### 4. test_echo
Test connectivity to the MCP endpoint.

**Parameters:**
- `message` (string): Message to echo back

**Example:**
```json
{
  "message": "Hello, MCPfinder!"
}
```

## Protocol Examples

### Initialize Connection

```bash
curl -X POST https://mcpfinder.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
      "protocolVersion": "2024-11-05",
      "capabilities": {},
      "clientInfo": {
        "name": "test-client",
        "version": "1.0.0"
      }
    }
  }'
```

Response:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": "2024-11-05",
    "capabilities": {
      "tools": {}
    },
    "serverInfo": {
      "name": "mcpfinder-http",
      "version": "0.1.0"
    }
  }
}
```

### List Available Tools

```bash
curl -X POST https://mcpfinder.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/list",
    "params": {}
  }'
```

### Call a Tool

```bash
curl -X POST https://mcpfinder.dev/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "search_mcp_servers",
      "arguments": {
        "query": "github",
        "limit": 3
      }
    }
  }'
```

## Browser Access

When accessing the endpoint in a browser, you'll see an informative HTML page explaining the endpoint usage.

## Error Handling

The endpoint follows standard JSON-RPC 2.0 error codes:

- `-32700`: Parse error
- `-32600`: Invalid Request
- `-32601`: Method not found
- `-32603`: Internal error

## Rate Limiting

The endpoint inherits Cloudflare Workers rate limits:
- 100,000 requests per day (free plan)
- 10 million requests per month (paid plan)

## Implementation Details

The MCP endpoint is implemented as part of the MCPfinder API worker and:
- Uses the same KV storage as the REST API
- Provides real-time access to the tool registry
- Supports both synchronous and streaming responses
- Is fully compatible with the MCP specification