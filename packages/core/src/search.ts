/**
 * Search engine using SQLite FTS5 for MCP server discovery.
 * Ranking formula: fts_rank * 0.4 + log(useCount+1) * 0.3 + source_count * 0.2 + recency * 0.1
 */
import type Database from 'better-sqlite3';
import type { McpServer, SearchResult, ServerDetail } from './types.js';

/**
 * Find a server by name, slug, or fuzzy match.
 *
 * Lookup priority:
 * 1. Exact match (id, slug, name, suffix /query)
 * 2. Fuzzy substring match with smart ranking:
 *    - Exact word boundary match (e.g. /puppeteer) ranks highest
 *    - Closer to start of name ranks higher (puppeteer-xxx > xxx-puppeteer)
 *    - Higher popularity (use_count) breaks ties
 * 3. FTS5 fallback for best semantic match
 */
export function findServerByNameOrSlug(
  db: Database.Database,
  nameOrSlug: string,
): McpServer | undefined {
  // Reject empty/whitespace queries
  const query = nameOrSlug.trim();
  if (!query) return undefined;

  // 1. Exact match (id, slug, name, or name ending with /query)
  let row = db
    .prepare(
      `SELECT * FROM servers
       WHERE id = ?
          OR slug = ?
          OR name = ?
          OR name LIKE ?
       LIMIT 1`,
    )
    .get(query, query, query, `%/${query}`) as McpServer | undefined;

  if (row) return row;

  // 2. Fuzzy substring match with smart ranking
  //    Score: exact word boundary > prefix > early position > late position
  //    Within each tier, sort by popularity (use_count)
  const pattern = `%${query}%`;
  const rows = db
    .prepare(
      `SELECT * FROM servers
       WHERE name LIKE ? COLLATE NOCASE
          OR slug LIKE ? COLLATE NOCASE
       ORDER BY use_count DESC
       LIMIT 50`,
    )
    .all(pattern, pattern) as McpServer[];

  if (rows.length > 0) {
    const qLower = query.toLowerCase();

    // Score each match — lower is better
    const scored = rows.map((r) => {
      const nameLower = (r.name || '').toLowerCase();
      const slugLower = (r.slug || '').toLowerCase();

      // Check both name and slug, take best score
      let score = 1000;

      for (const field of [nameLower, slugLower]) {
        if (!field) continue;
        const pos = field.indexOf(qLower);
        if (pos === -1) continue;

        // Extract the last segment after / for name matching
        const lastSegment = field.includes('/') ? field.split('/').pop()! : field;
        const segPos = lastSegment.indexOf(qLower);

        if (lastSegment === qLower) {
          // Exact match on last segment: /puppeteer → best
          score = Math.min(score, 0);
        } else if (segPos === 0) {
          // Prefix of last segment: puppeteer-xxx → very good
          score = Math.min(score, 10);
        } else if (field.charAt(pos - 1) === '-' || field.charAt(pos - 1) === '_' || field.charAt(pos - 1) === '/') {
          // Word boundary match: xxx-puppeteer or xxx/puppeteer → good
          score = Math.min(score, 20 + pos);
        } else {
          // Substring match: xxxpuppeteerxxx → ok, rank by position
          score = Math.min(score, 50 + pos);
        }
      }

      return { server: r, score };
    });

    // Sort by score (lower = better), then use_count (higher = better), then shorter name (simpler = better)
    scored.sort((a, b) =>
      a.score - b.score
      || (b.server.use_count || 0) - (a.server.use_count || 0)
      || (a.server.name || '').length - (b.server.name || '').length
    );

    return scored[0].server;
  }

  // 3. FTS5 fallback — best single match
  const sanitized = sanitizeFtsQuery(query);
  if (sanitized) {
    row = db
      .prepare(
        `SELECT s.* FROM servers_fts fts
         JOIN servers s ON s.rowid = fts.rowid
         WHERE servers_fts MATCH @q
         ORDER BY rank
         LIMIT 1`,
      )
      .get({ q: sanitized }) as McpServer | undefined;

    if (row) return row;
  }

  return undefined;
}

/**
 * Search for MCP servers using FTS5 full-text search.
 * Searches across name, description, and keywords with multi-factor ranking.
 */
