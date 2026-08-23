import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  currentSnapshotFallbackKey,
  snapshotDataKey,
  snapshotManifestUrl,
} from '../shared/snapshot-artifacts.js';
import {
  createSnapshotProofCache,
  getVerifiedCurrentFallback,
  loadCurrentSnapshotSha,
  resolveVerifiedCurrentFallback,
} from '../shared/snapshot-proof-cache.js';
import { isMainModule, verifySnapshotUpload } from './verify-snapshot-upload.mjs';

const sha = 'a'.repeat(64);

const entrypointDir = await mkdtemp(join(tmpdir(), 'mcpfinder-preflight-main-'));
try {
  const scriptUrl = new URL('./verify-snapshot-upload.mjs', import.meta.url);
  const symlinkPath = join(entrypointDir, 'snapshot-preflight-link.mjs');
  await symlink(scriptUrl, symlinkPath);
  assert.equal(await isMainModule({ moduleUrl: scriptUrl.href, argv1: symlinkPath }), true);
  assert.equal(await isMainModule({ moduleUrl: scriptUrl.href, argv1: process.argv[1] }), false);
  assert.equal(
    await isMainModule({
      moduleUrl: scriptUrl.href,
      argv1: symlinkPath,
      realpathImpl: async () => {
        throw new Error('realpath unavailable');
      },
    }),
    false,
  );
  assert.equal(await realpath(symlinkPath), await realpath(new URL(scriptUrl)));
} finally {
  await rm(entrypointDir, { recursive: true, force: true });
}
assert.equal(snapshotManifestUrl(sha), `data.sqlite.gz?sha=${sha}`);
assert.deepEqual(snapshotDataKey(sha), {
  key: `snapshots/${sha}.sqlite.gz`,
  immutable: true,
});
assert.deepEqual(snapshotDataKey(undefined), { key: 'data.sqlite.gz', immutable: false });
for (const invalid of ['', 'A'.repeat(64), 'a'.repeat(63), '../manifest.json']) {
  assert.throws(() => snapshotDataKey(invalid), /64 lowercase hex/);
}
assert.equal(currentSnapshotFallbackKey(sha, { sha256: sha }, sha), 'data.sqlite.gz');
assert.equal(currentSnapshotFallbackKey(sha, { sha256: sha }, `${sha}\n`), 'data.sqlite.gz');
assert.equal(currentSnapshotFallbackKey(sha, { sha256: 'b'.repeat(64) }, sha), null);
assert.equal(currentSnapshotFallbackKey(sha, { sha256: sha }, 'b'.repeat(64)), null);
assert.equal(currentSnapshotFallbackKey(sha, { sha256: sha }, 'invalid'), null);
assert.equal(currentSnapshotFallbackKey(sha, { sha256: sha }, `${sha}\n\n`), null);
assert.equal(currentSnapshotFallbackKey(sha, { sha256: sha }, null), null);
assert.equal(currentSnapshotFallbackKey('invalid', { sha256: sha }, sha), null);
assert.equal(currentSnapshotFallbackKey(sha, { sha256: 'invalid' }, sha), null);
assert.equal(currentSnapshotFallbackKey(sha, null, sha), null);

function proofObject(text) {
  return { size: Buffer.byteLength(text), text: async () => text };
}
let proofNow = 0;
const proofGets = { manifest: 0, marker: 0, legacy: 0 };
const proofObjects = {
  'manifest.json': proofObject(JSON.stringify({ sha256: sha })),
  'data.sqlite.gz.sha256': proofObject(`${sha}\n`),
};
const loadProof = () =>
  loadCurrentSnapshotSha(async (key) => {
    if (key === 'manifest.json') proofGets.manifest++;
    else proofGets.marker++;
    return proofObjects[key];
  });
const getLegacy = async () => {
  proofGets.legacy++;
  return { key: 'data.sqlite.gz' };
};
const proofCache = createSnapshotProofCache({ ttlMs: 300_000, now: () => proofNow });
await Promise.all(
  Array.from({ length: 12 }, (_, index) =>
    getVerifiedCurrentFallback({
      requestedSha: index.toString(16).padStart(64, '0'),
      proofCache,
      loadProof,
      getLegacy,
    }),
  ),
);
assert.deepEqual(proofGets, { manifest: 1, marker: 1, legacy: 0 });
assert.equal(
  await getVerifiedCurrentFallback({
    requestedSha: 'b'.repeat(64),
    proofCache,
    loadProof,
    getLegacy,
  }),
  null,
);
assert.deepEqual(proofGets, { manifest: 1, marker: 1, legacy: 0 });
assert.deepEqual(
  await getVerifiedCurrentFallback({ requestedSha: sha, proofCache, loadProof, getLegacy }),
  { key: 'data.sqlite.gz' },
);
assert.deepEqual(proofGets, { manifest: 1, marker: 1, legacy: 1 });
proofNow = 300_000;
await getVerifiedCurrentFallback({
  requestedSha: 'c'.repeat(64),
  proofCache,
  loadProof,
  getLegacy,
});
assert.deepEqual(proofGets, { manifest: 2, marker: 2, legacy: 1 });

