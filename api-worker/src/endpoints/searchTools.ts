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
        const listResult = await c.env.MCP_TOOLS_KV.list({ prefix: 'tool:' });
        const keys = listResult.keys;

        // Define a type that includes the score
        type ResultWithScore = ToolSummary & { score: number };

        const results: ResultWithScore[] = [];
        const fetchPromises: Promise<void>[] = [];

        // Fetch and filter manifests concurrently (within Worker limits)
        for (const key of keys) {
            fetchPromises.push(
                (async () => {
                    const manifestJson = await c.env.MCP_TOOLS_KV.get(key.name);
                    if (!manifestJson) return; // Skip if key disappeared

                    try {
                        const manifest = JSON.parse(manifestJson);
                        let score = 0;
                        let isQueryResultMatch = false; // Tracks if any query word matched

                        // Split query into words if it exists
                        const queryWords = query ? query.split(/\s+/).filter(Boolean) : []; // Splits by whitespace, removes empty strings

                        // Calculate score based on query words found
                        if (queryWords.length > 0) {
                            const nameLower = manifest.name?.toLowerCase() || '';
                            const descLower = manifest.description?.toLowerCase() || '';
                            const tagsLower = manifest.tags?.map((t: string) => t.toLowerCase()) || [];
                            
                            // Check for 'capabilities' first, then fall back to 'tools'
                            const toolsArray = (manifest.capabilities && Array.isArray(manifest.capabilities))
                                ? manifest.capabilities
                                : (manifest.tools && Array.isArray(manifest.tools))
                                    ? manifest.tools
                                    : []; // Default to empty array if neither exists

                            const toolDescriptionsLower = toolsArray.map((tool: any) => tool.description?.toLowerCase() || '');

                            queryWords.forEach(word => {
                                let wordFound = false;
                                if (nameLower.includes(word)) wordFound = true;
                                if (descLower.includes(word)) wordFound = true;
                                if (tagsLower.some(manifestTag => manifestTag.includes(word))) wordFound = true;
                                if (toolDescriptionsLower.some(toolDesc => toolDesc.includes(word))) wordFound = true;
                                
                                if (wordFound) {
                                    score++; // Increment score for each unique word found
                                    isQueryResultMatch = true; // Mark that at least one query word matched
                                }
                            });
                        } else {
                            // If no query, all items are considered a match initially for tag filtering
                            isQueryResultMatch = true; 
                        }

                        // Filter by tag (case-insensitive exact match)
                        let isTagMatch = true;
                        if (tag) {
                            const currentTagsLower = manifest.tags?.map((t: string) => t.toLowerCase()) || [];
                            if (!currentTagsLower.includes(tag)) {
                                isTagMatch = false;
                            }
                        }

                        // If it matches filters (query words OR no query, AND tag OR no tag), add summary to results
                        if (isQueryResultMatch && isTagMatch) {
                            results.push({
                                id: manifest._id, // Use the internal ID
                                name: manifest.name,
                                description: manifest.description,
                                url: manifest.url,
                                // Ensure tags is always an array, default to empty if nullish or not an array
                                tags: Array.isArray(manifest.tags) ? manifest.tags : [],
                                score: score, // Include the calculated score
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

        // Sort results by score (descending)
        results.sort((a, b) => b.score - a.score);

        // Limit the results
        const limitedResults = results.slice(0, limit);

        // Map results to the final ToolSummary structure (remove score)
        const finalResults: ToolSummary[] = limitedResults.map(({ score, ...summary }) => summary);

        return c.json(finalResults);

    } catch (error: any) {
        console.error('Error searching tools:', error);
        throw new HTTPException(500, { message: 'Failed to search tools', cause: error.message });
    }
}; 