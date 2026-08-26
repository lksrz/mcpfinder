import assert from 'node:assert/strict';
import { join } from 'node:path';

const runtime = (fetchImpl, now = () => 0, sleep = async () => {}) => ({ fetchImpl, now, sleep });

const glamaEntry = (id) => ({
  id,
  name: id,
  namespace: '',
  slug: id,
  description: '',
  repository: null,
  spdxLicense: null,
  tools: [],
  url: null,
  environmentVariablesJsonSchema: null,
  attributes: {},
});

const page = (servers, hasNextPage, endCursor = null) => ({
  servers,
  pageInfo: { hasNextPage, endCursor },
});

function syncLog(db) {
  return db
    .prepare("SELECT server_count, status, error FROM sync_log WHERE source = 'glama'")
    .get();
}

export async function runSnapshotGlamaCrawlChecks(dir) {
  // syncGlamaRegistry short-circuits before any request without a key, so the
  // caller must supply a stub credential for these crawl paths to run at all.
  assert.ok(process.env.GLAMA_API_KEY, 'GLAMA_API_KEY must be set by the caller');
  const { initDatabase, syncOfficialRegistry, syncGlamaRegistry } =
    await import('../packages/core/dist/index.js');

  const transientDb = initDatabase(join(dir, 'glama-transient-duplicate.sqlite'));
  await syncOfficialRegistry(transientDb, runtime(async () => Response.json({
    servers: [{ server: { name: 'abandoned', version: '1.0.0', description: 'baseline' } }],
    metadata: { count: 1 },
  })));
  let transientAttempt = 0;
  let transientCalls = 0;
  assert.equal(
    await syncGlamaRegistry(transientDb, runtime(async (requestUrl) => {
      transientCalls++;
      const cursor = new URL(requestUrl).searchParams.get('after');
      if (!cursor) transientAttempt++;
      if (transientAttempt === 1) {
        return Response.json(cursor
          ? page([glamaEntry('abandoned')], false)
          : page([glamaEntry('abandoned'), glamaEntry('first-attempt-only')], true, 'first-next'));
      }
      return Response.json(cursor
        ? page([glamaEntry('final-b')], false)
        : page([glamaEntry('final-a')], true, 'final-next'));
    })),
    2,
  );
  assert.equal(transientAttempt, 2);
  assert.equal(transientCalls, 4);
  assert.equal(syncLog(transientDb).status, 'ok');
  assert.equal(syncLog(transientDb).server_count, 2);
  assert.equal(transientDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 3);
  assert.equal(
    transientDb.prepare("SELECT COUNT(*) AS count FROM servers WHERE id = 'glama:first-attempt-only'")
      .get().count,
    0,
  );
  const untouchedOfficial = transientDb
    .prepare("SELECT sources, raw_data FROM servers WHERE id = 'abandoned'")
    .get();
  assert.deepEqual(JSON.parse(untouchedOfficial.sources), ['official']);
  assert.doesNotMatch(untouchedOfficial.raw_data, /first-attempt-only|\"id\":\"abandoned\"/);
  transientDb.close();

  const persistentDb = initDatabase(join(dir, 'glama-persistent-duplicate.sqlite'));
  let persistentCalls = 0;
  await syncGlamaRegistry(persistentDb, runtime(async (requestUrl) => {
    persistentCalls++;
    const cursor = new URL(requestUrl).searchParams.get('after');
    return Response.json(cursor
      ? page([glamaEntry('persistent')], false)
      : page([glamaEntry('persistent')], true, 'next'));
  }));
  assert.equal(persistentCalls, 4);
  assert.equal(syncLog(persistentDb).status, 'error');
  assert.equal(syncLog(persistentDb).server_count, 0);
  assert.match(syncLog(persistentDb).error, /cross-page duplicate/);
  assert.equal(persistentDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  persistentDb.close();

  const stableIdDb = initDatabase(join(dir, 'glama-stable-id-priority.sqlite'));
  const repoA = 'https://github.com/acme/original';
  const repoB = 'https://github.com/acme/changed';
  const initial = {
    ...glamaEntry('stable'),
    repository: { url: repoA },
    description: 'old term',
    environmentVariablesJsonSchema: {
      properties: { OLD_TOKEN: { description: 'obsolete' } },
    },
  };
  await syncGlamaRegistry(stableIdDb, runtime(async () => Response.json(page([initial], false))));
  stableIdDb.prepare(
    "UPDATE servers SET last_synced_at = '2000-01-01T00:00:00.000Z' WHERE id = 'glama:stable'",
  ).run();
  await syncOfficialRegistry(stableIdDb, runtime(async () => Response.json({
    servers: [{ server: { name: 'other', version: '1.0.0', description: '',
      repository: { url: repoB, source: 'github' } } }], metadata: { count: 1 },
  })));
  const refreshed = {
    ...glamaEntry('stable'),
    repository: { url: repoB },
    description: 'fresh term',
    environmentVariablesJsonSchema: {
      properties: { NEW_TOKEN: { description: 'current' } },
    },
  };
  await syncGlamaRegistry(stableIdDb, runtime(async () => Response.json(page([refreshed], false))));
  const stable = stableIdDb.prepare(
    "SELECT raw_data, keywords, repository_url, repository_source, env_vars, last_synced_at " +
      "FROM servers WHERE id = 'glama:stable'",
  ).get();
  assert.match(stable.raw_data, /fresh term/);
  assert.ok(JSON.parse(stable.keywords).includes('fresh'));
  assert.ok(!JSON.parse(stable.keywords).includes('old'));
  assert.equal(stable.repository_url, repoB);
  assert.equal(stable.repository_source, 'github');
  assert.deepEqual(JSON.parse(stable.env_vars).map((item) => item.name), ['NEW_TOKEN']);
  assert.notEqual(stable.last_synced_at, '2000-01-01T00:00:00.000Z');
  assert.ok(!Number.isNaN(Date.parse(stable.last_synced_at)));
  assert.deepEqual(
    JSON.parse(stableIdDb.prepare("SELECT sources FROM servers WHERE id = 'other'").get().sources),
    ['official'],
  );
  await syncGlamaRegistry(stableIdDb, runtime(async () => Response.json(page([{
    ...glamaEntry('stable'), repository: null, description: 'repository removed',
  }], false))));
  const withoutRepository = stableIdDb.prepare(
    "SELECT repository_url, repository_source FROM servers WHERE id = 'glama:stable'",
  ).get();
  assert.equal(withoutRepository.repository_url, null);
  assert.equal(withoutRepository.repository_source, null);
  assert.deepEqual(JSON.parse(
    stableIdDb.prepare("SELECT env_vars FROM servers WHERE id = 'glama:stable'").get().env_vars,
  ), []);
  stableIdDb.close();

  const refreshedIndexDb = initDatabase(join(dir, 'glama-stable-index-refresh.sqlite'));
  const oldRepo = 'https://github.com/acme/old-index-key';
  const newRepo = 'https://github.com/acme/new-index-key';
  await syncGlamaRegistry(refreshedIndexDb, runtime(async () => Response.json(page([{
    ...glamaEntry('indexed-stable'),
    slug: 'old-index-slug',
    repository: { url: oldRepo },
  }], false))));
  await syncGlamaRegistry(refreshedIndexDb, runtime(async () => Response.json(page([
    {
      ...glamaEntry('indexed-stable'),
      slug: 'new-index-slug',
      repository: { url: newRepo },
      description: 'refreshed stable payload',
    },
    {
      ...glamaEntry('new-at-old-keys'),
      slug: 'old-index-slug',
      repository: { url: oldRepo },
      description: 'separate old-key payload',
    },
  ], false))));
  assert.equal(refreshedIndexDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 2);
  const refreshedStable = refreshedIndexDb.prepare(
    "SELECT repository_url, slug, sources, raw_data FROM servers WHERE id = 'glama:indexed-stable'",
  ).get();
  assert.equal(refreshedStable.repository_url, newRepo);
  assert.equal(refreshedStable.slug, 'new-index-slug');
  assert.deepEqual(JSON.parse(refreshedStable.sources), ['glama']);
  assert.doesNotMatch(refreshedStable.raw_data, /separate old-key payload/);
  const separateOldKey = refreshedIndexDb.prepare(
    "SELECT repository_url, slug, sources, raw_data FROM servers WHERE id = 'glama:new-at-old-keys'",
  ).get();
  assert.equal(separateOldKey.repository_url, oldRepo);
  assert.equal(separateOldKey.slug, 'old-index-slug');
  assert.deepEqual(JSON.parse(separateOldKey.sources), ['glama']);
  assert.match(separateOldKey.raw_data, /separate old-key payload/);
  refreshedIndexDb.close();

  const intraDb = initDatabase(join(dir, 'glama-intra-duplicate.sqlite'));
  let intraCalls = 0;
  await syncGlamaRegistry(intraDb, runtime(async () => {
    intraCalls++;
    return Response.json(page([glamaEntry('intra'), glamaEntry('intra')], false));
  }));
  assert.equal(intraCalls, 1);
  assert.equal(syncLog(intraDb).status, 'error');
  assert.match(syncLog(intraDb).error, /duplicate server id/);
  assert.equal(intraDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  intraDb.close();

  const originalBudget = process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
  process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES = '1';
  try {
    const deadlineDb = initDatabase(join(dir, 'glama-staged-deadline.sqlite'));
    let clock = 0;
    let deadlineCalls = 0;
    await syncGlamaRegistry(deadlineDb, runtime(
      async () => {
        deadlineCalls++;
        return Response.json(page([glamaEntry('staged-only')], true, 'next'));
      },
      () => clock,
      async () => { clock = 60_000; },
    ));
    assert.equal(deadlineCalls, 1);
    assert.equal(syncLog(deadlineDb).status, 'error');
    assert.equal(syncLog(deadlineDb).server_count, 0);
    assert.match(syncLog(deadlineDb).error, /discarded 1 staged servers/);
    assert.equal(deadlineDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
    deadlineDb.close();

    const applyDeadlineDb = initDatabase(join(dir, 'glama-apply-deadline.sqlite'));
    await syncOfficialRegistry(applyDeadlineDb, runtime(async () => Response.json({
      servers: [{ server: { name: 'glama-lkg', version: '1.0.0', description: 'unchanged' } }],
      metadata: { count: 1 },
    })));
    let applyClock = 0;
    const applyEntry = glamaEntry('apply-deadline');
    Object.defineProperty(applyEntry, 'description', {
      enumerable: true,
      get() { applyClock = 60_000; return 'late apply'; },
    });
    await syncGlamaRegistry(applyDeadlineDb, runtime(
      async () => ({
        ok: true, status: 200, statusText: 'OK',
        json: async () => page([applyEntry], false),
      }),
      () => applyClock,
    ));
    assert.equal(syncLog(applyDeadlineDb).status, 'error');
    assert.match(syncLog(applyDeadlineDb).error, /deadline exceeded/);
    assert.equal(applyDeadlineDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 1);
    assert.deepEqual(JSON.parse(applyDeadlineDb.prepare('SELECT sources FROM servers').get().sources), ['official']);
    applyDeadlineDb.close();
  } finally {
    if (originalBudget === undefined) delete process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES;
    else process.env.MCPFINDER_GLAMA_SYNC_BUDGET_MINUTES = originalBudget;
  }
}
