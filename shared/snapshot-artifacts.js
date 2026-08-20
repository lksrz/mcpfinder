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
