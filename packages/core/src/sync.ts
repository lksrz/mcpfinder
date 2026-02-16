/**
 * Sync engine for fetching servers from multiple MCP registries:
 * - Official MCP Registry
 * - Glama (glama.ai)
 * - Smithery (registry.smithery.ai)
 */
import type Database from 'better-sqlite3';
import type {
  RegistryListResponse,
  RegistryServerEntry,
  GlamaListResponse,
  GlamaServer,
  SmitheryListResponse,
  SmitheryServer,
} from './types.js';
import { getLastSyncTimestamp, updateSyncLog } from './db.js';
import { extractKeywords } from './categories.js';

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';
const GLAMA_BASE = 'https://glama.ai/api/mcp/v1';
const SMITHERY_BASE = 'https://registry.smithery.ai';
const PAGE_LIMIT = 100;

/** Delay helper for rate limiting */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Generate a slug from a server name.
 */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Merge sources arrays. Returns sorted, deduplicated list.
 */
function mergeSources(existing: string[], newSource: string): string[] {
  const set = new Set(existing);
  set.add(newSource);
  return [...set].sort();
}

// ─── Official Registry Sync ─────────────────────────────────────────────────

/**
 * Normalize a registry entry into our database row format.
 */
function normalizeOfficialEntry(entry: RegistryServerEntry) {
  const s = entry.server;
  const metaKey = Object.keys(entry._meta || {}).find((k) =>
    k.includes('modelcontextprotocol'),
  );
  const meta = metaKey ? entry._meta![metaKey] : undefined;
  const pkg = s.packages?.[0];
  const remote = s.remotes?.[0];

  const slug = slugify(s.name);
  const keywords = extractKeywords(s.name, s.description || '');
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
    source: 'official',
    use_count: 0,
    verified: 0,
    icon_url: null,
  };
}

/**
 * Sync servers from the Official MCP Registry.
 */
