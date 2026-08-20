/**
 * Pre-built DB snapshot served from R2.
 *
 * A CI job (scripts/build-snapshot.mjs) produces:
 *   - snapshots/<sha>.sqlite.gz (immutable SQLite DB, gzipped)
 *   - manifest.json    (publishedAt, sha256, serverCount, sizeBytes, url)
 *
 * and uploads the immutable DB before the manifest pointer. Clients hit these
 * endpoints on first run to skip the ~11 min live sync.
 */
import type { AppContext } from '../types';
import {
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

export async function getSnapshotData(c: AppContext) {
  const bucket = r2(c);
  if (!bucket) return c.json({ error: 'snapshot-not-configured' }, 503);

  const requestedSha = c.req.query('sha');
  let object;
  try {
    object = snapshotDataKey(requestedSha);
  } catch (error) {
    return c.json({ error: 'invalid-snapshot-sha', message: (error as Error).message }, 400);
  }

  const ifNoneMatch = c.req.header('if-none-match');
  let obj = await bucket.get(object.key);
  if (!obj && object.immutable) {
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
    if (fallback.storageUnavailable) {
      return c.json({ error: 'snapshot-storage-unavailable' }, 503);
    }
    obj = fallback.object;
  }
  if (!obj) {
    return c.json(
      { error: 'snapshot-not-available' },
      404,
      { 'cache-control': `public, max-age=${MANIFEST_CACHE_SECONDS}` },
    );
  }

  if (ifNoneMatch && ifNoneMatch === obj.etag) {
    return new Response(null, { status: 304, headers: { etag: obj.etag } });
  }

  return new Response(obj.body, {
    status: 200,
    headers: {
      'content-type': 'application/octet-stream',
      'content-encoding': 'identity',
      'content-length': String(obj.size),
      'cache-control': object.immutable
        ? `public, max-age=${IMMUTABLE_GZ_CACHE_SECONDS}, immutable`
        : `public, max-age=${LEGACY_GZ_CACHE_SECONDS}`,
      etag: obj.etag,
      'x-snapshot-uploaded': obj.uploaded.toISOString(),
      ...(object.immutable ? { 'x-snapshot-sha': requestedSha! } : {}),
    },
  });
}
