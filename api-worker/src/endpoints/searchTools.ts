import { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { Bindings } from '../types';

// Simple debounce/cache might be useful here in a real scenario

// Define the structure of the summary object returned by search
interface ToolSummary {
    id: string;
    name: string;
    description: string;
    url: string;
    tags?: string[];
}

export const searchTools = async (c: Context<{ Bindings: Bindings }>) => {
    const query = c.req.query('q')?.toLowerCase();
    const tag = c.req.query('tag')?.toLowerCase();
    const limit = parseInt(c.req.query('limit') || '50', 10);

    if (isNaN(limit) || limit <= 0) {
        throw new HTTPException(400, { message: 'Invalid limit parameter' });
    }

    try {
        // List all tool keys from KV (potentially slow for large datasets)
        const listResult = await c.env.MCP_TOOLS_KV.list({ prefix: 'tool:' });
        const keys = listResult.keys;

        const results: ToolSummary[] = [];
        const fetchPromises: Promise<void>[] = [];

        // Fetch and filter manifests concurrently (within Worker limits)
        for (const key of keys) {
            fetchPromises.push(
                (async () => {
                    const manifestJson = await c.env.MCP_TOOLS_KV.get(key.name);
                    if (!manifestJson) return; // Skip if key disappeared

                    try {
                        const manifest = JSON.parse(manifestJson);
                        let match = true; // Assume match initially

                        // Split query into words if it exists
                        const queryWords = query ? query.split(/\s+/).filter(Boolean) : []; // Splits by whitespace, removes empty strings

                        // Filter by query words (match if ANY word is found in name, desc, or tags)
                        if (queryWords.length > 0) {
                            const nameLower = manifest.name?.toLowerCase() || '';
                            const descLower = manifest.description?.toLowerCase() || '';
                            // Ensure tags are always an array for the check
                            const tagsLower = manifest.tags?.map((t: string) => t.toLowerCase()) || []; 
                            
                            const wordMatch = queryWords.some(word => 
                                nameLower.includes(word) || 
                                descLower.includes(word) ||
                                // Check if any tag in the manifest includes the word
                                tagsLower.some(manifestTag => manifestTag.includes(word))
                            );
                            
                            if (!wordMatch) {
                                match = false;
                            }
                        }

                        // Filter by tag (case-insensitive exact match)
                        if (match && tag) {
                            // Use tagsLower if already calculated, otherwise calculate here
                            const currentTagsLower = manifest.tags?.map((t: string) => t.toLowerCase()) || [];
                            if (!currentTagsLower.includes(tag)) {
                                match = false;
                            }
                        }

                        // If it matches filters (or no filters applied), add summary to results
                        if (match) {
                            // Use push which is safe for concurrent access if order doesn't matter
                            results.push({
                                id: manifest._id, // Use the internal ID
                                name: manifest.name,
                                description: manifest.description,
                                url: manifest.url,
                                tags: manifest.tags,
                            });
                        }
                    } catch (parseError) {
                        console.error(`Error parsing manifest for key ${key.name}:`, parseError);
                        // Optionally log this error, but continue processing others
                    }
                })()
            );
        }

        // Wait for all fetches and filters to complete
        await Promise.all(fetchPromises);

        // Limit the results
        const limitedResults = results.slice(0, limit);

        return c.json(limitedResults);

    } catch (error: any) {
        console.error('Error searching tools:', error);
        throw new HTTPException(500, { message: 'Failed to search tools', cause: error.message });
    }
}; 