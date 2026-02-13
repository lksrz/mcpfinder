/**
 * Sync engine for fetching servers from the Official MCP Registry.
 * Supports cursor-based pagination and incremental sync via updated_since.
 */
import type Database from 'better-sqlite3';
import type { RegistryListResponse, RegistryServerEntry } from './types.js';
import { getLastSyncTimestamp, updateSyncLog } from './db.js';
import { extractKeywords } from './categories.js';

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';
const PAGE_LIMIT = 100;

/**
 * Normalize a registry entry into our database row format.
 */
function normalizeEntry(entry: RegistryServerEntry) {
  const s = entry.server;
  const metaKey = Object.keys(entry._meta || {}).find((k) =>
    k.includes('modelcontextprotocol'),
  );
  const meta = metaKey ? entry._meta![metaKey] : undefined;
  const pkg = s.packages?.[0];
  const remote = s.remotes?.[0];

  // Generate a stable unique slug from full server name (namespace-aware)
  // Example: "io.modelcontextprotocol/filesystem" -> "io-modelcontextprotocol-filesystem"
  const slug = s.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  // Extract keywords from name and description for search
  const keywords = extractKeywords(s.name, s.description || '');

  // Extract env vars from first package
  const envVars = pkg?.environmentVariables || [];

  return {
    id: s.name,
    slug,
    name: s.name,
    description: s.description || '',
    version: s.version,
    registry_type: pkg?.registryType || null,
    package_identifier: pkg?.identifier || null,
    transport_type: pkg?.transport?.type || null,
    repository_url: s.repository?.url || null,
    repository_source: s.repository?.source || null,
    published_at: meta?.publishedAt || null,
    updated_at: meta?.updatedAt || null,
    status: meta?.status || 'active',
    popularity_score: 0,
    categories: JSON.stringify([]),
    keywords: JSON.stringify(keywords),
    remote_url: remote?.url || null,
    has_remote: remote ? 1 : 0,
    last_synced_at: new Date().toISOString(),
    sources: JSON.stringify(['official']),
    raw_data: JSON.stringify(entry),
    env_vars: JSON.stringify(envVars),
  };
}

/**
 * Sync servers from the Official MCP Registry.
 * On first run, fetches all servers. On subsequent runs, only fetches updates.
 * Returns the number of servers upserted.
 */
export async function syncOfficialRegistry(db: Database.Database): Promise<number> {
  const lastSync = getLastSyncTimestamp(db, 'official');

  let cursor: string | null = null;
  let totalUpserted = 0;

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO servers (
      id, slug, name, description, version, registry_type, package_identifier,
      transport_type, repository_url, repository_source, published_at, updated_at,
      status, popularity_score, categories, keywords, remote_url, has_remote,
      last_synced_at, sources, raw_data, env_vars
    ) VALUES (
      @id, @slug, @name, @description, @version, @registry_type, @package_identifier,
      @transport_type, @repository_url, @repository_source, @published_at, @updated_at,
      @status, @popularity_score, @categories, @keywords, @remote_url, @has_remote,
      @last_synced_at, @sources, @raw_data, @env_vars
    )
  `);

  do {
    const url = new URL(`${REGISTRY_BASE}/v0.1/servers`);
    url.searchParams.set('version', 'latest');
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (lastSync) url.searchParams.set('updated_since', lastSync);
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString());
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Registry API error: ${res.status} ${res.statusText} — ${errText}`);
    }

    const data = (await res.json()) as RegistryListResponse;

    if (!data.servers || data.servers.length === 0) break;

    // Use a transaction for batch insert
    const insertBatch = db.transaction((entries: RegistryServerEntry[]) => {
      for (const entry of entries) {
        const row = normalizeEntry(entry);
        upsert.run(row);
      }
    });

    insertBatch(data.servers);
    totalUpserted += data.servers.length;

    cursor = data.metadata?.nextCursor ?? null;
  } while (cursor);

  updateSyncLog(db, 'official', totalUpserted);

  return totalUpserted;
}

/**
 * Check if sync is needed (no data or stale data).
 */
export function isSyncNeeded(db: Database.Database, maxAgeMinutes: number = 15): boolean {
  const lastSync = getLastSyncTimestamp(db, 'official');
  if (!lastSync) return true;

  const lastSyncDate = new Date(lastSync);
  const now = new Date();
  const diffMinutes = (now.getTime() - lastSyncDate.getTime()) / (1000 * 60);

  return diffMinutes >= maxAgeMinutes;
}

/**
 * Get total server count in the database.
 */
export function getServerCount(db: Database.Database): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM servers').get() as { count: number };
  return row.count;
}
