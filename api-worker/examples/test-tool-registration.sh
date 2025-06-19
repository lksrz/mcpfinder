#!/bin/bash

# Test tool registration to trigger SSE events

API_URL="http://localhost:8787/api/v1"
API_KEY="your-api-key-here"

# Register a new tool
echo "Registering new tool..."
curl -X POST "$API_URL/register" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "name": "test-calculator",
    "description": "A test calculator tool for SSE testing",
    "url": "stdio://./test-calculator",
    "protocol_version": "2024-11-05",
    "capabilities": [
      {
        "name": "add",
        "type": "tool",
        "description": "Add two numbers"
      },
      {
        "name": "subtract",
        "type": "tool",
        "description": "Subtract two numbers"
      }
    ],
    "tags": ["math", "calculator", "test"]
  }'

echo -e "\n\nWait 2 seconds..."
sleep 2

# Update the tool
echo -e "\n\nUpdating tool..."
curl -X POST "$API_URL/register" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $API_KEY" \
  -d '{
    "name": "test-calculator",
    "description": "An updated test calculator tool with more features",
    "url": "stdio://./test-calculator",
    "protocol_version": "2024-11-05",
    "capabilities": [
      {
        "name": "add",
        "type": "tool",
        "description": "Add two numbers"
      },
      {
        "name": "subtract",
        "type": "tool",
        "description": "Subtract two numbers"
      },
      {
        "name": "multiply",
        "type": "tool",
        "description": "Multiply two numbers"
      }
    ],
    "tags": ["math", "calculator", "test", "updated"]
  }'