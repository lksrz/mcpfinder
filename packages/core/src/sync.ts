/**
 * Sync engine for fetching servers from multiple MCP registries:
 * - Official MCP Registry
 * - Glama (glama.ai)
 * - Smithery (registry.smithery.ai)
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  RegistryListResponse,
  RegistryServerEntry,
  GlamaListResponse,
  GlamaServer,
  SmitheryListResponse,
  SmitheryServer,
} from './types.js';
import { getLastSyncTimestamp, updateSyncLog, transaction } from './db.js';
import type { SqlParam } from './db.js';
import { extractKeywords } from './categories.js';
import {
  assertBeforeDeadline,
  delay,
  fetchJsonPageWithRetry,
} from './registry-fetch.js';
import type { RegistryRuntime } from './registry-fetch.js';

const REGISTRY_BASE = 'https://registry.modelcontextprotocol.io';
const GLAMA_BASE = 'https://glama.ai/api/mcp/v1';
const SMITHERY_BASE = 'https://registry.smithery.ai';
const PAGE_LIMIT = 100;

/**
 * Wall-clock budget per registry. A degraded upstream that keeps responding
 * just slowly enough to dodge the per-request timeout still can't drag the
 * snapshot build into its 90-minute CI ceiling. Official overrun fails the
 * build (a snapshot missing Official servers is worse than no new snapshot);
 * Glama/Smithery overrun keeps the best-effort partial data for resilient
 * local use, but records a degraded sync_log status so snapshot publication
 * can reject it.
 */
const OFFICIAL_SYNC_BUDGET_MS = 8 * 60_000;
const DEFAULT_GLAMA_SYNC_BUDGET_MINUTES = 12;
const MAX_GLAMA_SYNC_BUDGET_MINUTES = 40;
const SMITHERY_SYNC_BUDGET_MS = 5 * 60_000;

/**
 * Keep local stdio behavior at the historical 12-minute limit while allowing
 * the snapshot job to reserve more of its 90-minute ceiling for Glama. Reject
 * invalid values instead of silently turning a typo into an unbounded sync.
 */
function getGlamaSyncBudgetMinutes(): number {
  const raw = process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
  if (raw === undefined || raw === '') return DEFAULT_GLAMA_SYNC_BUDGET_MINUTES;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      'MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES must be an integer between 1 and ' +
        MAX_GLAMA_SYNC_BUDGET_MINUTES,
    );
  }
  const minutes = Number(raw);
  if (minutes < 1 || minutes > MAX_GLAMA_SYNC_BUDGET_MINUTES) {
    throw new Error(
      'MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES must be an integer between 1 and ' +
        MAX_GLAMA_SYNC_BUDGET_MINUTES,
    );
  }
  return minutes;
}

function validateGlamaPage(data: unknown): asserts data is GlamaListResponse {
  if (!data || typeof data !== 'object') throw new Error('Glama API: response must be an object');
  const page = data as Partial<GlamaListResponse>;
  if (!Array.isArray(page.servers)) throw new Error('Glama API: servers must be an array');
  if (!page.pageInfo || typeof page.pageInfo !== 'object') {
    throw new Error('Glama API: pageInfo must be an object');
  }
  if (typeof page.pageInfo.hasNextPage !== 'boolean') {
    throw new Error('Glama API: pageInfo.hasNextPage must be boolean');
  }
  if (
    page.pageInfo.hasNextPage &&
    (typeof page.pageInfo.endCursor !== 'string' || page.pageInfo.endCursor.length === 0)
  ) {
    throw new Error('Glama API: pageInfo.endCursor is required when hasNextPage is true');
  }
}

