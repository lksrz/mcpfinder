import assert from 'node:assert/strict';
import { join } from 'node:path';

const runtime = (fetchImpl) => ({ fetchImpl, now: () => 0, sleep: async () => {} });
const official = (name, repo) => ({ server: {
  name, version: '1.0.0', description: `${name} official`,
  repository: { url: repo, source: 'github' },
} });
const smithery = (qualifiedName, displayName) => ({
  qualifiedName, displayName, description: 'smithery unique metadata', useCount: 7,
  verified: true, remote: false, isDeployed: false, iconUrl: null, homepage: null,
  createdAt: '2026-01-01T00:00:00Z',
  tools: [{ name: 'smithery-envelope-tool', description: 'survives enrichment merge' }],
});

export async function runSnapshotEnrichChecks(dir) {
  const {
    initDatabase,
    enrichSmitheryRepoUrls,
    getServerDetails,
    syncOfficialRegistry,
    syncSmitheryRegistry,
  } =
    await import('../packages/core/dist/index.js');
  const db = initDatabase(join(dir, 'enrich-monorepo.sqlite'));
  const repo = 'https://github.com/acme/mono';
  await syncOfficialRegistry(db, runtime(async () => Response.json({
    servers: [official('unrelated', repo), official('target', repo)], metadata: { count: 2 },
  })));
  await syncSmitheryRegistry(db, runtime(async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json({ servers: page === 1 ? [smithery('acme/mono', 'target')] : [],
      pagination: { currentPage: page, pageSize: 100, totalPages: 1, totalCount: 1 } });
  }));
  // Store a canonical same-source envelope before enrichment merges the whole
  // Smithery row into the Official target.
  await syncSmitheryRegistry(db, runtime(async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json({ servers: page === 1 ? [smithery('acme/mono', 'target')] : [],
      pagination: { currentPage: page, pageSize: 100, totalPages: 1, totalCount: 1 } });
  }));
  db.prepare("UPDATE servers SET env_vars = '[{\"name\":\"SMITHERY_TOKEN\"}]' WHERE source = 'smithery'").run();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    const result = await enrichSmitheryRepoUrls(db, { token: 'test', concurrency: 1 });
    assert.equal(result.merged, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM servers WHERE source = 'smithery'").get().count, 0);
  const target = db.prepare("SELECT * FROM servers WHERE id = 'target'").get();
  assert.deepEqual(JSON.parse(target.sources), ['official', 'smithery']);
  assert.equal(target.repository_source, 'github');
  assert.ok(JSON.parse(target.env_vars).some((item) => item.name === 'SMITHERY_TOKEN'));
  assert.match(target.raw_data, /qualifiedName/);
  assert.ok(JSON.parse(target.keywords).includes('smithery'));
  const targetRaw = JSON.parse(target.raw_data);
  assert.equal(targetRaw.bySource.smithery.qualifiedName, 'acme/mono');
  assert.equal(targetRaw.bySource.smithery.primarySource, undefined);
  assert.ok(getServerDetails(db, 'target').toolsExposed.some(
    (tool) => tool.name === 'smithery-envelope-tool',
  ));
  assert.deepEqual(JSON.parse(db.prepare("SELECT sources FROM servers WHERE id = 'unrelated'").get().sources), ['official']);
  db.close();

  const retained = initDatabase(join(dir, 'enrich-retained.sqlite'));
  await syncSmitheryRegistry(retained, runtime(async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json({ servers: page === 1 ? [smithery('solo/repo', 'solo')] : [],
      pagination: { currentPage: page, pageSize: 100, totalPages: 1, totalCount: 1 } });
  }));
  // A same-source refresh wraps the raw payload in the canonical bySource
  // envelope. Enrichment must still find Smithery's qualifiedName there.
  await syncSmitheryRegistry(retained, runtime(async (url) => {
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json({ servers: page === 1 ? [smithery('solo/repo', 'solo')] : [],
      pagination: { currentPage: page, pageSize: 100, totalPages: 1, totalCount: 1 } });
  }));
  const retainedRaw = JSON.parse(retained.prepare('SELECT raw_data FROM servers').get().raw_data);
  assert.equal(retainedRaw.primarySource, 'smithery');
  assert.equal(retainedRaw.primary.qualifiedName, 'solo/repo');
  assert.equal(retainedRaw.bySource.smithery, undefined);
  globalThis.fetch = async () => new Response('{}', { status: 200 });
  try {
    await enrichSmitheryRepoUrls(retained, { token: 'test', concurrency: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }
  const retainedRow = retained.prepare('SELECT repository_url, repository_source FROM servers').get();
  assert.equal(retainedRow.repository_url, 'https://github.com/solo/repo');
  assert.equal(retainedRow.repository_source, 'github');
  retained.close();
}
