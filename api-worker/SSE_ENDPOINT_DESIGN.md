# MCP SSE Endpoint Design

## Overview

The SSE (Server-Sent Events) endpoint provides real-time updates about MCP tools in the registry. This enables clients to receive notifications when tools are registered, updated, or their status changes.

## Endpoint

```
GET /api/v1/events
```

## Query Parameters

- `since` (optional): ISO 8601 timestamp to receive events from. Defaults to 1 hour ago.
- `filter` (optional): Comma-separated list of event types to receive. If not specified, all events are sent.

## Event Types

- `tool.registered`: New tool added to the registry
- `tool.updated`: Existing tool manifest updated
- `tool.status_changed`: Tool health status changed
- `tool.health_checked`: Tool health check performed

## Event Structure

```typescript
interface MCPEvent {
  id: string;                  // Unique event ID
  type: string;                // Event type
  timestamp: string;           // ISO 8601 timestamp
  data: {
    toolId: string;           // Tool UUID
    name: string;             // Tool name
    description?: string;     // Tool description
    url?: string;             // Tool URL
    previousStatus?: string;  // Previous status (for status changes)
    currentStatus?: string;   // Current status (for status changes)
    changes?: string[];       // List of changed fields (for updates)
    tags?: string[];          // Tool tags
  };
}
```

## Implementation Details

### Cloudflare Workers Constraints

Due to Cloudflare Workers limitations:
- Connections automatically close after 25 seconds
- Events are buffered in KV storage with 7-day TTL
- Clients should implement automatic reconnection

### Storage Architecture

- Events stored with key pattern: `event:{timestamp}:{uuid}`
- Recent events index maintained for efficient queries
- 7-day retention for historical events

### Connection Lifecycle

1. Client connects with optional `since` parameter
2. Server sends historical events matching filters
3. Server polls for new events every 2 seconds
4. Heartbeat sent every 15 seconds
5. Connection closes after 25 seconds with `close` event
6. Client should reconnect to continue receiving events

## Client Implementation

### JavaScript Example

```javascript
const eventSource = new EventSource('/api/v1/events?filter=tool.registered,tool.updated');

eventSource.addEventListener('tool.registered', (event) => {
  const data = JSON.parse(event.data);
  console.log('New tool registered:', data);
});

eventSource.addEventListener('close', (event) => {
  const data = JSON.parse(event.data);
  console.log('Connection closed:', data.reason);
  // Implement reconnection logic
});

eventSource.onerror = (error) => {
  console.error('SSE error:', error);
  // Implement exponential backoff reconnection
};
```

### Reconnection Strategy

```javascript
let reconnectDelay = 1000;
const maxDelay = 30000;

function reconnect() {
  setTimeout(() => {
    connectSSE();
    reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
  }, reconnectDelay);
}
```

## Integration Points

### Tool Registration

When a tool is registered/updated via `/api/v1/register`, an event is automatically created:

```javascript
await createEvent(env, isNewTool ? 'tool.registered' : 'tool.updated', {
  toolId,
  name: manifestData.name,
  description: manifestData.description,
  url: manifestData.url,
  tags: manifestData.tags,
  changes: isNewTool ? undefined : changes
});
```

### Health Checks

The health worker should be updated to create events when tool status changes:

```javascript
if (previousStatus !== currentStatus) {
  await createEvent(env, 'tool.status_changed', {
    toolId,
    name: tool.name,
    previousStatus,
    currentStatus
  });
}
```

## Testing

Use the provided HTML client example:

```bash
# Start local development server
wrangler dev

# Open examples/sse-client.html in browser
# Connect to http://localhost:8787/api/v1/events
```

## Security Considerations

- No authentication required for public event stream
- Sensitive data should not be included in events
- Consider rate limiting for production deployment

## Future Enhancements

1. **WebSocket Alternative**: For true real-time updates without reconnection overhead
2. **Durable Objects**: Maintain persistent connections beyond 30-second limit
3. **Event Filtering**: More sophisticated server-side filtering (by tags, capabilities)
4. **Authentication**: Optional authenticated streams for private registries
5. **Aggregated Events**: Batch multiple changes into single events