#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { snapshotManifestUrl, validateSnapshotSha } from '../shared/snapshot-artifacts.js';

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

export async function verifySnapshotUpload({
  manifest,
  baseUrl,
  fetchImpl = fetch,
  retries = RETRY_DELAYS_MS.length,
  timeoutMs = ATTEMPT_TIMEOUT_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const sha = validateSnapshotSha(manifest?.sha256);
  const expectedUrl = snapshotManifestUrl(sha);
  if (manifest.url !== expectedUrl) {
    throw new Error(`manifest url must be ${expectedUrl}, got ${manifest.url}`);
  }
  if (!Number.isSafeInteger(manifest.sizeBytes) || manifest.sizeBytes <= 0) {
    throw new Error(`manifest sizeBytes must be a positive safe integer, got ${manifest.sizeBytes}`);
  }

  const url = new URL(manifest.url, `${baseUrl.replace(/\/+$/, '')}/`).toString();
  const attempts = Math.min(Math.max(0, retries), RETRY_DELAYS_MS.length) + 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
    try {
      return await verifyAttempt({
        url,
        sha,
        manifest,
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

async function main() {
  const manifestPath = process.argv[2] ?? 'dist/snapshot/manifest.json';
  const baseUrl =
    process.env.MCPFINDER_SNAPSHOT_BASE_URL ?? 'https://mcpfinder.dev/api/v1/snapshot';
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const result = await verifySnapshotUpload({ manifest, baseUrl });
  console.log(`[snapshot-preflight] verified ${result.sha256} (${result.bytes} bytes)`);
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