export async function syncOfficialRegistry(db: Database.Database): Promise<number> {
  const lastSync = getLastSyncTimestamp(db, 'official');

  let cursor: string | null = null;
  let totalUpserted = 0;

  const upsert = db.prepare(`
    INSERT INTO servers (
      id, slug, name, description, version, registry_type, package_identifier,
      transport_type, repository_url, repository_source, published_at, updated_at,
      status, popularity_score, categories, keywords, remote_url, has_remote,
      last_synced_at, sources, raw_data, env_vars, source, use_count, verified, icon_url
    ) VALUES (
      @id, @slug, @name, @description, @version, @registry_type, @package_identifier,
      @transport_type, @repository_url, @repository_source, @published_at, @updated_at,
      @status, @popularity_score, @categories, @keywords, @remote_url, @has_remote,
      @last_synced_at, @sources, @raw_data, @env_vars, @source, @use_count, @verified, @icon_url
    )
    ON CONFLICT(id) DO UPDATE SET
      description = CASE WHEN length(excluded.description) > length(servers.description) THEN excluded.description ELSE servers.description END,
      version = excluded.version,
      registry_type = COALESCE(excluded.registry_type, servers.registry_type),
      package_identifier = COALESCE(excluded.package_identifier, servers.package_identifier),
      transport_type = COALESCE(excluded.transport_type, servers.transport_type),
      repository_url = COALESCE(excluded.repository_url, servers.repository_url),
      repository_source = COALESCE(excluded.repository_source, servers.repository_source),
      published_at = COALESCE(excluded.published_at, servers.published_at),
      updated_at = COALESCE(excluded.updated_at, servers.updated_at),
      status = excluded.status,
      keywords = excluded.keywords,
      remote_url = COALESCE(excluded.remote_url, servers.remote_url),
      has_remote = MAX(excluded.has_remote, servers.has_remote),
      last_synced_at = excluded.last_synced_at,
      raw_data = excluded.raw_data,
      env_vars = CASE WHEN length(excluded.env_vars) > length(servers.env_vars) THEN excluded.env_vars ELSE servers.env_vars END
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

    const insertBatch = db.transaction((entries: RegistryServerEntry[]) => {
      for (const entry of entries) {
        const row = normalizeOfficialEntry(entry);
        upsert.run(row);
        // Merge sources
        mergeServerSources(db, row.id, 'official');
      }
    });

    insertBatch(data.servers);
    totalUpserted += data.servers.length;

    cursor = data.metadata?.nextCursor ?? null;

    if (cursor) await delay(100);
  } while (cursor);

  updateSyncLog(db, 'official', totalUpserted);

  return totalUpserted;
}

// ─── Glama Registry Sync ────────────────────────────────────────────────────

/**
 * Normalize a Glama server entry into our database row format.
 */
function normalizeGlamaEntry(entry: GlamaServer) {
  const name = entry.namespace ? `${entry.namespace}/${entry.name}` : entry.name;
  const slug = slugify(entry.slug || name);
  const keywords = extractKeywords(name, entry.description || '');

  // Extract env vars from JSON schema if present
  let envVars: Array<{ name: string; description?: string }> = [];
  if (entry.environmentVariablesJsonSchema && typeof entry.environmentVariablesJsonSchema === 'object') {
    const schema = entry.environmentVariablesJsonSchema as Record<string, unknown>;
    const props = (schema.properties || {}) as Record<string, { description?: string }>;
    envVars = Object.keys(props).map((key) => ({
      name: key,
      description: props[key]?.description,
    }));
  }

  return {
    id: `glama:${entry.id}`,
    slug,
    name,
    description: entry.description || '',
    version: '',
    registry_type: null,
    package_identifier: null,
    transport_type: null,
    repository_url: entry.repository?.url || null,
    repository_source: entry.repository?.url ? 'github' : null,
    published_at: null,
    updated_at: null,
    status: 'active',
    popularity_score: 0,
    categories: JSON.stringify([]),
    keywords: JSON.stringify(keywords),
    remote_url: entry.url || null,
    has_remote: entry.url ? 1 : 0,
    last_synced_at: new Date().toISOString(),
    sources: JSON.stringify(['glama']),
    raw_data: JSON.stringify(entry),
    env_vars: JSON.stringify(envVars),
    source: 'glama',
    use_count: 0,
    verified: 0,
    icon_url: null,
  };
}

/**
 * Sync servers from Glama registry.
 */
export async function syncGlamaRegistry(db: Database.Database): Promise<number> {
  let cursor: string | null = null;
  let totalUpserted = 0;

  const upsert = db.prepare(`
    INSERT INTO servers (
      id, slug, name, description, version, registry_type, package_identifier,
      transport_type, repository_url, repository_source, published_at, updated_at,
      status, popularity_score, categories, keywords, remote_url, has_remote,
      last_synced_at, sources, raw_data, env_vars, source, use_count, verified, icon_url
    ) VALUES (
      @id, @slug, @name, @description, @version, @registry_type, @package_identifier,
      @transport_type, @repository_url, @repository_source, @published_at, @updated_at,
      @status, @popularity_score, @categories, @keywords, @remote_url, @has_remote,
      @last_synced_at, @sources, @raw_data, @env_vars, @source, @use_count, @verified, @icon_url
    )
    ON CONFLICT(id) DO UPDATE SET
      description = CASE WHEN length(excluded.description) > length(servers.description) THEN excluded.description ELSE servers.description END,
      repository_url = COALESCE(excluded.repository_url, servers.repository_url),
      remote_url = COALESCE(excluded.remote_url, servers.remote_url),
      has_remote = MAX(excluded.has_remote, servers.has_remote),
      last_synced_at = excluded.last_synced_at,
      keywords = excluded.keywords,
      env_vars = CASE WHEN length(excluded.env_vars) > length(servers.env_vars) THEN excluded.env_vars ELSE servers.env_vars END
  `);

  try {
    do {
      const url = new URL(`${GLAMA_BASE}/servers`);
      url.searchParams.set('first', String(PAGE_LIMIT));
      if (cursor) url.searchParams.set('after', cursor);

      const res = await fetch(url.toString());
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Glama API error: ${res.status} ${res.statusText} — ${errText}`);
      }

      const data = (await res.json()) as GlamaListResponse;

      if (!data.servers || data.servers.length === 0) break;

      const insertBatch = db.transaction((entries: GlamaServer[]) => {
        for (const entry of entries) {
          const row = normalizeGlamaEntry(entry);
          // Try to find existing server by repo URL for dedup
          const existingId = findExistingServer(db, row.repository_url, row.name, row.slug);
          if (existingId) {
            mergeServerSources(db, existingId, 'glama');
            // Also update with richer data from Glama if applicable
            mergeServerData(db, existingId, row);
          } else {
            upsert.run(row);
            mergeServerSources(db, row.id, 'glama');
          }
        }
      });

      insertBatch(data.servers);
      totalUpserted += data.servers.length;

      cursor = data.pageInfo?.hasNextPage ? (data.pageInfo.endCursor ?? null) : null;

      if (cursor) await delay(100);
    } while (cursor);

    updateSyncLog(db, 'glama', totalUpserted);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateSyncLog(db, 'glama', totalUpserted, 'error', msg);
    process.stderr.write(`[mcpfinder] Glama sync error: ${msg}\n`);
  }

  return totalUpserted;
}

