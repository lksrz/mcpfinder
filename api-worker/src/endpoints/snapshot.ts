/**
 * Pre-built DB snapshot served from R2.
 *
 * A CI job (scripts/build-snapshot.mjs) produces:
 *   - snapshots/<sha>.sqlite.gz (immutable SQLite DB, gzipped)
 *   - snapshots/<brSha>.sqlite.br (the same DB, brotli — ~21% smaller)
 *   - manifest.json    (publishedAt, sha256, serverCount, sizeBytes, url, brotli)
 *
 * and uploads both immutable objects before the manifest pointer. Clients hit
 * these endpoints on first run to skip the ~11 min live sync.
 *
 * The brotli object is served only from its content-addressed key: it has no
 * durable mutable twin, because a client that cannot get it falls back to the
 * gz artifact, which does.
 */
import type { AppContext } from '../types';
import {
  snapshotBrotliDataKey,
  snapshotDataKey,
} from '../../../shared/snapshot-artifacts.js';
import {
  createSnapshotProofCache,
  loadCurrentSnapshotSha,
  resolveVerifiedCurrentFallback,
} from '../../../shared/snapshot-proof-cache.js';

const MANIFEST_KEY = 'manifest.json';
const CURRENT_PROOF_KEY = 'data.sqlite.gz.sha256';

// Cache manifest briefly; the gz file is content-addressed via sha256 so
// clients can verify. The manifest drives freshness, so keep it short.
const MANIFEST_CACHE_SECONDS = 300; // 5 min
const LEGACY_GZ_CACHE_SECONDS = 3600;
const IMMUTABLE_GZ_CACHE_SECONDS = 31_536_000;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_PROOF_BYTES = 128;
const currentProofCache = createSnapshotProofCache({
  ttlMs: MANIFEST_CACHE_SECONDS * 1_000,
});

function r2(c: AppContext): R2Bucket | null {
  // Generated types require the binding, while this guard keeps a misconfigured
  // runtime deployment controlled instead of throwing before returning 503.
  return (c.env as Partial<Cloudflare.Env> | undefined)?.MCP_DB_SNAPSHOTS ?? null;
}

export async function getSnapshotManifest(c: AppContext) {
  const bucket = r2(c);
  if (!bucket) return c.json({ error: 'snapshot-not-configured' }, 503);

  const obj = await bucket.get(MANIFEST_KEY);
  if (!obj) return c.json({ error: 'snapshot-not-available' }, 404);

  const body = await obj.text();
  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': `public, max-age=${MANIFEST_CACHE_SECONDS}`,
      etag: obj.etag,
    },
  });
}

/**
 * Everything the two data endpoints share: the storage guard, `sha` validation,
 * the miss response, conditional revalidation and the response headers. Only
 * the key resolution, the miss handling and the cache lifetime differ, so they
 * are the parameters — a 304 or header fix has one place to land.
 */
async function serveSnapshotObject(
  c: AppContext,
  {
    resolveKey,
    onMiss,
    cacheControl,
    // The legacy mutable key is not content-addressed, so it must not claim a
    // content address it was not asked for.
    announcesSha = (object) => object.immutable,
  }: {
    resolveKey: (sha: string | undefined) => { key: string; immutable: boolean };
    onMiss?: (args: {
      bucket: R2Bucket;
      requestedSha: string | undefined;
      object: { key: string; immutable: boolean };
    }) => Promise<{ object?: R2ObjectBody | null; storageUnavailable?: boolean }>;
    cacheControl: (object: { key: string; immutable: boolean }) => string;
    announcesSha?: (object: { key: string; immutable: boolean }) => boolean;
  },
) {
  const bucket = r2(c);
  if (!bucket) return c.json({ error: 'snapshot-not-configured' }, 503);

  const requestedSha = c.req.query('sha');
  let object;
  try {
    object = resolveKey(requestedSha);
  } catch (error) {
    return c.json({ error: 'invalid-snapshot-sha', message: (error as Error).message }, 400);
  }

  let obj = await bucket.get(object.key);
  if (!obj && onMiss) {
    const fallback = await onMiss({ bucket, requestedSha, object });
    if (fallback.storageUnavailable) {
      return c.json({ error: 'snapshot-storage-unavailable' }, 503);
    }
    obj = fallback.object ?? null;
  }
  if (!obj) {
    return c.json(
      { error: 'snapshot-not-available' },
      404,
      { 'cache-control': `public, max-age=${MANIFEST_CACHE_SECONDS}` },
    );
  }

  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch && ifNoneMatch === obj.etag) {
    return new Response(null, { status: 304, headers: { etag: obj.etag } });
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      // The body is a compressed *file*, not a compressed response: declaring
      // an encoding would invite an intermediary to decode it and break the
      // client's digest check.
      'content-encoding': 'identity',
      'content-length': String(obj.size),
      'cache-control': cacheControl(object),
      etag: obj.etag,
      'x-snapshot-uploaded': obj.uploaded.toISOString(),
      ...(announcesSha(object) ? { 'x-snapshot-sha': requestedSha! } : {}),
    },
  });
}

/**
 * Brotli artifact: immutable, content-addressed, no legacy fallback path.
 * `sha` is mandatory and is the digest of the brotli bytes themselves.
 */
export async function getSnapshotBrotliData(c: AppContext) {
  return serveSnapshotObject(c, {
    resolveKey: snapshotBrotliDataKey,
    cacheControl: () => `public, max-age=${IMMUTABLE_GZ_CACHE_SECONDS}, immutable`,
  });
}

export async function getSnapshotData(c: AppContext) {
  return serveSnapshotObject(c, {
    resolveKey: snapshotDataKey,
    onMiss: async ({ bucket, requestedSha, object }) => {
      if (!object.immutable) return {};
      // Immutable history expires after 30 days. The durable legacy key may
      // serve only the exact current SHA proven by the small current manifest;
      // mismatched/cached historical requests remain a 404.
      const fallback = await resolveVerifiedCurrentFallback({
        requestedSha,
        proofCache: currentProofCache,
        loadProof: () =>
          loadCurrentSnapshotSha((key) => bucket.get(key), {
            manifestKey: MANIFEST_KEY,
            markerKey: CURRENT_PROOF_KEY,
            maxManifestBytes: MAX_MANIFEST_BYTES,
            maxMarkerBytes: MAX_PROOF_BYTES,
          }),
        getLegacy: () => bucket.get('data.sqlite.gz'),
      });
      return { object: fallback.object, storageUnavailable: fallback.storageUnavailable };
    },
    cacheControl: (object) =>
      object.immutable
        ? `public, max-age=${IMMUTABLE_GZ_CACHE_SECONDS}, immutable`
        : `public, max-age=${LEGACY_GZ_CACHE_SECONDS}`,
  });
}