function validateSmitheryPage(
  data: unknown,
  requestedPage: number,
): asserts data is SmitheryListResponse {
  if (!data || typeof data !== 'object') {
    throw new Error('Smithery API: response must be an object');
  }
  const result = data as Partial<SmitheryListResponse>;
  if (!Array.isArray(result.servers)) throw new Error('Smithery API: servers must be an array');
  const pagination = result.pagination;
  if (!pagination || typeof pagination !== 'object') {
    throw new Error('Smithery API: pagination must be an object');
  }
  for (const field of ['currentPage', 'pageSize', 'totalPages', 'totalCount'] as const) {
    if (!Number.isInteger(pagination[field]) || pagination[field] < 0) {
      throw new Error(`Smithery API: pagination.${field} must be a non-negative integer`);
    }
  }
  if (pagination.currentPage !== requestedPage) {
    throw new Error(
      `Smithery API: pagination.currentPage ${pagination.currentPage} does not match ${requestedPage}`,
    );
  }
  if (pagination.totalPages > 0 && pagination.currentPage > pagination.totalPages) {
    throw new Error('Smithery API: currentPage exceeds totalPages');
  }
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
 * Normalize a repository URL: lowercase, strip `.git` suffix, strip trailing slashes,
 * strip SCP-style `git@host:` prefix.
 * Returns null if the input is empty / not a usable URL.
 */
function normalizeRepoUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let u = url.trim().toLowerCase();
  if (!u) return null;
  // git@github.com:owner/repo[.git] -> https://github.com/owner/repo
  const scp = u.match(/^git@([^:]+):(.+)$/);
  if (scp) u = `https://${scp[1]}/${scp[2]}`;
  u = u.replace(/\.git$/, '').replace(/\/+$/, '');
  return u || null;
}

/**
 * Extract the canonical `owner/repo` tail from a known code-host URL.
 * Used as a cross-registry dedup key — matches GitHub, GitLab, Bitbucket.
 * Returns null if URL doesn't resemble a known code host.
 */
