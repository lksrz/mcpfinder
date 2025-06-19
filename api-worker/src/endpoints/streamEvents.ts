import { Context } from 'hono';
import { Bindings } from '../types';

interface MCPEvent {
  id: string;
  type: 'tool.registered' | 'tool.updated' | 'tool.status_changed' | 'tool.health_checked';
  timestamp: string;
  data: {
    toolId: string;
    name: string;
    description?: string;
    url?: string;
    previousStatus?: string;
    currentStatus?: string;
    changes?: string[];
    tags?: string[];
  };
}

const MAX_CONNECTION_DURATION = 25000; // 25 seconds (leave buffer before 30s limit)
const HEARTBEAT_INTERVAL = 15000; // 15 seconds

export async function streamEvents(c: Context<{ Bindings: Bindings }>): Promise<Response> {
  // Get query parameters
  const since = c.req.query('since');
  const filter = c.req.query('filter')?.split(',') || [];
  
  // Validate parameters
  const sinceTimestamp = since ? new Date(since).getTime() : Date.now() - 3600000; // Default: last hour
  
  if (isNaN(sinceTimestamp)) {
    return c.json({ error: 'Invalid since parameter' }, 400);
  }

  // Check if KV is available
  if (!c.env || !c.env.MCP_TOOLS_KV) {
    console.error('KV namespace not available:', { env: c.env });
    return c.json({ error: 'KV namespace not configured' }, 500);
  }

  // Create a TransformStream for SSE
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  
  const stream = new ReadableStream({
    async start(ctrl) {
      controller = ctrl;
      
      // Send initial connection message
      controller.enqueue(encoder.encode(': connected\n\n'));
      
      try {
        // Fetch recent events from KV
        const eventKeys = await c.env.MCP_TOOLS_KV.list({ prefix: 'event:', limit: 100 });
        
        // Sort and filter events
        const events: MCPEvent[] = [];
        for (const key of eventKeys.keys) {
          const eventData = await c.env.MCP_TOOLS_KV.get(key.name, 'json') as MCPEvent;
          if (eventData && new Date(eventData.timestamp).getTime() > sinceTimestamp) {
            if (filter.length === 0 || filter.includes(eventData.type)) {
              events.push(eventData);
            }
          }
        }
        
        // Send historical events
        events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        for (const event of events) {
          const eventData = `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(eventData));
        }
        
        // Set up heartbeat
        const startTime = Date.now();
        const heartbeatInterval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          } catch (e) {
            clearInterval(heartbeatInterval);
          }
        }, HEARTBEAT_INTERVAL);
        
        // Set timeout to close connection
        setTimeout(() => {
          clearInterval(heartbeatInterval);
          controller.enqueue(encoder.encode('event: close\ndata: {"reason": "timeout"}\n\n'));
          controller.close();
        }, MAX_CONNECTION_DURATION);
        
      } catch (error) {
        console.error('SSE stream error:', error);
        controller.enqueue(encoder.encode(`event: error\ndata: {"error": "${error}"}\n\n`));
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

// Helper function to create and store events
export async function createEvent(
  env: Bindings,
  type: MCPEvent['type'],
  data: MCPEvent['data']
): Promise<void> {
  const event: MCPEvent = {
    id: crypto.randomUUID(),
    type,
    timestamp: new Date().toISOString(),
    data,
  };
  
  // Store event with TTL (7 days)
  const eventKey = `event:${event.timestamp}:${event.id}`;
  await env.MCP_TOOLS_KV.put(eventKey, JSON.stringify(event), {
    expirationTtl: 604800, // 7 days in seconds
  });
  
  // Also maintain a recent events index (last 100 events)
  const recentKey = `recent:${Date.now()}:${event.id}`;
  await env.MCP_TOOLS_KV.put(recentKey, event.id, {
    expirationTtl: 86400, // 1 day
  });
}