// ─── Smithery Registry Sync ─────────────────────────────────────────────────

/**
 * Normalize a Smithery server entry into our database row format.
 */
function normalizeSmitheryEntry(entry: SmitheryServer) {
  const slug = slugify(entry.qualifiedName);
  const keywords = extractKeywords(entry.displayName || entry.qualifiedName, entry.description || '');

  return {
    id: `smithery:${entry.qualifiedName}`,
    slug,
    name: entry.displayName || entry.qualifiedName,
    description: entry.description || '',
    version: '',
    registry_type: null,
    package_identifier: null,
    transport_type: null,
    repository_url: entry.homepage || null,
    repository_source: entry.homepage?.includes('github.com') ? 'github' : null,
    published_at: entry.createdAt || null,
    updated_at: entry.createdAt || null,
    status: 'active',
    popularity_score: 0,
    categories: JSON.stringify([]),
    keywords: JSON.stringify(keywords),
    remote_url: entry.remote && entry.isDeployed ? `https://registry.smithery.ai/servers/${entry.qualifiedName}` : null,
    has_remote: entry.remote && entry.isDeployed ? 1 : 0,
    last_synced_at: new Date().toISOString(),
    sources: JSON.stringify(['smithery']),
    raw_data: JSON.stringify(entry),
    env_vars: JSON.stringify([]),
    source: 'smithery',
    use_count: entry.useCount || 0,
    verified: entry.verified ? 1 : 0,
    icon_url: entry.iconUrl || null,
  };
}

/**
 * Sync servers from Smithery registry.
 */
