import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  baselineManifestErrors,
  evaluateCurrentSnapshotQuality,
  evaluateSnapshotQuality,
  fetchPreviousManifest,
} from './snapshot-quality.mjs';

const dir = mkdtempSync(join(tmpdir(), 'mcpf-snapshot-quality-'));
const originalGlamaBudget = process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
const glamaEmpty = { servers: [], pageInfo: { hasNextPage: false, endCursor: null } };
const smitheryEmpty = {
  servers: [],
  pagination: { currentPage: 1, pageSize: 100, totalPages: 1, totalCount: 0 },
};

function runtime(fetchImpl, now = () => 0) {
  return { fetchImpl, now, sleep: async () => {} };
}

function syncLog(db, source) {
  return db
    .prepare('SELECT source, server_count, status, error FROM sync_log WHERE source = ?')
    .get(source);
}

function healthyManifest(overrides = {}) {
  return {
    serverCount: 100,
    counts: { official: 60, glama: 40, smithery: 20 },
    ...overrides,
  };
}

try {
  const { initDatabase, syncGlamaRegistry, syncSmitheryRegistry } = await import(
    '../packages/core/dist/index.js'
  );
  const { fetchJsonPageWithRetry, fetchWithRetry, RegistryTransportError } = await import(
    '../packages/core/dist/registry-fetch.js'
  );

  // Exhausted transport retries are terminal and must not be multiplied by
  // the outer same-page malformed/body retry loop.
  let persistentNetworkCalls = 0;
  await assert.rejects(
    () =>
      fetchJsonPageWithRetry('https://example.invalid/network', {
        label: 'persistent network test',
        sleep: async () => {},
        fetchImpl: async () => {
          persistentNetworkCalls++;
          throw new Error('network unavailable');
        },
      }),
    (error) =>
      error instanceof RegistryTransportError &&
      /giving up after 4 attempts.*network unavailable/.test(error.message),
  );
  assert.equal(persistentNetworkCalls, 4);

  // Glama retries a malformed page before any insert and can recover healthy.
  const recoveredDb = initDatabase(join(dir, 'glama-recovered.sqlite'));
  let recoveredCalls = 0;
  const recoveredRuntime = runtime(async () => {
    recoveredCalls++;
    return recoveredCalls === 1
      ? new Response('{broken json', { status: 200 })
      : Response.json(glamaEmpty);
  });
  assert.equal(await syncGlamaRegistry(recoveredDb, recoveredRuntime), 0);
  assert.equal(recoveredCalls, 2);
  assert.equal(syncLog(recoveredDb, 'glama').status, 'ok');
  recoveredDb.close();

  // Persistent malformed JSON exhausts the same-page retries and degrades.
  const malformedDb = initDatabase(join(dir, 'glama-malformed.sqlite'));
  let malformedCalls = 0;
  const malformedRuntime = runtime(async () => {
    malformedCalls++;
    return new Response('{broken json', { status: 200 });
  });
  assert.equal(await syncGlamaRegistry(malformedDb, malformedRuntime), 0);
  assert.equal(malformedCalls, 4);
  assert.equal(syncLog(malformedDb, 'glama').status, 'error');
  assert.match(syncLog(malformedDb, 'glama').error, /invalid JSON/i);
  malformedDb.close();

  // Structurally incomplete Glama pages must never look healthy.
  for (const [name, payload, message] of [
    ['missing-servers', { pageInfo: { hasNextPage: false } }, /servers must be an array/],
    [
      'missing-cursor',
      { servers: [], pageInfo: { hasNextPage: true, endCursor: null } },
      /endCursor is required/,
    ],
    ['missing-page-info', { servers: [] }, /pageInfo must be an object/],
  ]) {
    const db = initDatabase(join(dir, `glama-${name}.sqlite`));
    await syncGlamaRegistry(db, runtime(async () => Response.json(payload)));
    assert.equal(syncLog(db, 'glama').status, 'error');
    assert.match(syncLog(db, 'glama').error, message);
    db.close();
  }

  // Empty pages may legally continue only when their cursor makes progress.
  const emptyContinuationDb = initDatabase(join(dir, 'glama-empty-continuation.sqlite'));
  let emptyContinuationCalls = 0;
  await syncGlamaRegistry(
    emptyContinuationDb,
    runtime(async () => {
      emptyContinuationCalls++;
      return Response.json(
        emptyContinuationCalls === 1
          ? { servers: [], pageInfo: { hasNextPage: true, endCursor: 'next' } }
          : glamaEmpty,
      );
    }),
  );
  assert.equal(emptyContinuationCalls, 2);
  assert.equal(syncLog(emptyContinuationDb, 'glama').status, 'ok');
  emptyContinuationDb.close();

  const repeatedCursorDb = initDatabase(join(dir, 'glama-repeated-cursor.sqlite'));
  let repeatedCursorCalls = 0;
  await syncGlamaRegistry(
    repeatedCursorDb,
    runtime(async () => {
      repeatedCursorCalls++;
      return Response.json({
        servers: [],
        pageInfo: { hasNextPage: true, endCursor: 'repeated' },
      });
    }),
  );
  assert.equal(repeatedCursorCalls, 2);
  assert.equal(syncLog(repeatedCursorDb, 'glama').status, 'error');
  assert.match(syncLog(repeatedCursorDb, 'glama').error, /repeated pageInfo\.endCursor/);
  repeatedCursorDb.close();

  // Smithery has the same malformed-page recovery and persistent failure.
  const smitheryRecoveredDb = initDatabase(join(dir, 'smithery-recovered.sqlite'));
  let smitheryRecoveredCalls = 0;
  await syncSmitheryRegistry(
    smitheryRecoveredDb,
    runtime(async () => {
      smitheryRecoveredCalls++;
      return smitheryRecoveredCalls === 1
        ? new Response('{broken json', { status: 200 })
        : Response.json(smitheryEmpty);
    }),
  );
  assert.equal(smitheryRecoveredCalls, 2);
  assert.equal(syncLog(smitheryRecoveredDb, 'smithery').status, 'ok');
  smitheryRecoveredDb.close();

  const smitheryMalformedDb = initDatabase(join(dir, 'smithery-malformed.sqlite'));
  let smitheryMalformedCalls = 0;
  await syncSmitheryRegistry(
    smitheryMalformedDb,
    runtime(async () => {
      smitheryMalformedCalls++;
      return new Response('{broken json', { status: 200 });
    }),
  );
  assert.equal(smitheryMalformedCalls, 4);
  assert.equal(syncLog(smitheryMalformedDb, 'smithery').status, 'error');
  smitheryMalformedDb.close();

  const smitheryStructureDb = initDatabase(join(dir, 'smithery-structure.sqlite'));
  await syncSmitheryRegistry(
    smitheryStructureDb,
    runtime(async () => Response.json({ servers: [], pagination: { currentPage: 1 } })),
  );
  assert.equal(syncLog(smitheryStructureDb, 'smithery').status, 'error');
  assert.match(syncLog(smitheryStructureDb, 'smithery').error, /pagination\.pageSize/);
  smitheryStructureDb.close();

  // Valid and invalid Glama budget configuration both leave auditable state.
  process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES = '90';
  const overrideDb = initDatabase(join(dir, 'override.sqlite'));
  let overrideCalls = 0;
  const overrideTimes = [0, 20 * 60_000];
  await syncGlamaRegistry(
    overrideDb,
    runtime(async () => {
      overrideCalls++;
      return Response.json(glamaEmpty);
    }, () => overrideTimes[Math.min(overrideCalls, overrideTimes.length - 1)]),
  );
  assert.equal(overrideCalls, 1);
  assert.equal(syncLog(overrideDb, 'glama').status, 'ok');
  overrideDb.close();

  process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES = '0';
  const invalidBudgetDb = initDatabase(join(dir, 'invalid-budget.sqlite'));
  assert.equal(await syncGlamaRegistry(invalidBudgetDb, runtime(async () => Response.json(glamaEmpty))), 0);
  assert.equal(syncLog(invalidBudgetDb, 'glama').status, 'error');
  assert.match(syncLog(invalidBudgetDb, 'glama').error, /integer between 1 and 120/);
  invalidBudgetDb.close();
  if (originalGlamaBudget === undefined) delete process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
  else process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES = originalGlamaBudget;

  // Registry deadline is checked after fetch and JSON parse, including a
  // terminal page that would otherwise be marked healthy.
  let deadlineNow = 0;
  await assert.rejects(
    () =>
      fetchJsonPageWithRetry('https://example.invalid/page', {
        label: 'deadline test',
        deadline: 100,
        now: () => deadlineNow,
        sleep: async (ms) => {
          deadlineNow += ms;
        },
        fetchImpl: async () => {
          deadlineNow = 100;
          return Response.json(glamaEmpty);
        },
      }),
    /registry deadline exceeded/,
  );

  // Exercise the real abort timer: no fake clock or global timer replacement.
  let requestSignalAborted = false;
  await assert.rejects(
    () =>
      fetchWithRetry('https://example.invalid/timeout', {
        label: 'request timeout test',
        timeoutMs: 15,
        retries: 0,
        fetchImpl: async (_url, init) =>
          await new Promise((_resolve, reject) => {
            init.signal.addEventListener(
              'abort',
              () => {
                requestSignalAborted = init.signal.aborted;
                reject(init.signal.reason ?? new Error('request aborted'));
              },
              { once: true },
            );
          }),
      }, async (response) => response.text()),
    /giving up after 1 attempts/,
  );
  assert.equal(requestSignalAborted, true);

  // Headers alone do not complete a request: the abort timer remains active
  // while a stalled body is being consumed.
  let bodySignalAborted = false;
  await assert.rejects(
    () =>
      fetchWithRetry(
        'https://example.invalid/stalled-body',
        {
          label: 'stalled body timeout test',
          timeoutMs: 15,
          retries: 0,
          fetchImpl: async (_url, init) =>
            new Response(
              new ReadableStream({
                start(controller) {
                  init.signal.addEventListener(
                    'abort',
                    () => {
                      bodySignalAborted = true;
                      controller.error(init.signal.reason ?? new Error('body aborted'));
                    },
                    { once: true },
                  );
                },
              }),
            ),
        },
        async (response) => response.text(),
      ),
  );
  assert.equal(bodySignalAborted, true);

  const terminalDeadlineDb = initDatabase(join(dir, 'terminal-deadline.sqlite'));
  let terminalNow = 0;
  await syncGlamaRegistry(terminalDeadlineDb, {
    now: () => terminalNow,
    sleep: async () => {},
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        terminalNow = 12 * 60_000;
        return glamaEmpty;
      },
    }),
  });
  assert.equal(syncLog(terminalDeadlineDb, 'glama').status, 'error');
  assert.match(syncLog(terminalDeadlineDb, 'glama').error, /deadline exceeded/);
  terminalDeadlineDb.close();

  // Previous manifest: only 404 is a soft no-baseline result.
  const noBaseline = await fetchPreviousManifest({
    url: 'https://example.invalid/manifest.json',
    requiredSources: ['official', 'glama'],
    fetchImpl: async () => new Response('', { status: 404 }),
    sleep: async () => {},
  });
  assert.equal(noBaseline, null);

  let transientCalls = 0;
  const recoveredBaseline = await fetchPreviousManifest({
    url: 'https://example.invalid/manifest.json',
    requiredSources: ['official', 'glama'],
    fetchImpl: async () => {
      transientCalls++;
      return transientCalls === 1
        ? new Response('', { status: 503 })
        : Response.json(healthyManifest());
    },
    sleep: async () => {},
  });
  assert.equal(transientCalls, 2);
  assert.equal(recoveredBaseline.serverCount, 100);

  let networkCalls = 0;
  const networkRecovered = await fetchPreviousManifest({
    url: 'https://example.invalid/manifest.json',
    requiredSources: ['official', 'glama'],
    fetchImpl: async () => {
      networkCalls++;
      if (networkCalls === 1) throw new TypeError('temporary network failure');
      return Response.json(healthyManifest());
    },
    sleep: async () => {},
  });
  assert.equal(networkCalls, 2);
  assert.equal(networkRecovered.serverCount, 100);

  await assert.rejects(
    () =>
      fetchPreviousManifest({
        url: 'https://example.invalid/manifest.json',
        requiredSources: ['official', 'glama'],
        retries: 1,
        fetchImpl: async () => new Response('', { status: 503 }),
        sleep: async () => {},
      }),
    /unavailable after 2 attempts/,
  );

  await assert.rejects(
    () =>
      fetchPreviousManifest({
        url: 'https://example.invalid/manifest.json',
        requiredSources: ['official', 'glama'],
        retries: 1,
        fetchImpl: async () => Response.json(healthyManifest({ counts: { official: 60 } })),
        sleep: async () => {},
      }),
    /counts\.glama must be a positive number/,
  );

  assert.deepEqual(
    baselineManifestErrors(healthyManifest({ counts: { official: 60, glama: 0 } }), [
      'official',
      'glama',
    ]),
    ['previous manifest counts.glama must be a positive number'],
  );

  const healthyLog = [
    { source: 'official', status: 'ok', error: null },
    { source: 'glama', status: 'ok', error: null },
  ];
  const invalidCurrent = evaluateCurrentSnapshotQuality({
    syncLog: healthyLog,
    requiredSources: ['official', 'glama'],
    current: { serverCount: 0, counts: { official: 60, glama: 0 } },
  });
  assert.equal(invalidCurrent.ok, false);
  assert.deepEqual(invalidCurrent.warnings, []);
  assert.match(invalidCurrent.errors.join('\n'), /current serverCount must be a positive number/);
  assert.match(invalidCurrent.errors.join('\n'), /current counts\.glama must be a positive number/);

  const invalidCurrentWithOverride = evaluateSnapshotQuality({
    syncLog: healthyLog,
    requiredSources: ['official', 'glama'],
    current: { serverCount: 0, counts: { official: 60, glama: 0 } },
    previous: null,
    allowRegression: true,
  });
  assert.equal(invalidCurrentWithOverride.ok, false);
  assert.match(invalidCurrentWithOverride.errors.join('\n'), /current serverCount/);

  const totalRegression = evaluateSnapshotQuality({
    syncLog: healthyLog,
    requiredSources: ['official', 'glama'],
    current: { serverCount: 94, counts: { official: 60, glama: 40 } },
    previous: healthyManifest(),
  });
  assert.equal(totalRegression.ok, false);
  assert.match(totalRegression.errors.join('\n'), /serverCount dropped/);

  const sourceRegression = evaluateSnapshotQuality({
    syncLog: healthyLog,
    requiredSources: ['official', 'glama'],
    current: { serverCount: 100, counts: { official: 60, glama: 37 } },
    previous: healthyManifest(),
  });
  assert.equal(sourceRegression.ok, false);
  assert.match(sourceRegression.errors.join('\n'), /counts\.glama dropped/);

  const firstRun = evaluateSnapshotQuality({
    syncLog: healthyLog,
    requiredSources: ['official', 'glama'],
    current: healthyManifest(),
    previous: null,
  });
  assert.equal(firstRun.ok, true);

  const overridden = evaluateSnapshotQuality({
    syncLog: healthyLog,
    requiredSources: ['official', 'glama'],
    current: { serverCount: 10, counts: { official: 6, glama: 4 } },
    previous: healthyManifest(),
    allowRegression: true,
  });
  assert.equal(overridden.ok, true);
  assert.equal(overridden.regressionOverridden, true);

  for (const unhealthyLog of [
    [{ source: 'official', status: 'error', error: 'upstream failed' }],
    [{ source: 'glama', status: 'ok', error: null }],
  ]) {
    const result = evaluateSnapshotQuality({
      syncLog: unhealthyLog,
      requiredSources: ['official', 'glama'],
      current: { serverCount: 10, counts: { official: 6, glama: 4 } },
      previous: healthyManifest(),
      allowRegression: true,
    });
    assert.equal(result.ok, false, 'override must not bypass errored/missing source health');
  }

  for (const previous of [
    healthyManifest({ serverCount: 0 }),
    healthyManifest({ counts: { official: 60 } }),
  ]) {
    const result = evaluateSnapshotQuality({
      syncLog: healthyLog,
      requiredSources: ['official', 'glama'],
      current: healthyManifest(),
      previous,
      allowRegression: true,
    });
    assert.equal(result.ok, false, 'override must not bypass invalid baseline');
  }
} finally {
  if (originalGlamaBudget === undefined) delete process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
  else process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES = originalGlamaBudget;
  rmSync(dir, { recursive: true, force: true });
}

console.log('snapshot quality checks passed');