export function searchServers(
  db: Database.Database,
  query: string,
  limit: number = 10,
  filters?: {
    transportType?: string;
    registryType?: string;
    registrySource?: string;
  },
): SearchResult[] {
  const sanitized = sanitizeFtsQuery(query);

  if (!sanitized) {
    return getRecentServers(db, limit, filters);
  }

  // Multi-factor ranking:
  // - FTS5 rank (negated because FTS5 returns negative scores where more negative = better)
  // - log(use_count + 1) for popularity
  // - number of sources for cross-registry presence
  // - recency based on updated_at
  let sql = `
    SELECT s.*,
           (rank * -1) as fts_relevance,
           (
             (rank * -1) * 0.4 +
             (CASE WHEN s.use_count > 0 THEN log(s.use_count + 1) ELSE 0 END) * 0.3 +
             (length(s.sources) - length(replace(s.sources, ',', '')) + 1) * 0.2 * 0.5 +
             (CASE WHEN s.updated_at IS NOT NULL
               THEN MAX(0, 1.0 - (julianday('now') - julianday(s.updated_at)) / 365.0)
               ELSE 0 END) * 0.1
           ) as combined_score
    FROM servers_fts fts
    JOIN servers s ON s.rowid = fts.rowid
    WHERE servers_fts MATCH @query
  `;

  const params: Record<string, unknown> = { query: sanitized, limit };

  if (filters?.transportType && filters.transportType !== 'any') {
    sql += ' AND s.transport_type = @transportType';
    params.transportType = filters.transportType;
  }

  if (filters?.registryType && filters.registryType !== 'any') {
    sql += ' AND s.registry_type = @registryType';
    params.registryType = filters.registryType;
  }

  if (filters?.registrySource && filters.registrySource !== 'any') {
    sql += ' AND s.sources LIKE @registrySource';
    params.registrySource = `%${filters.registrySource}%`;
  }

  sql += ' ORDER BY combined_score DESC LIMIT @limit';

  const rows = db.prepare(sql).all(params) as (McpServer & { fts_relevance: number; combined_score: number })[];

  return rows.map((row, idx) => formatSearchResult(row, idx));
}

/**
 * Get most recent servers (fallback for empty query).
 */
function getRecentServers(
  db: Database.Database,
  limit: number,
  filters?: { registrySource?: string },
): SearchResult[] {
  let sql = `SELECT * FROM servers WHERE status = 'active'`;
  const params: Record<string, unknown> = { limit };

  if (filters?.registrySource && filters.registrySource !== 'any') {
    sql += ' AND sources LIKE @registrySource';
    params.registrySource = `%${filters.registrySource}%`;
  }

  sql += ' ORDER BY use_count DESC, updated_at DESC NULLS LAST LIMIT @limit';

  const rows = db.prepare(sql).all(params) as McpServer[];

  return rows.map((row, idx) => formatSearchResult(row, idx));
}

/**
 * Format a database row into a SearchResult.
 */
function formatSearchResult(row: McpServer, idx: number): SearchResult {
  let sources: string[] = [];
  try {
    sources = JSON.parse(row.sources || '[]');
  } catch {
    sources = [];
  }

  return {
    name: row.name,
    description: row.description,
    version: row.version,
    registryType: row.registry_type,
    packageIdentifier: row.package_identifier,
    transportType: row.transport_type,
    repositoryUrl: row.repository_url,
    hasRemote: row.has_remote === 1,
    rank: idx + 1,
    sources,
    useCount: row.use_count || 0,
    verified: row.verified === 1,
    iconUrl: row.icon_url,
  };
}

/**
 * Get detailed information about a specific server by name or slug.
 */
export function getServerDetails(
  db: Database.Database,
  nameOrSlug: string,
): ServerDetail | null {
  const row = findServerByNameOrSlug(db, nameOrSlug);

  if (!row) return null;

  let envVars = [];
  try {
    envVars = JSON.parse(row.env_vars || '[]');
  } catch {
    envVars = [];
  }

  let categories: string[] = [];
  try {
    categories = JSON.parse(row.categories || '[]');
  } catch {
    categories = [];
  }

  let sources: string[] = [];
  try {
    sources = JSON.parse(row.sources || '[]');
  } catch {
    sources = [];
  }

  return {
    name: row.name,
    description: row.description,
    version: row.version,
    registryType: row.registry_type,
    packageIdentifier: row.package_identifier,
    transportType: row.transport_type,
    repositoryUrl: row.repository_url,
    repositorySource: row.repository_source,
    publishedAt: row.published_at,
    updatedAt: row.updated_at,
    status: row.status,
    hasRemote: row.has_remote === 1,
    remoteUrl: row.remote_url,
    categories,
    environmentVariables: envVars,
    sources,
    useCount: row.use_count || 0,
    verified: row.verified === 1,
    iconUrl: row.icon_url,
  };
}

/**
 * Sanitize a query string for FTS5.
 */
function sanitizeFtsQuery(query: string): string {
  const words = query
    .replace(/[^\w\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => `"${w}"`);

  if (words.length === 0) return '';
  return words.join(' ');
}
