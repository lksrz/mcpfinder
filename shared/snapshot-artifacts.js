const SHA256 = /^[a-f0-9]{64}$/;

export function validateSnapshotSha(sha) {
  if (!SHA256.test(sha)) throw new Error('sha must be 64 lowercase hex characters');
  return sha;
}

/** Manifest URL routed through the public snapshot data endpoint. */
export function snapshotManifestUrl(sha) {
  return `data.sqlite.gz?sha=${validateSnapshotSha(sha)}`;
}

/**
 * Manifest URL of the brotli artifact, routed through its own data endpoint.
 *
 * The sha is the digest of the *brotli* file, not the snapshot identity: the
 * two artifacts are separate objects and each is content-addressed by its own
 * bytes, so a client verifies exactly what it downloaded.
 */
export function snapshotBrotliManifestUrl(sha) {
  return `data.sqlite.br?sha=${validateSnapshotSha(sha)}`;
}

/**
 * Resolve directly to an immutable R2 object. Absence of sha preserves
 * compatibility with manifests published before content-addressing.
 */
export function snapshotDataKey(sha) {
  if (sha === undefined || sha === null) {
    return { key: 'data.sqlite.gz', immutable: false };
  }
  return { key: `snapshots/${validateSnapshotSha(sha)}.sqlite.gz`, immutable: true };
}

/**
 * Brotli artifacts live only under the immutable, content-addressed prefix.
 *
 * There is deliberately no mutable `data.sqlite.br` twin: the durable gz key
 * exists to rescue clients whose manifest sha has aged out of the 30-day
 * immutable window, and a brotli client already has that escape hatch — any
 * brotli failure, 404 included, falls back to the gz artifact.
 */
export function snapshotBrotliDataKey(sha) {
  if (sha === undefined || sha === null) {
    throw new Error('brotli snapshot requires a sha');
  }
  return { key: `snapshots/${validateSnapshotSha(sha)}.sqlite.br`, immutable: true };
}

/**
 * Permit the durable current object only when the current manifest proves it
 * contains the exact requested content. Invalid/mismatched manifests fail safe.
 */
export function currentSnapshotFallbackKey(requestedSha, manifest, marker) {
  try {
    const requested = validateSnapshotSha(requestedSha);
    if (!manifest || typeof manifest !== 'object') return null;
    if (validateSnapshotSha(manifest.sha256) !== requested) return null;
    if (typeof marker !== 'string') return null;
    const proof = marker.endsWith('\n') ? marker.slice(0, -1) : marker;
    if (validateSnapshotSha(proof) !== requested) return null;
    return 'data.sqlite.gz';
  } catch {
    return null;
  }
}
