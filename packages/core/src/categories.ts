/**
 * Category inference and keyword extraction for MCP servers.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'that', 'this', 'as', 'are',
  'was', 'be', 'has', 'had', 'have', 'do', 'does', 'did', 'will', 'can',
  'could', 'would', 'should', 'may', 'might', 'shall', 'not', 'no',
  'mcp', 'server', 'tool', 'model', 'context', 'protocol',
]);

/**
 * Extract keywords from name and description for search indexing.
 */
export function extractKeywords(name: string, description: string): string[] {
  const text = `${name} ${description}`.toLowerCase();

  const words = text
    .replace(/[^\w\s-]/g, ' ')
    .split(/[\s/._-]+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  // Deduplicate
  return [...new Set(words)];
}