export async function syncSmitheryRegistry(db: Database.Database): Promise<number> {
  let page = 1;
  let totalUpserted = 0;
  let hasMore = true;

  const upsert = db.prepare(`
    INSERT INTO servers (
      id, slug, name, description, version, registry_type, package_identifier,
      transport_type, repository_url, repository_source, published_at, updated_at,
      status, popularity_score, categories, keywords, remote_url, has_remote,
      last_synced_at, sources, raw_data, env_vars, source, use_count, verified, icon_url
    ) VALUES (
      @id, @slug, @name, @description, @version, @registry_type, @package_identifier,
      @transport_type, @repository_url, @repository_source, @published_at, @updated_at,
      @status, @popularity_score, @categories, @keywords, @remote_url, @has_remote,
      @last_synced_at, @sources, @raw_data, @env_vars, @source, @use_count, @verified, @icon_url
    )
    ON CONFLICT(id) DO UPDATE SET
      description = CASE WHEN length(excluded.description) > length(servers.description) THEN excluded.description ELSE servers.description END,
      repository_url = COALESCE(excluded.repository_url, servers.repository_url),
      remote_url = COALESCE(excluded.remote_url, servers.remote_url),
      has_remote = MAX(excluded.has_remote, servers.has_remote),
      last_synced_at = excluded.last_synced_at,
      keywords = excluded.keywords,
      use_count = MAX(excluded.use_count, servers.use_count),
      verified = MAX(excluded.verified, servers.verified),
      icon_url = COALESCE(excluded.icon_url, servers.icon_url)
  `);

  try {
    while (hasMore) {
      const url = new URL(`${SMITHERY_BASE}/servers`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', String(PAGE_LIMIT));

      const res = await fetch(url.toString());
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Smithery API error: ${res.status} ${res.statusText} — ${errText}`);
      }

      const data = (await res.json()) as SmitheryListResponse;

      if (!data.servers || data.servers.length === 0) break;

      const insertBatch = db.transaction((entries: SmitheryServer[]) => {
        for (const entry of entries) {
          const row = normalizeSmitheryEntry(entry);
          // Try to find existing server by repo URL or name for dedup
          const existingId = findExistingServer(db, row.repository_url, row.name, row.slug);
          if (existingId) {
            mergeServerSources(db, existingId, 'smithery');
            mergeServerData(db, existingId, row);
            // Always update use_count, verified, icon_url from Smithery
            db.prepare(`
              UPDATE servers SET
                use_count = MAX(use_count, ?),
                verified = MAX(verified, ?),
                icon_url = COALESCE(icon_url, ?)
              WHERE id = ?
            `).run(row.use_count, row.verified, row.icon_url, existingId);
          } else {
            upsert.run(row);
            mergeServerSources(db, row.id, 'smithery');
          }
        }
      });

      insertBatch(data.servers);
      totalUpserted += data.servers.length;

      hasMore = page < (data.pagination?.totalPages ?? 0);
      page++;

      if (hasMore) await delay(100);
    }

    updateSyncLog(db, 'smithery', totalUpserted);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateSyncLog(db, 'smithery', totalUpserted, 'error', msg);
    process.stderr.write(`[mcpfinder] Smithery sync error: ${msg}\n`);
  }

  return totalUpserted;
}

// ─── Deduplication Helpers ──────────────────────────────────────────────────

/**
 * Find an existing server by repository URL, name, or slug.
 * Returns the server ID if found, null otherwise.
 */
function findExistingServer(
  db: Database.Database,
  repoUrl: string | null,
  name: string,
  slug: string,
): string | null {
  // Match by repo URL (most reliable)
  if (repoUrl) {
    const normalizedUrl = repoUrl.replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
    const row = db
      .prepare(
        `SELECT id FROM servers WHERE LOWER(REPLACE(REPLACE(repository_url, '.git', ''), '/', '')) LIKE ? LIMIT 1`,
      )
      .get(`%${normalizedUrl.split('/').slice(-2).join('/')}%`) as { id: string } | undefined;
    if (row) return row.id;
  }

  // Match by slug
  const bySlug = db
    .prepare('SELECT id FROM servers WHERE slug = ? AND source != ? LIMIT 1')
    .get(slug, 'unknown') as { id: string } | undefined;
  if (bySlug) return bySlug.id;

  return null;
}

/**
 * Merge a source into a server's sources list.
 */
function mergeServerSources(db: Database.Database, serverId: string, newSource: string): void {
  const row = db.prepare('SELECT sources FROM servers WHERE id = ?').get(serverId) as
    | { sources: string }
    | undefined;
  if (!row) return;

  let existing: string[];
  try {
    existing = JSON.parse(row.sources || '[]');
  } catch {
    existing = [];
  }

  const merged = mergeSources(existing, newSource);
  db.prepare('UPDATE servers SET sources = ? WHERE id = ?').run(JSON.stringify(merged), serverId);
}

/**
 * Merge richer data from a new source into an existing server.
 * Only updates fields that are currently empty/null with non-empty values.
 */
function mergeServerData(
  db: Database.Database,
  existingId: string,
  newRow: Record<string, unknown>,
): void {
  const existing = db.prepare('SELECT * FROM servers WHERE id = ?').get(existingId) as Record<string, unknown> | undefined;
  if (!existing) return;

  const updates: string[] = [];
  const values: unknown[] = [];

  // Merge description (prefer longer)
  if (
    typeof newRow.description === 'string' &&
    newRow.description.length > ((existing.description as string) || '').length
  ) {
    updates.push('description = ?');
    values.push(newRow.description);
  }

  // Merge nullable text fields
  const textFields = ['repository_url', 'remote_url', 'icon_url', 'transport_type', 'registry_type', 'package_identifier'];
  for (const f of textFields) {
    if (newRow[f] && !existing[f]) {
      updates.push(`${f} = ?`);
      values.push(newRow[f]);
    }
  }

  if (updates.length > 0) {
    values.push(existingId);
    db.prepare(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }
}

// ─── Utility Functions ──────────────────────────────────────────────────────

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
