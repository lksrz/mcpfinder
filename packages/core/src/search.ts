/**
 * Search engine using SQLite FTS5 for MCP server discovery.
 */
import type Database from 'better-sqlite3';
import type { McpServer, SearchResult, ServerDetail } from './types.js';

/**
 * Search for MCP servers using FTS5 full-text search.
 * Searches across name, description, and keywords.
 */
export function searchServers(
  db: Database.Database,
  query: string,
  limit: number = 10,
  filters?: {
    transportType?: string;
    registryType?: string;
  },
): SearchResult[] {
  const sanitized = sanitizeFtsQuery(query);

  if (!sanitized) {
    return getRecentServers(db, limit);
  }

  let sql = `
    SELECT s.*,
           rank * -1 as relevance
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

  sql += ' ORDER BY relevance DESC LIMIT @limit';

  const rows = db.prepare(sql).all(params) as (McpServer & { relevance: number })[];

  return rows.map((row, idx) => ({
    name: row.name,
    description: row.description,
    version: row.version,
    registryType: row.registry_type,
    packageIdentifier: row.package_identifier,
    transportType: row.transport_type,
    repositoryUrl: row.repository_url,
    hasRemote: row.has_remote === 1,
    rank: idx + 1,
  }));
}

/**
 * Get most recent servers (fallback for empty query).
 */
function getRecentServers(db: Database.Database, limit: number): SearchResult[] {
  const rows = db
    .prepare(
      `SELECT * FROM servers
       WHERE status = 'active'
       ORDER BY updated_at DESC NULLS LAST
       LIMIT ?`,
    )
    .all(limit) as McpServer[];

  return rows.map((row, idx) => ({
    name: row.name,
    description: row.description,
    version: row.version,
    registryType: row.registry_type,
    packageIdentifier: row.package_identifier,
    transportType: row.transport_type,
    repositoryUrl: row.repository_url,
    hasRemote: row.has_remote === 1,
    rank: idx + 1,
  }));
}

/**
 * Get detailed information about a specific server by name or slug.
 */
export function getServerDetails(
  db: Database.Database,
  nameOrSlug: string,
): ServerDetail | null {
  const row = db
    .prepare('SELECT * FROM servers WHERE id = ? OR slug = ? LIMIT 1')
    .get(nameOrSlug, nameOrSlug) as McpServer | undefined;

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
