#!/bin/bash

# Script to clean up duplicate MCP server registrations
# Generated from duplicate analysis

echo "🧹 Cleaning up duplicate MCP server registrations..."
echo ""

# Delete duplicate tools (but NOT the urlidx entries - those will be updated)
echo "Deleting duplicate tool entries..."

# 1. @aashari/mcp-server-atlassian-confluence duplicate
echo "Deleting duplicate: @aashari/mcp-server-atlassian-confluence (0801000b-7810-4eef-8f96-97659cd8e6ef)"
npx wrangler kv delete "tool:0801000b-7810-4eef-8f96-97659cd8e6ef" --namespace-id 59bfeb2ef6ab471a9a3461f113704891

# 2. @modelcontextprotocol/server-github duplicate  
echo "Deleting duplicate: @modelcontextprotocol/server-github (173b7d0a-8998-4973-8b2e-d27fd1466ace)"
npx wrangler kv delete "tool:173b7d0a-8998-4973-8b2e-d27fd1466ace" --namespace-id 59bfeb2ef6ab471a9a3461f113704891

# 3. mcp-local-file-reader duplicate
echo "Deleting duplicate: mcp-local-file-reader (1bc65e09-3200-4879-b334-6fbe1cdf203f)"
npx wrangler kv delete "tool:1bc65e09-3200-4879-b334-6fbe1cdf203f" --namespace-id 59bfeb2ef6ab471a9a3461f113704891

echo ""
echo "✅ Duplicate cleanup complete!"
echo ""
echo "Note: The urlidx entries are kept and already point to the correct remaining tools."