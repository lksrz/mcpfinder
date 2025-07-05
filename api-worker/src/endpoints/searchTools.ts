import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { Bindings } from '../types';

interface ToolSummary {
    id: string;
    name: string;
    description: string;
    url: string;
    tags?: string[];
}

// Maximum number of KV items to scan for search
const MAX_SCAN_ITEMS = 5000;
const BATCH_SIZE = 1000;

export const searchTools = async (c: Context<{ Bindings: Bindings }>) => {
    const query = c.req.query('q')?.toLowerCase();
    const tag = c.req.query('tag')?.toLowerCase();
    let limit = parseInt(c.req.query('limit') || '50', 10);
    const HARD_LIMIT = 100;

    if (isNaN(limit) || limit <= 0) {
        limit = 50;
        if (parseInt(c.req.query('limit') || 'ignored', 10) <= 0) {
            throw new HTTPException(400, { message: 'Invalid limit parameter: must be positive' });
        }
    }
    limit = Math.min(limit, HARD_LIMIT);

    try {
        // For trending/no query - just return first N items
        if (!query && !tag) {
            const listResult = await c.env.MCP_TOOLS_KV.list({ 
                prefix: 'tool:', 
                limit: limit 
            });
            
            const tools = await Promise.all(
                listResult.keys.map(key => c.env.MCP_TOOLS_KV.get(key.name))
            );
            
            const results = tools
                .filter(Boolean)
                .map(manifestJson => {
                    const manifest = JSON.parse(manifestJson as string);
                    return {
                        id: manifest._id,
                        name: manifest.name,
                        description: manifest.description,
                        url: manifest.url,
                        tags: Array.isArray(manifest.tags) ? manifest.tags : []
                    };
                });
                
            // Add cache headers for non-search queries
            c.header('Cache-Control', 'public, max-age=300');
            return c.json(results);
        }

        // For search queries - use pagination to avoid memory issues
        const results: (ToolSummary & { score: number })[] = [];
        let cursor: string | undefined;
        let scannedItems = 0;
        
        // Split query into words
        const queryWords = query ? query.split(/\s+/).filter(Boolean) : [];

        // Scan in batches until we have enough results or hit the scan limit
        while (results.length < limit && scannedItems < MAX_SCAN_ITEMS) {
            const listResult = await c.env.MCP_TOOLS_KV.list({ 
                prefix: 'tool:', 
                limit: BATCH_SIZE,
                cursor 
            });
            
            if (listResult.keys.length === 0) break;
            
            // Process this batch
            const batchPromises = listResult.keys.map(async (key) => {
                const manifestJson = await c.env.MCP_TOOLS_KV.get(key.name);
                if (!manifestJson) return null;
                
                try {
                    const manifest = JSON.parse(manifestJson);
                    let score = 0;
                    let matches = false;
                    
                    // Calculate relevance score
                    if (queryWords.length > 0) {
                        const nameLower = manifest.name?.toLowerCase() || '';
                        const descLower = manifest.description?.toLowerCase() || '';
                        const tagsLower = manifest.tags?.map((t: string) => t.toLowerCase()) || [];
                        
                        // Check for 'capabilities' first, then fall back to 'tools'
                        const toolsArray = (manifest.capabilities && Array.isArray(manifest.capabilities))
                            ? manifest.capabilities
                            : (manifest.tools && Array.isArray(manifest.tools))
                                ? manifest.tools
                                : [];

                        const toolDescriptionsLower = toolsArray.map((tool: any) => tool.description?.toLowerCase() || '');
                        
                        queryWords.forEach(word => {
                            if (nameLower.includes(word)) {
                                score += 3; // Name match is highest priority
                                matches = true;
                            }
                            if (descLower.includes(word)) {
                                score += 1;
                                matches = true;
                            }
                            if (tagsLower.some(t => t.includes(word))) {
                                score += 2;
                                matches = true;
                            }
                            if (toolDescriptionsLower.some(desc => desc.includes(word))) {
                                score += 1;
                                matches = true;
                            }
                        });
                    } else {
                        matches = true; // No query means match all
                    }
                    
                    // Check tag filter
                    if (tag && matches) {
                        const currentTagsLower = manifest.tags?.map((t: string) => t.toLowerCase()) || [];
                        if (!currentTagsLower.includes(tag)) {
                            matches = false;
                        }
                    }
                    
                    if (matches) {
                        return {
                            id: manifest._id,
                            name: manifest.name,
                            description: manifest.description,
                            url: manifest.url,
                            tags: Array.isArray(manifest.tags) ? manifest.tags : [],
                            score
                        };
                    }
                    
                    return null;
                } catch (e) {
                    console.error(`Error parsing manifest for key ${key.name}:`, e);
                    return null;
                }
            });
            
            const batchResults = (await Promise.all(batchPromises))
                .filter((r): r is ToolSummary & { score: number } => r !== null);
            
            results.push(...batchResults);
            scannedItems += listResult.keys.length;
            cursor = listResult.cursor;
            
            // Stop if no more items
            if (!cursor) break;
        }
        
        // Sort by score and limit
        results.sort((a, b) => b.score - a.score);
        const limitedResults = results.slice(0, limit);
        
        // Remove score from final output
        const finalResults = limitedResults.map(({ score, ...summary }) => summary);
        
        // Add cache headers for search results (shorter cache)
        c.header('Cache-Control', 'public, max-age=60');
        
        return c.json(finalResults);

    } catch (error: any) {
        console.error('Error searching tools:', error);
        throw new HTTPException(500, { message: 'Failed to search tools', cause: error.message });
    }
}; 