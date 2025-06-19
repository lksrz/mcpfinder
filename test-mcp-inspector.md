# Testing MCPfinder with MCP Inspector

This document explains how to test both MCPfinder transport variants using the MCP Inspector.

## Setup

1. Start the MCP Inspector:
   ```bash
   cd mcp-inspector
   npm run dev
   ```

2. Start the api-worker for HTTP/SSE testing:
   ```bash
   cd api-worker
   npm run dev
   ```

The MCP Inspector will be available at http://localhost:6274

## Testing Instructions:

### 1. Test STDIO Transport (mcpfinder-server)

**Purpose**: Local MCP server for direct integration with AI clients

In the MCP Inspector web interface:
1. Click "New Connection"
2. Select "STDIO" transport
3. Enter command: `node`
4. Enter arguments: `./mcpfinder-server/index.js` (relative to project root)
5. Click "Connect"

**Available Tools**:
- `search_mcp_servers` - Search the registry
- `get_mcp_server_details` - Get detailed server info
- `list_trending_servers` - List popular servers
- `add_mcp_server_config` - Add server to local config
- `remove_mcp_server_config` - Remove server from local config
- `stream_mcp_events` - Stream registry events

### 2. Test HTTP/SSE Transport (api-worker)

**Purpose**: Web-accessible MCP server for cloud deployment and HTTP clients

In the MCP Inspector web interface:
1. Click "New Connection"
2. Select "SSE" transport  
3. Enter URL: `http://localhost:8787/mcp`
4. Click "Connect"

**Available Tools**:
- `search_mcp_servers` - Search the registry
- `get_mcp_server_details` - Get detailed server info
- `list_trending_servers` - List popular servers
- `test_echo` - Connectivity test tool

**Key Differences from STDIO**:
- No local config management (cloud-native)
- No event streaming (stateless HTTP)
- Optimized for web deployment
- Direct KV access for better performance

## Test Scenarios

### Basic Connectivity
1. **List available tools** - Verify each transport shows its tools
2. **Test echo** (HTTP/SSE only) - Verify basic connectivity

### Registry Operations
1. **Search for servers**:
   - Try query: "github" 
   - Try query: "cli"
   - Try empty search to see all
   
2. **Get server details**:
   - Try: "mcp-cli-exec"
   - Try non-existent server
   
3. **List trending servers** - Should show recent servers from registry

### Transport-Specific Features
1. **STDIO only**: Test config management tools
   - `add_mcp_server_config`
   - `remove_mcp_server_config` 
   - `stream_mcp_events`

2. **HTTP/SSE only**: Test web features
   - CORS handling
   - Session management
   - SSE connection stability

## Expected Behavior

- **Data consistency**: Both transports should return identical registry data
- **Transport differences**: STDIO has local config tools, HTTP/SSE is stateless
- **Performance**: HTTP/SSE uses direct KV access, STDIO uses API calls
- **Error handling**: Both should gracefully handle invalid requests