function extractRepoKey(url: string | null | undefined): string | null {
  const n = normalizeRepoUrl(url);
  if (!n) return null;
  const m = n.match(/\b(?:github|gitlab|bitbucket|codeberg)\.(?:com|org|io)\/([^/]+)\/([^/?#]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
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
    repository_url: normalizeRepoUrl(s.repository?.url),
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
export async function syncOfficialRegistry(
  db: DatabaseSync,
  runtime: RegistryRuntime = {},
): Promise<number> {
  const lastSync = getLastSyncTimestamp(db, 'official');

  let cursor: string | null = null;
  let totalUpserted = 0;
  const now = runtime.now ?? Date.now;
  const deadline = now() + OFFICIAL_SYNC_BUDGET_MS;

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
    if (now() >= deadline) {
      throw new Error(
        `Official registry sync exceeded its ${OFFICIAL_SYNC_BUDGET_MS / 60_000}-minute budget ` +
          `(upstream too slow) — aborting after ${totalUpserted} servers`,
      );
    }

    const url = new URL(`${REGISTRY_BASE}/v0.1/servers`);
    url.searchParams.set('version', 'latest');
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (lastSync) url.searchParams.set('updated_since', lastSync);
    if (cursor) url.searchParams.set('cursor', cursor);

    const { response: res, data, errorText } = await fetchJsonPageWithRetry<RegistryListResponse>(
      url.toString(),
      { label: 'Registry API', deadline, ...runtime },
    );
    if (!res.ok) {
      throw new Error(`Registry API error: ${res.status} ${res.statusText} — ${errorText ?? ''}`);
    }

    if (!data?.servers || data.servers.length === 0) break;

    const insertBatch = transaction(db, (entries: RegistryServerEntry[]) => {
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

    if (cursor) await delay(100, runtime);
  } while (cursor);

  assertBeforeDeadline(deadline, runtime, 'Registry API');
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
    repository_url: normalizeRepoUrl(entry.repository?.url),
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
export async function syncGlamaRegistry(
  db: DatabaseSync,
  runtime: RegistryRuntime = {},
): Promise<number> {
  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  let totalUpserted = 0;
  let degradation: string | null = null;
  let budgetMinutes = DEFAULT_GLAMA_SYNC_BUDGET_MINUTES;
  let deadline = Number.POSITIVE_INFINITY;
  const now = runtime.now ?? Date.now;

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
    budgetMinutes = getGlamaSyncBudgetMinutes();
    deadline = now() + budgetMinutes * 60_000;
    do {
      if (now() >= deadline) {
        degradation =
          `Glama sync exceeded its ${budgetMinutes}-minute budget ` +
          `after ${totalUpserted} servers`;
        process.stderr.write(
          `[mcpfinder] ${degradation} — keeping partial local data\n`,
        );
        break;
      }

      const url = new URL(`${GLAMA_BASE}/servers`);
      url.searchParams.set('first', String(PAGE_LIMIT));
      if (cursor) url.searchParams.set('after', cursor);

      const { response: res, data, errorText } = await fetchJsonPageWithRetry<GlamaListResponse>(
        url.toString(),
        { label: 'Glama API', deadline, ...runtime },
      );
      if (!res.ok) {
        throw new Error(`Glama API error: ${res.status} ${res.statusText} — ${errorText ?? ''}`);
      }

      validateGlamaPage(data);
      const nextCursor = data.pageInfo.hasNextPage ? data.pageInfo.endCursor! : null;
      if (nextCursor && seenCursors.has(nextCursor)) {
        throw new Error(`Glama API: repeated pageInfo.endCursor ${nextCursor}`);
      }
      if (nextCursor) seenCursors.add(nextCursor);

      if (data.servers.length > 0) {
        const insertBatch = transaction(db, (entries: GlamaServer[]) => {
          for (const entry of entries) {
            const row = normalizeGlamaEntry(entry);
            // Try to find existing server by repo URL for dedup
            const existingId = findExistingServer(
              db,
              row.repository_url,
              row.package_identifier,
              row.registry_type,
              row.slug,
              row.name,
            );
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
      }

      cursor = nextCursor;

      if (cursor) await delay(100, runtime);
    } while (cursor);

    if (!degradation) assertBeforeDeadline(deadline, runtime, 'Glama API');
    updateSyncLog(
      db,
      'glama',
      totalUpserted,
      degradation ? 'error' : 'ok',
      degradation ?? undefined,
    );
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

  // Smithery stores a "homepage" field that is sometimes a real code repo and
  // sometimes a product landing page — only lift it into repository_url when it
  // looks like a known code host, so dedup keys stay clean.
  const homepageIsRepo = extractRepoKey(entry.homepage) !== null;
  const repoUrl = homepageIsRepo ? normalizeRepoUrl(entry.homepage) : null;

  return {
    id: `smithery:${entry.qualifiedName}`,
    slug,
    name: entry.displayName || entry.qualifiedName,
    description: entry.description || '',
    version: '',
    registry_type: null,
    package_identifier: null,
    transport_type: null,
    repository_url: repoUrl,
    repository_source: homepageIsRepo ? 'github' : null,
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
export async function syncSmitheryRegistry(
  db: DatabaseSync,
  runtime: RegistryRuntime = {},
): Promise<number> {
  let page = 1;
  let totalUpserted = 0;
  let hasMore = true;
  let degradation: string | null = null;
  const now = runtime.now ?? Date.now;
  const deadline = now() + SMITHERY_SYNC_BUDGET_MS;

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
      if (now() >= deadline) {
        degradation =
          `Smithery sync exceeded its ${SMITHERY_SYNC_BUDGET_MS / 60_000}-minute budget ` +
          `after ${totalUpserted} servers`;
        process.stderr.write(
          `[mcpfinder] ${degradation} — keeping partial local data\n`,
        );
        break;
      }

      const url = new URL(`${SMITHERY_BASE}/servers`);
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', String(PAGE_LIMIT));

      const { response: res, data, errorText } = await fetchJsonPageWithRetry<SmitheryListResponse>(
        url.toString(),
        { label: 'Smithery API', deadline, ...runtime },
      );
      if (!res.ok) {
        throw new Error(`Smithery API error: ${res.status} ${res.statusText} — ${errorText ?? ''}`);
      }

      validateSmitheryPage(data, page);
      if (data.servers.length === 0) break;

      const insertBatch = transaction(db, (entries: SmitheryServer[]) => {
        for (const entry of entries) {
          const row = normalizeSmitheryEntry(entry);
          // Fix 2: prefer Official's ai.smithery/* mirror when it exists.
          // This single heuristic catches the largest slice of cross-registry
          // matches that Smithery's sparse repo URL can't surface.
          const existingId =
            findOfficialFromSmitheryQualifiedName(db, entry.qualifiedName) ??
            findExistingServer(
              db,
              row.repository_url,
              row.package_identifier,
              row.registry_type,
              row.slug,
              row.name,
            );
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

      if (hasMore) await delay(100, runtime);
    }

    if (!degradation) assertBeforeDeadline(deadline, runtime, 'Smithery API');
    updateSyncLog(
      db,
      'smithery',
      totalUpserted,
      degradation ? 'error' : 'ok',
      degradation ?? undefined,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    updateSyncLog(db, 'smithery', totalUpserted, 'error', msg);
    process.stderr.write(`[mcpfinder] Smithery sync error: ${msg}\n`);
  }

  return totalUpserted;
}

// ─── Deduplication Helpers ──────────────────────────────────────────────────

/**
 * Strip common MCP-ish prefixes/suffixes and non-alnum chars so that
 * `mcp-foo-server`, `foo-mcp`, `foo_server` and `Foo Server` all collapse
 * to the same token. Used to rescue monorepo matches when one side has no
 * package_identifier.
 */
function canonicalNameToken(s: string): string {
  if (!s) return '';
  let t = s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  for (;;) {
    const before = t;
    t = t.replace(/^(mcp|server)+/, '').replace(/(mcp|server)+$/, '');
    if (t === before) break;
  }
  return t;
}

/**
 * Find an existing server that should be considered "the same project" as the
 * candidate row. Tried keys, in decreasing reliability:
 *   1. Canonical repo key (`owner/repo` on github/gitlab/bitbucket/codeberg).
 *      When the repo hosts a monorepo (>1 existing row share it), we require a
 *      secondary signal — package_identifier, slug, or canonicalized name token —
 *      before merging. If the monorepo is ambiguous we skip, to avoid the bug
 *      where `waystation-ai/mcp` (12 distinct Official servers) would eat any
 *      incoming Glama/Smithery entry pointing at the same repo.
 *   2. `(package_identifier, registry_type)` — deterministic match when both
 *      sides ship the same package.
 *   3. Slug (only when unique) — weakest, but catches cases where neither URL
 *      nor package id exists.
 */
function findExistingServer(
  db: DatabaseSync,
  repoUrl: string | null,
  packageIdentifier: string | null,
  registryType: string | null,
  slug: string,
  name?: string | null,
): string | null {
  // 1) Repo URL match with monorepo disambiguation
  const repoKey = extractRepoKey(repoUrl);
  if (repoKey) {
    const tail = `/${repoKey}`;
    const candidates = db
      .prepare(
        `SELECT id, slug, name, package_identifier
         FROM servers
         WHERE LOWER(repository_url) LIKE ? OR LOWER(repository_url) LIKE ?`,
      )
      .all(`%${tail}`, `%${tail}.git`) as Array<{
      id: string;
      slug: string;
      name: string;
      package_identifier: string | null;
    }>;

    if (candidates.length === 1) return candidates[0].id;

    if (candidates.length > 1) {
      // Monorepo: need a secondary match inside the group
      if (packageIdentifier) {
        const hit = candidates.find(
          (c) =>
            c.package_identifier &&
            c.package_identifier.toLowerCase() === packageIdentifier.toLowerCase(),
        );
        if (hit) return hit.id;
      }
      if (slug) {
        const hit = candidates.find((c) => c.slug === slug);
        if (hit) return hit.id;
      }
      if (name) {
        const token = canonicalNameToken(name);
        if (token) {
          const hit = candidates.find((c) => {
            const ct = canonicalNameToken(c.name);
            return ct && (ct === token || ct.endsWith(token) || token.endsWith(ct));
          });
          if (hit) return hit.id;
        }
      }
      // Ambiguous — don't merge, safer to keep as a new row
      return null;
    }
  }

  // 2) Package identifier (+ registry type)
  if (packageIdentifier) {
    const row = db
      .prepare(
        `SELECT id FROM servers
         WHERE LOWER(package_identifier) = LOWER(?)
           AND (? IS NULL OR registry_type IS NULL OR registry_type = ?)
         LIMIT 1`,
      )
      .get(packageIdentifier, registryType, registryType) as { id: string } | undefined;
    if (row) return row.id;
  }

  // 3) Slug — require uniqueness within the DB to avoid tying unrelated servers
  if (slug) {
    const rows = db
      .prepare('SELECT id FROM servers WHERE slug = ? AND source != ? LIMIT 2')
      .all(slug, 'unknown') as Array<{ id: string }>;
    if (rows.length === 1) return rows[0].id;
  }

  return null;
}

/**
 * Smithery-specific heuristic: the Official registry re-publishes many Smithery
 * servers under `ai.smithery/<qualifiedName with / → ->`. If we see Smithery
 * `owner/name`, try that exact Official id first — it is by far the most common
 * cross-registry link and no other signal in Smithery carries it.
 */
function findOfficialFromSmitheryQualifiedName(
  db: DatabaseSync,
  qualifiedName: string | null | undefined,
): string | null {
  if (!qualifiedName) return null;
  const tail = qualifiedName.toLowerCase().replace(/\//g, '-').replace(/[^a-z0-9-]/g, '');
  if (!tail) return null;
  const row = db
    .prepare(
      `SELECT id FROM servers
       WHERE LOWER(name) = ? AND source = 'official'
       LIMIT 1`,
    )
    .get(`ai.smithery/${tail}`) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * Merge a source into a server's sources list.
 */
function mergeServerSources(db: DatabaseSync, serverId: string, newSource: string): void {
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
  db: DatabaseSync,
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

  // Prefer newer updated/published dates when available
  if (typeof newRow.updated_at === 'string' && (!existing.updated_at || String(newRow.updated_at) > String(existing.updated_at))) {
    updates.push('updated_at = ?');
    values.push(newRow.updated_at);
  }
  if (typeof newRow.published_at === 'string' && !existing.published_at) {
    updates.push('published_at = ?');
    values.push(newRow.published_at);
  }

  // Merge env vars arrays rather than keeping only one source.
  if (typeof newRow.env_vars === 'string') {
    const mergedEnvVars = mergeJsonArrayStrings(existing.env_vars, newRow.env_vars, 'name');
    if (mergedEnvVars) {
      updates.push('env_vars = ?');
      values.push(mergedEnvVars);
    }
  }

  // Preserve source-specific raw payloads so search/details can extract tools later.
  const mergedRawData = mergeRawData(existing.raw_data, newRow.raw_data, String(newRow.source || 'unknown'));
  if (mergedRawData) {
    updates.push('raw_data = ?');
    values.push(mergedRawData);
  }

  if (updates.length > 0) {
    values.push(existingId);
    db.prepare(`UPDATE servers SET ${updates.join(', ')} WHERE id = ?`).run(...(values as SqlParam[]));
  }
}

function mergeJsonArrayStrings(
  existingJson: unknown,
  incomingJson: unknown,
  key: string,
): string | null {
  try {
    const existing = Array.isArray(JSON.parse(String(existingJson || '[]')))
      ? JSON.parse(String(existingJson || '[]')) as Array<Record<string, unknown>>
      : [];
    const incoming = Array.isArray(JSON.parse(String(incomingJson || '[]')))
      ? JSON.parse(String(incomingJson || '[]')) as Array<Record<string, unknown>>
      : [];

    const merged = new Map<string, Record<string, unknown>>();
    for (const item of [...existing, ...incoming]) {
      const itemKey = typeof item?.[key] === 'string' ? String(item[key]) : JSON.stringify(item);
      const prev = merged.get(itemKey) || {};
      merged.set(itemKey, { ...prev, ...item });
    }
    return JSON.stringify([...merged.values()]);
  } catch {
    return null;
  }
}

function mergeRawData(existingRaw: unknown, incomingRaw: unknown, incomingSource: string): string | null {
  try {
    const existingParsed = existingRaw ? JSON.parse(String(existingRaw)) : null;
    const incomingParsed = incomingRaw ? JSON.parse(String(incomingRaw)) : null;
    const existingEnvelope: { primary: unknown; bySource: Record<string, unknown> } = isRawEnvelope(existingParsed)
      ? existingParsed
      : {
          primary: existingParsed,
          bySource: {} as Record<string, unknown>,
        };

    if (incomingParsed) {
      existingEnvelope.bySource[incomingSource] = incomingParsed;
      if (!existingEnvelope.primary) existingEnvelope.primary = incomingParsed;
    }

    return JSON.stringify(existingEnvelope);
  } catch {
    return null;
  }
}

function isRawEnvelope(value: unknown): value is { primary: unknown; bySource: Record<string, unknown> } {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'bySource' in value &&
      value.bySource &&
      typeof (value as { bySource: unknown }).bySource === 'object',
  );
}

// ─── Utility Functions ──────────────────────────────────────────────────────

/**
 * Check if sync is needed (no data or stale data).
 */
export function isSyncNeeded(db: DatabaseSync, maxAgeMinutes: number = 15): boolean {
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
export function getServerCount(db: DatabaseSync): number {
  const row = db.prepare('SELECT COUNT(*) as count FROM servers').get() as { count: number };
  return row.count;
}
