#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { appendFile, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  snapshotBrotliManifestUrl,
  snapshotManifestUrl,
  validateSnapshotSha,
} from '../shared/snapshot-artifacts.js';

const RETRY_DELAYS_MS = [500, 1_500, 4_500];
const ATTEMPT_TIMEOUT_MS = 30_000;

class RetryablePreflightError extends Error {}

function isRetryableStatus(status) {
  return status === 404 || status === 429 || status >= 500;
}

async function verifyAttempt({ url, sha, manifest, fetchImpl, timeoutMs, setTimer, clearTimer }) {
  const controller = new AbortController();
  const timer = setTimer(() => controller.abort(), timeoutMs);
  let response;
  try {
    try {
      response = await fetchImpl(url, {
        cache: 'no-store',
        headers: { 'cache-control': 'no-cache', pragma: 'no-cache' },
        signal: controller.signal,
      });
    } catch (error) {
      throw new RetryablePreflightError(
        `snapshot preflight transport failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (!response.ok || !response.body) {
      const error = new Error(`snapshot preflight failed: HTTP ${response.status}`);
      if (isRetryableStatus(response.status)) throw new RetryablePreflightError(error.message);
      throw error;
    }
    if (response.headers.get('x-snapshot-sha') !== sha) {
      throw new Error('snapshot preflight failed: public Worker did not acknowledge requested sha');
    }

    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        hash.update(chunk);
        bytes += chunk.byteLength;
      }
    } catch (error) {
      throw new RetryablePreflightError(
        `snapshot preflight body failed: ${error instanceof Error ? error.message : error}`,
      );
    }
    const actual = hash.digest('hex');
    if (actual !== sha) {
      throw new Error(`snapshot preflight sha256 mismatch: expected ${sha}, got ${actual}`);
    }
    if (Number.isFinite(manifest.sizeBytes) && bytes !== manifest.sizeBytes) {
      throw new Error(
        `snapshot preflight size mismatch: expected ${manifest.sizeBytes}, got ${bytes}`,
      );
    }
    return { sha256: actual, bytes, url };
  } finally {
    clearTimer(timer);
  }
}

/**
 * Verify one published artifact end to end through the public Worker.
 *
 * `artifact` selects which one: the gz object (the snapshot identity) or the
 * optional brotli object, which carries its own digest, size and URL. Each is
 * checked against its *own* digest — never the other's.
 */
export async function verifySnapshotUpload({
  manifest,
  baseUrl,
  artifact = 'gzip',
  fetchImpl = fetch,
  retries = RETRY_DELAYS_MS.length,
  timeoutMs = ATTEMPT_TIMEOUT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const ref = artifact === 'brotli' ? manifest?.brotli : manifest;
  if (artifact === 'brotli' && (!ref || typeof ref !== 'object')) {
    throw new Error('manifest has no brotli artifact to verify');
  }
  const sha = validateSnapshotSha(ref?.sha256);
  const expectedUrl =
    artifact === 'brotli' ? snapshotBrotliManifestUrl(sha) : snapshotManifestUrl(sha);
  if (ref.url !== expectedUrl) {
    throw new Error(`manifest url must be ${expectedUrl}, got ${ref.url}`);
  }
  if (!Number.isSafeInteger(ref.sizeBytes) || ref.sizeBytes <= 0) {
    throw new Error(`manifest sizeBytes must be a positive safe integer, got ${ref.sizeBytes}`);
  }
  if (artifact === 'brotli' && sha === validateSnapshotSha(manifest.sha256)) {
    throw new Error('brotli digest must differ from the gz digest');
  }

  const url = new URL(ref.url, `${baseUrl.replace(/\/+$/, '')}/`).toString();
  const attempts = Math.min(Math.max(0, retries), RETRY_DELAYS_MS.length) + 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      return await verifyAttempt({
        url,
        sha,
        manifest: ref,
        fetchImpl,
        timeoutMs,
        setTimer,
        clearTimer,
      });
    } catch (error) {
      if (!(error instanceof RetryablePreflightError)) throw error;
      lastError = error;
    }
  }
  throw new Error(
    `snapshot preflight failed after ${attempts} attempts: ${lastError?.message ?? 'unknown error'}`,
  );
}

/**
 * Say — loudly, and where a human actually looks — that this build published
 * without the brotli artifact. A silent degradation is exactly how a bandwidth
 * optimisation stays broken for weeks without anyone noticing.
 */
async function warnBrotliUnavailable(message) {
  console.warn(
    '::warning::[snapshot-preflight] brotli artifact unavailable, publishing gzip only: ' +
      message,
  );
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  await appendFile(
    summary,
    `\n> [!WARNING]\n> Snapshot published **without the brotli artifact**: ${message}\n\n`,
  ).catch(() => {});
}

/**
 * Verify the brotli artifact if the manifest announces one — best-effort.
 *
 * By the time this runs the gz object is already durable in R2 and is fit to
 * publish, so a brotli-side failure may not abort the build. Instead the
 * `brotli` block is dropped from the manifest on disk before the pointer is
 * published: the manifest may only ever announce an artifact that has been
 * verified through the public endpoint, and a client that sees no block simply
 * downloads gzip, exactly as it did before brotli existed.
 *
 * This is also what makes the deploy order of the Worker a non-event: without
 * the /snapshot/data.sqlite.br route the verification 404s, the block is
 * dropped, and publication carries on.
 */
export async function verifyOptionalBrotli({
  manifestPath,
  manifest,
  baseUrl,
  warn = warnBrotliUnavailable,
  writeManifest = (path, text) => writeFile(path, text),
  ...deps
}) {
  if (!manifest.brotli) return { verified: false, announced: false };
  try {
    const brotli = await verifySnapshotUpload({ manifest, baseUrl, artifact: 'brotli', ...deps });
    console.log(`[snapshot-preflight] verified brotli ${brotli.sha256} (${brotli.bytes} bytes)`);
    return { verified: true, announced: true };
  } catch (error) {
    const reason = error?.message ?? String(error);
    // Rest-spread keeps the remaining keys in their published order.
    const { brotli: _dropped, ...withoutBrotli } = manifest;
    await writeManifest(manifestPath, JSON.stringify(withoutBrotli, null, 2));
    await warn(reason);
    return { verified: false, announced: true, reason };
  }
}

async function main() {
  const manifestPath = process.argv[2] ?? 'dist/snapshot/manifest.json';
  const baseUrl =
    process.env.MCPFINDER_SNAPSHOT_BASE_URL ?? 'https://mcpfinder.dev/api/v1/snapshot';
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  // The gz artifact is the snapshot: a failure here is still fatal, and stops
  // the manifest pointer from advancing.
  const result = await verifySnapshotUpload({ manifest, baseUrl });
  console.log(`[snapshot-preflight] verified gzip ${result.sha256} (${result.bytes} bytes)`);
  // Manifests built before brotli support have nothing extra to verify.
  await verifyOptionalBrotli({ manifestPath, manifest, baseUrl });
}

/** Symlink-safe ESM entrypoint detection; resolution failures fail closed. */
export async function isMainModule({
  moduleUrl = import.meta.url,
  argv1 = process.argv[1],
  realpathImpl = realpath,
} = {}) {
  if (!argv1) return false;
  try {
    const [modulePath, invokedPath] = await Promise.all([
      realpathImpl(fileURLToPath(moduleUrl)),
      realpathImpl(resolve(argv1)),
    ]);
    return pathToFileURL(modulePath).href === pathToFileURL(invokedPath).href;
  } catch {
    return false;
  }
}

if (await isMainModule()) {
  await main();
}