let malformedLoads = 0;
const malformedCache = createSnapshotProofCache({ ttlMs: 300_000, now: () => 0 });
const malformedProof = async () => {
  malformedLoads++;
  return loadCurrentSnapshotSha(async (key) =>
    key === 'manifest.json' ? proofObject('{broken json') : proofObject('not-a-sha'),
  );
};
await Promise.all(Array.from({ length: 8 }, () => malformedCache.get(malformedProof)));
assert.equal(await malformedCache.get(malformedProof), null);
assert.equal(malformedLoads, 1);

let rejectedLoads = 0;
const rejectingCache = createSnapshotProofCache({ ttlMs: 300_000, now: () => 0 });
const rejectingProof = async () => {
  rejectedLoads++;
  throw new Error('R2 unavailable');
};
assert.deepEqual(
  await resolveVerifiedCurrentFallback({
    requestedSha: sha,
    proofCache: rejectingCache,
    loadProof: rejectingProof,
    getLegacy,
  }),
  { object: null, storageUnavailable: true },
);
assert.deepEqual(
  await resolveVerifiedCurrentFallback({
    requestedSha: sha,
    proofCache: rejectingCache,
    loadProof: rejectingProof,
    getLegacy,
  }),
  { object: null, storageUnavailable: true },
);
assert.equal(rejectedLoads, 2, 'rejected proof loads must clear in-flight and never be cached');

const workflow = await readFile(new URL('../.github/workflows/snapshot.yml', import.meta.url), 'utf8');
const parsedWorkflow = parseYaml(workflow);
function parsedUploadCommand(stepName, fileName = 'data.sqlite.gz') {
  const step = parsedWorkflow.jobs.build.steps.find((candidate) => candidate.name === stepName);
  assert.equal(typeof step?.run, 'string');
  const lines = step.run.trim().split('\n');
  assert.ok(lines.length >= 5, `${stepName} should remain an explicit multiline shell block`);
  for (const line of lines.slice(0, -1)) {
    assert.match(line, /\\\s*$/, `bare upload argument line would execute separately: ${line}`);
  }
  const command = step.run.replace(/\\\s*\n\s*/g, ' ').trim();
  assert.doesNotMatch(command, /\n/);
  assert.match(command, /^npx --yes wrangler@4 r2 object put /);
  assert.ok(command.includes(` --file=dist/snapshot/${fileName} `));
  assert.match(command, / --remote$/);
  return command;
}
const immutableCommand = parsedUploadCommand('Upload immutable database to R2');
const durableCommand = parsedUploadCommand('Update durable current fallback in R2');
const markerCommand = parsedUploadCommand(
  'Publish durable current commit marker in R2',
  'data.sqlite.gz.sha256',
);
assert.match(immutableCommand, /snapshots\/\$\{\{ steps\.snapshot\.outputs\.sha \}\}\.sqlite\.gz/);
assert.match(durableCommand, /mcp-finder-db-snapshots\/data\.sqlite\.gz/);
assert.match(markerCommand, /mcp-finder-db-snapshots\/data\.sqlite\.gz\.sha256/);
const immutableUpload = workflow.indexOf('Upload immutable database to R2');
const preflight = workflow.indexOf('Verify immutable database through public endpoint');
const manifestUpload = workflow.indexOf('Publish manifest pointer to R2');
const durableFallback = workflow.indexOf('Update durable current fallback in R2');
const durableProof = workflow.indexOf('Publish durable current commit marker in R2');
assert.ok(
  immutableUpload >= 0 &&
    preflight > immutableUpload &&
    manifestUpload > preflight &&
    durableFallback > manifestUpload &&
    durableProof > durableFallback,
);
assert.match(workflow, /timeout-minutes: 150/);
assert.doesNotMatch(workflow, /run: pnpm test(?:\s|$)/);
assert.doesNotMatch(workflow, /check:types/);

const body = Buffer.from('immutable snapshot bytes');
const bodySha = createHash('sha256').update(body).digest('hex');
const manifest = {
  sha256: bodySha,
  sizeBytes: body.length,
  url: snapshotManifestUrl(bodySha),
};
const verified = await verifySnapshotUpload({
  manifest,
  baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
  fetchImpl: async (url, init) => {
    assert.match(url, new RegExp(`sha=${bodySha}$`));
    assert.equal(init.cache, 'no-store');
    const requestHeaders = new Headers(init.headers);
    assert.equal(requestHeaders.get('cache-control'), 'no-cache');
    assert.equal(requestHeaders.get('pragma'), 'no-cache');
    return new Response(body, { headers: { 'x-snapshot-sha': bodySha } });
  },
});
assert.equal(verified.sha256, bodySha);
assert.equal(verified.bytes, body.length);

await assert.rejects(
  () =>
    verifySnapshotUpload({
      manifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      fetchImpl: async () => new Response(body),
    }),
  /did not acknowledge requested sha/,
);
await assert.rejects(
  () =>
    verifySnapshotUpload({
      manifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      fetchImpl: async () =>
        new Response('wrong object', { headers: { 'x-snapshot-sha': bodySha } }),
    }),
  /sha256 mismatch/,
);

