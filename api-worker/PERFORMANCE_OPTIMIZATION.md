# API Worker Performance Optimization Guide

## Current Issues

### 1. Search Performance (Critical)
The current search implementation in `searchTools.ts` has severe scalability issues:

```typescript
// PROBLEM: Lists ALL keys without limit
const listResult = await c.env.MCP_TOOLS_KV.list({ prefix: 'tool:' });

// PROBLEM: Fetches ALL tools into memory
for (const key of keys) {
    const manifestJson = await c.env.MCP_TOOLS_KV.get(key.name);
    // Process in memory...
}
```

### 2. No Search Index
- Every search is O(n) where n = total number of tools
- Text search happens in JavaScript, not at database level
- No full-text search capabilities

### 3. Missing Caching
- No HTTP caching headers for read operations
- No edge caching for frequently accessed data
- Every request hits KV storage

## Recommended Solutions

### 1. Implement KV Pagination
```typescript
// Use cursor-based pagination
let cursor: string | undefined;
const BATCH_SIZE = 1000;
const allKeys = [];

do {
    const listResult = await c.env.MCP_TOOLS_KV.list({ 
        prefix: 'tool:', 
        limit: BATCH_SIZE,
        cursor 
    });
    allKeys.push(...listResult.keys);
    cursor = listResult.cursor;
} while (cursor && allKeys.length < MAX_SEARCH_ITEMS);
```

### 2. Add Search Index
Create a separate KV namespace for search index:

```typescript
// During registration:
// 1. Store full manifest in MCP_TOOLS_KV
await env.MCP_TOOLS_KV.put(`tool:${id}`, JSON.stringify(manifest));

// 2. Store search index entries
const searchTerms = [
    manifest.name.toLowerCase(),
    ...manifest.description.toLowerCase().split(' '),
    ...manifest.tags
];

for (const term of searchTerms) {
    const key = `search:${term}:${id}`;
    await env.MCP_SEARCH_INDEX_KV.put(key, id, {
        expirationTtl: 86400 * 30 // 30 days
    });
}
```

### 3. Implement Smart Search
```typescript
export const searchToolsOptimized = async (c: Context) => {
    const query = c.req.query('q')?.toLowerCase();
    
    // For queries, use search index
    if (query) {
        const searchTerms = query.split(' ');
        const toolIds = new Set<string>();
        
        // Get matching tool IDs from index
        for (const term of searchTerms) {
            const matches = await c.env.MCP_SEARCH_INDEX_KV.list({
                prefix: `search:${term}:`,
                limit: 100
            });
            
            matches.keys.forEach(key => {
                const toolId = key.name.split(':').pop();
                if (toolId) toolIds.add(toolId);
            });
        }
        
        // Batch fetch actual tools
        const tools = await Promise.all(
            Array.from(toolIds).slice(0, limit).map(id => 
                c.env.MCP_TOOLS_KV.get(`tool:${id}`)
            )
        );
        
        return c.json(tools.filter(Boolean).map(t => JSON.parse(t)));
    }
    
    // For no query, use pagination
    const results = await c.env.MCP_TOOLS_KV.list({
        prefix: 'tool:',
        limit: Math.min(limit, 100)
    });
    
    // Fetch in parallel
    const tools = await Promise.all(
        results.keys.map(key => c.env.MCP_TOOLS_KV.get(key.name))
    );
    
    return c.json(tools.filter(Boolean).map(t => JSON.parse(t)));
};
```

### 4. Add Caching Headers
```typescript
// For search results (cache for 5 minutes)
c.header('Cache-Control', 'public, max-age=300, s-maxage=300');
c.header('CDN-Cache-Control', 'max-age=300');

// For individual tool details (cache for 1 hour)
c.header('Cache-Control', 'public, max-age=3600, s-maxage=3600');

// For real-time endpoints (no cache)
c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
```

### 5. Use Durable Objects for Hot Data
For frequently accessed tools, consider using Durable Objects:

```typescript
// In wrangler.toml
[[durable_objects.bindings]]
name = "TOOL_CACHE"
class_name = "ToolCache"

// ToolCache class
export class ToolCache {
    private state: DurableObjectState;
    private cache: Map<string, any> = new Map();
    
    async fetch(request: Request) {
        const url = new URL(request.url);
        const toolId = url.searchParams.get('id');
        
        // Check memory cache first
        if (this.cache.has(toolId)) {
            return new Response(JSON.stringify(this.cache.get(toolId)));
        }
        
        // Fetch from KV and cache
        const tool = await this.env.MCP_TOOLS_KV.get(`tool:${toolId}`);
        if (tool) {
            this.cache.set(toolId, JSON.parse(tool));
        }
        
        return new Response(tool || 'null');
    }
}
```

### 6. Batch Operations
For endpoints that fetch multiple tools:

```typescript
// Instead of sequential fetches
const tools = [];
for (const id of toolIds) {
    const tool = await env.MCP_TOOLS_KV.get(`tool:${id}`);
    tools.push(tool);
}

// Use parallel batches
const BATCH_SIZE = 10;
const batches = [];
for (let i = 0; i < toolIds.length; i += BATCH_SIZE) {
    const batch = toolIds.slice(i, i + BATCH_SIZE);
    batches.push(Promise.all(
        batch.map(id => env.MCP_TOOLS_KV.get(`tool:${id}`))
    ));
}
const results = (await Promise.all(batches)).flat();
```

## Priority Actions

1. **Immediate**: Add pagination to `list()` calls
2. **High**: Implement search index for query performance  
3. **Medium**: Add caching headers
4. **Low**: Consider Durable Objects for hot data

## Monitoring

Add metrics to track:
- Search response times
- Number of KV operations per request
- Cache hit rates
- Query patterns for index optimization