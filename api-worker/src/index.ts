import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { registerTool } from './endpoints/registerTool';
import { getToolById } from './endpoints/getToolById'; // Import the new handler
import { searchTools } from './endpoints/searchTools'; // Import the new handler
import { streamEvents } from './endpoints/streamEvents';
import { testKV } from './endpoints/testKV';
import { mcpSSE, mcpSSERequest } from './endpoints/mcpSSE';
import { mcpSSETransport } from './endpoints/mcpSSETransport';
import { mcpHTTP } from './endpoints/mcpHTTP';
import { Bindings } from './types'; // Import the new Bindings type

// Assuming Env types are defined in ./types.ts or globally for Cloudflare Workers
// Example: type Env = { Bindings: { MCP_TOOLS_KV: KVNamespace, MCP_MANIFEST_BACKUPS: R2Bucket, MCP_REGISTRY_SECRET: string } };
// Make sure Env type is correctly defined based on wrangler.toml bindings

const app = new Hono<{ Bindings: Bindings }>();

// CORS Middleware
app.use('/api/*', cors());

// Basic Error Handling
app.onError((err, c) => {
	console.error(`[Error]: ${err.message}`, err.stack);
	if (err instanceof HTTPException) {
		// Use the HTTPException status and message
		return err.getResponse();
	}
	// Default internal server error
	return c.json({ error: 'Internal Server Error', message: err.message }, 500);
});

// API v1 Router
const apiV1 = new Hono<{ Bindings: Bindings }>();

// Register endpoint handler
apiV1.post('/register', registerTool);
apiV1.get('/tools/:id', getToolById); // Connect the handler

// --- Use the actual searchTools handler ---
apiV1.get('/search', searchTools);

// SSE endpoint for real-time updates
apiV1.get('/events', streamEvents);

// Test KV endpoint
apiV1.get('/test-kv', testKV);

// MCP HTTP endpoint with SSE support
apiV1.get('/mcp', mcpHTTP);
apiV1.post('/mcp', mcpHTTP);
apiV1.options('/mcp', mcpHTTP);

// Legacy endpoints (can be removed later)
apiV1.get('/mcp/sse', mcpSSE);
apiV1.post('/mcp/sse', mcpSSERequest);

// --- REMOVE Placeholder Endpoint ---
// apiV1.get('/search', (c) => c.json({ message: 'Search tools placeholder' }));

// Mount the v1 router
app.route('/api/v1', apiV1);

// Basic root route
app.get('/', (c) => c.text('MCP Finder API'));

// MCP endpoint at root level
app.get('/mcp', mcpHTTP);
app.post('/mcp', mcpHTTP);
app.options('/mcp', mcpHTTP);

// Apply CORS to MCP endpoint
app.use('/mcp', cors());

export default app;