const immediateSleep = async () => {};
let transientCalls = 0;
assert.equal(
  (
    await verifySnapshotUpload({
      manifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      sleep: immediateSleep,
      fetchImpl: async () => {
        transientCalls++;
        return transientCalls === 1
          ? new Response('not ready', { status: 503 })
          : new Response(body, { headers: { 'x-snapshot-sha': bodySha } });
      },
    })
  ).sha256,
  bodySha,
);
assert.equal(transientCalls, 2);

let networkCalls = 0;
await verifySnapshotUpload({
  manifest,
  baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
  sleep: immediateSleep,
  fetchImpl: async () => {
    networkCalls++;
    if (networkCalls === 1) throw new Error('temporary network failure');
    return new Response(body, { headers: { 'x-snapshot-sha': bodySha } });
  },
});
assert.equal(networkCalls, 2);

let persistentCalls = 0;
const retrySleeps = [];
await assert.rejects(
  () =>
    verifySnapshotUpload({
      manifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      sleep: async (ms) => retrySleeps.push(ms),
      fetchImpl: async () => {
        persistentCalls++;
        return new Response('not ready', { status: 503 });
      },
    }),
  /failed after 4 attempts/,
);
assert.equal(persistentCalls, 4);
assert.deepEqual(retrySleeps, [500, 1_500, 4_500]);

let mismatchCalls = 0;
await assert.rejects(
  () =>
    verifySnapshotUpload({
      manifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      sleep: immediateSleep,
      fetchImpl: async () => {
        mismatchCalls++;
        return new Response(body, { headers: { 'x-snapshot-sha': 'b'.repeat(64) } });
      },
    }),
  /did not acknowledge requested sha/,
);
assert.equal(mismatchCalls, 1);

let stalledBodyAborted = false;
await assert.rejects(
  () =>
    verifySnapshotUpload({
      manifest,
      baseUrl: 'https://mcpfinder.dev/api/v1/snapshot',
      retries: 0,
      timeoutMs: 15,
      fetchImpl: async (_url, init) =>
        new Response(
          new ReadableStream({
            start(controller) {
              init.signal.addEventListener(
                'abort',
                () => {
                  stalledBodyAborted = true;
                  controller.error(init.signal.reason ?? new Error('aborted'));
                },
                { once: true },
              );
            },
          }),
          { headers: { 'x-snapshot-sha': bodySha } },
        ),
    }),
  /failed after 1 attempts/,
);
assert.equal(stalledBodyAborted, true);

const lifecycle = JSON.parse(
  await readFile(new URL('../api-worker/r2-lifecycle.json', import.meta.url), 'utf8'),
);
assert.equal(lifecycle.rules.length, 2);
const expiry = lifecycle.rules.find((rule) => rule.deleteObjectsTransition);
assert.equal(expiry.conditions.prefix, 'snapshots/');
assert.equal(expiry.deleteObjectsTransition.condition.type, 'Age');
assert.equal(expiry.deleteObjectsTransition.condition.maxAge, 30 * 24 * 60 * 60);
assert.equal('data.sqlite.gz.sha256'.startsWith(expiry.conditions.prefix), false);
const multipart = lifecycle.rules.find((rule) => rule.abortMultipartUploadsTransition);
assert.deepEqual(multipart.conditions, {});
assert.equal(multipart.abortMultipartUploadsTransition.condition.maxAge, 7 * 24 * 60 * 60);

const workerPackage = JSON.parse(
  await readFile(new URL('../api-worker/package.json', import.meta.url), 'utf8'),
);
assert.match(workerPackage.scripts['r2:lifecycle:apply'], /r2 bucket lifecycle set/);
assert.match(workerPackage.scripts['r2:lifecycle:apply'], /--force/);
assert.match(workerPackage.scripts['cf-typegen'], /--include-env=true/);
assert.match(workerPackage.scripts['check:types'], /--include-env=true/);
assert.match(workerPackage.scripts['cf-typegen'], /--env-file \.typegen\.env/);
const generatedWorkerTypes = await readFile(
  new URL('../api-worker/worker-configuration.d.ts', import.meta.url),
  'utf8',
);
const workerAppTypes = await readFile(new URL('../api-worker/src/types.ts', import.meta.url), 'utf8');
assert.match(generatedWorkerTypes, /MCP_DB_SNAPSHOTS:\s*R2Bucket/);
assert.doesNotMatch(generatedWorkerTypes, /MCP_REGISTRY_SECRET/);
assert.match(workerAppTypes, /Bindings = Cloudflare\.Env/);
const snapshotEndpoint = await readFile(
  new URL('../api-worker/src/endpoints/snapshot.ts', import.meta.url),
  'utf8',
);
assert.match(snapshotEndpoint, /404,[\s\S]*cache-control.*MANIFEST_CACHE_SECONDS/);
assert.match(snapshotEndpoint, /snapshot-storage-unavailable'[\s\S]*503/);

console.log('snapshot artifact checks passed');
