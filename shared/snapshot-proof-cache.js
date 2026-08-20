import { validateSnapshotSha } from './snapshot-artifacts.js';

/** Small isolate-local TTL cache that coalesces concurrent proof loads. */
export function createSnapshotProofCache({ ttlMs = 300_000, now = Date.now } = {}) {
  let cached;
  let inFlight;
  return {
    async get(load) {
      const timestamp = now();
      if (cached && timestamp < cached.expiresAt) return cached.value;
      if (inFlight) return inFlight;
      inFlight = Promise.resolve()
        .then(load)
        .then((value) => {
          cached = { value, expiresAt: now() + ttlMs };
          return value;
        })
        .finally(() => {
          inFlight = undefined;
        });
      return inFlight;
    },
    reset() {
      cached = undefined;
      inFlight = undefined;
    },
  };
}

/** Return the single SHA jointly proven by the current manifest and marker. */
export function verifiedCurrentSnapshotSha(manifest, marker) {
  try {
    if (!manifest || typeof manifest !== 'object' || typeof marker !== 'string') return null;
    const manifestSha = validateSnapshotSha(manifest.sha256);
    const markerSha = validateSnapshotSha(marker.endsWith('\n') ? marker.slice(0, -1) : marker);
    return manifestSha === markerSha ? manifestSha : null;
  } catch {
    return null;
  }
}

/** Read a bounded manifest/marker pair; malformed or missing proof is negative. */
export async function loadCurrentSnapshotSha(
  getObject,
  {
    manifestKey = 'manifest.json',
    markerKey = 'data.sqlite.gz.sha256',
    maxManifestBytes = 64 * 1024,
    maxMarkerBytes = 128,
  } = {},
) {
  const [manifestObject, markerObject] = await Promise.all([
    getObject(manifestKey),
    getObject(markerKey),
  ]);
  if (
    !manifestObject ||
    manifestObject.size > maxManifestBytes ||
    !markerObject ||
    markerObject.size > maxMarkerBytes
  ) {
    return null;
  }
  try {
    return verifiedCurrentSnapshotSha(
      JSON.parse(await manifestObject.text()),
      await markerObject.text(),
    );
  } catch {
    return null;
  }
}

/** Fetch the durable object only when cached current proof matches the request. */
export async function getVerifiedCurrentFallback({ requestedSha, proofCache, loadProof, getLegacy }) {
  const currentSha = await proofCache.get(loadProof);
  return currentSha === requestedSha ? getLegacy() : null;
}

/** Classify storage rejection separately from a verified negative/mismatch. */
export async function resolveVerifiedCurrentFallback(options) {
  try {
    return { object: await getVerifiedCurrentFallback(options), storageUnavailable: false };
  } catch {
    return { object: null, storageUnavailable: true };
  }
}
