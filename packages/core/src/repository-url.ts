const KNOWN_HOSTS = new Map([
  ['github.com', 'github'],
  ['www.github.com', 'github'],
  ['gitlab.com', 'gitlab'],
  ['www.gitlab.com', 'gitlab'],
  ['bitbucket.org', 'bitbucket'],
  ['www.bitbucket.org', 'bitbucket'],
  ['codeberg.org', 'codeberg'],
  ['www.codeberg.org', 'codeberg'],
]);

const BARE_KNOWN_HOST =
  /^(?:\/\/)?(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)(\/.*)?$/;
const SCHEME_WWW_KNOWN_HOST =
  /^(https?:\/\/)www\.(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)(?=\/|$)/;

/** Normalize repository URLs consistently for storage and deduplication. */
export function normalizeRepositoryUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  let value = url.trim().toLowerCase();
  if (!value) return null;
  const scp = value.match(/^git@([^:]+):(.+)$/);
  if (scp) value = `https://${scp[1]}/${scp[2]}`;
  const bareKnownHost = value.match(BARE_KNOWN_HOST);
  if (bareKnownHost) value = `https://${bareKnownHost[1]}${bareKnownHost[2] || ''}`;
  value = value.replace(SCHEME_WWW_KNOWN_HOST, '$1$2');
  value = value.replace(/\/+$/, '').replace(/\.git$/, '');
  return value || null;
}

/** Derive repository provenance only for hosts whose identity is unambiguous. */
export function repositorySource(url: string | null | undefined): string | null {
  const normalized = normalizeRepositoryUrl(url);
  if (!normalized) return null;
  try {
    return KNOWN_HOSTS.get(new URL(normalized).hostname) ?? null;
  } catch {
    return null;
  }
}

/** Canonical incoming owner/repo key for supported code hosts. */
export function extractRepoKey(url: string | null | undefined): string | null {
  const normalized = normalizeRepositoryUrl(url);
  if (!normalized || !repositorySource(normalized)) return null;
  try {
    const parts = new URL(normalized).pathname.split('/').filter(Boolean);
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  } catch {
    return null;
  }
}

/** Reproduce the old SQL suffix match for rows already stored in SQLite. */
export function storedRepoKey(url: string | null): string | null {
  if (!url) return null;
  const value = url.toLowerCase().replace(/\.git$/, '');
  const match = value.match(/\/([^/]+)\/([^/]+)$/);
  return match ? `${match[1]}/${match[2]}` : null;
}
