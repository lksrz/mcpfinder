import assert from 'node:assert/strict';
import { join } from 'node:path';

const PAGE_SIZE = 100;
const runtime = (fetchImpl, now = () => 0) => ({ fetchImpl, now, sleep: async () => {} });

const smitheryEntry = (qualifiedName) => ({
  qualifiedName,
  displayName: qualifiedName,
  description: '',
  useCount: 0,
  verified: false,
  remote: false,
  isDeployed: false,
  iconUrl: null,
  homepage: null,
  createdAt: '2026-01-01T00:00:00Z',
});

const officialEntry = (name) => ({
  server: { name, version: '1.0.0', description: 'official baseline' },
});

const payload = (currentPage, servers, totalPages, totalCount) => ({
  servers,
  pagination: { currentPage, pageSize: PAGE_SIZE, totalPages, totalCount },
});

function syncLog(db) {
  return db
    .prepare("SELECT server_count, status, error FROM sync_log WHERE source = 'smithery'")
    .get();
}

export async function runSnapshotSmitheryPaginationChecks(dir) {
  const { initDatabase, syncOfficialRegistry, syncSmitheryRegistry } =
    await import('../packages/core/dist/index.js');

  // A short page is only a candidate terminal. An empty probe confirms it even
  // when concurrently drifting telemetry still advertises additional pages.
  const shortTerminalDb = initDatabase(join(dir, 'smithery-short-terminal.sqlite'));
  let shortTerminalCalls = 0;
  assert.equal(
    await syncSmitheryRegistry(shortTerminalDb, runtime(async () => {
      shortTerminalCalls++;
      return Response.json(shortTerminalCalls === 1
        ? payload(1, [smitheryEntry('smithery/short')], 2, 101)
        : payload(2, [], 2, 101));
    })),
    1,
  );
  assert.equal(shortTerminalCalls, 2);
  assert.equal(syncLog(shortTerminalDb).status, 'ok');
  shortTerminalDb.close();

  const shortGapDb = initDatabase(join(dir, 'smithery-short-gap.sqlite'));
  let shortGapCalls = 0;
  await syncSmitheryRegistry(shortGapDb, runtime(async () => {
    shortGapCalls++;
    return Response.json(payload(
      shortGapCalls,
      [smitheryEntry(`smithery/gap-${shortGapCalls}`)],
      2,
      101,
    ));
  }));
  assert.equal(shortGapCalls, 2);
  assert.equal(syncLog(shortGapDb).status, 'error');
  assert.match(syncLog(shortGapDb).error, /followed a short page/);
  assert.equal(shortGapDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  shortGapDb.close();

  const intraDuplicateDb = initDatabase(join(dir, 'smithery-intra-duplicate.sqlite'));
  let intraDuplicateCalls = 0;
  await syncSmitheryRegistry(intraDuplicateDb, runtime(async () => {
    intraDuplicateCalls++;
    return Response.json(payload(1, [
      smitheryEntry('smithery/intra-duplicate'),
      smitheryEntry('smithery/intra-duplicate'),
    ], 1, 2));
  }));
  assert.equal(intraDuplicateCalls, 1);
  assert.equal(syncLog(intraDuplicateDb).status, 'error');
  assert.match(syncLog(intraDuplicateDb).error, /duplicate qualifiedName/);
  assert.equal(intraDuplicateDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  intraDuplicateDb.close();

  const missingNameDb = initDatabase(join(dir, 'smithery-missing-qualified-name.sqlite'));
  await syncSmitheryRegistry(missingNameDb, runtime(async () => Response.json(payload(
    1,
    [{ ...smitheryEntry('discarded'), qualifiedName: undefined }],
    1,
    1,
  ))));
  assert.equal(syncLog(missingNameDb).status, 'error');
  assert.match(syncLog(missingNameDb).error, /qualifiedName must be a non-empty string/);
  assert.doesNotMatch(syncLog(missingNameDb).error, /duplicate.*undefined/);
  assert.equal(missingNameDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  missingNameDb.close();

  const transientDuplicateDb = initDatabase(join(dir, 'smithery-transient-duplicate.sqlite'));
  await syncOfficialRegistry(transientDuplicateDb, runtime(async () => Response.json({
    servers: [officialEntry('ai.smithery/abandoned-only')],
    metadata: { count: 1 },
  })));
  let transientAttempt = 0;
  let transientCalls = 0;
  assert.equal(
    await syncSmitheryRegistry(transientDuplicateDb, runtime(async (requestUrl) => {
      transientCalls++;
      const page = Number(new URL(requestUrl).searchParams.get('page'));
      if (page === 1) transientAttempt++;
      if (page === 1) {
        const servers = transientAttempt === 1
          ? [
              smitheryEntry('abandoned/only'),
              ...Array.from({ length: PAGE_SIZE - 1 }, (_, index) =>
                smitheryEntry(`smithery/abandoned-${index}`)),
            ]
          : Array.from({ length: PAGE_SIZE }, (_, index) =>
              smitheryEntry(`smithery/transient-${index}`));
        return Response.json(payload(1, servers, 2, 101));
      }
      if (page === 2) {
        const name = transientAttempt === 1 ? 'abandoned/only' : 'smithery/transient-100';
        return Response.json(payload(2, [smitheryEntry(name)], 2, 101));
      }
      return Response.json(payload(3, [], 2, 101));
    })),
    101,
  );
  assert.equal(transientAttempt, 2);
  assert.equal(transientCalls, 5);
  assert.equal(syncLog(transientDuplicateDb).status, 'ok');
  assert.equal(syncLog(transientDuplicateDb).server_count, 101);
  assert.equal(transientDuplicateDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 102);
  const untouchedOfficial = transientDuplicateDb
    .prepare("SELECT sources, raw_data FROM servers WHERE id = 'ai.smithery/abandoned-only'")
    .get();
  assert.deepEqual(JSON.parse(untouchedOfficial.sources), ['official']);
  assert.doesNotMatch(untouchedOfficial.raw_data, /abandoned\/only/);
  assert.equal(
    transientDuplicateDb
      .prepare("SELECT COUNT(*) AS count FROM servers WHERE id = 'smithery:abandoned/only'")
      .get().count,
    0,
  );
  assert.equal(
    transientDuplicateDb
      .prepare(
        `SELECT COUNT(*) AS count FROM servers
         WHERE raw_data LIKE '%"qualifiedName":"smithery/abandoned-%'`,
      )
      .get().count,
    0,
  );
  transientDuplicateDb.close();

  const persistentDuplicateDb = initDatabase(join(dir, 'smithery-persistent-duplicate.sqlite'));
  let persistentDuplicateCalls = 0;
  await syncSmitheryRegistry(persistentDuplicateDb, runtime(async (requestUrl) => {
    persistentDuplicateCalls++;
    const page = Number(new URL(requestUrl).searchParams.get('page'));
    return Response.json(page === 1
      ? payload(1, Array.from({ length: PAGE_SIZE }, (_, index) =>
          smitheryEntry(`smithery/persistent-${index}`)), 2, 101)
      : payload(2, [smitheryEntry('smithery/persistent-0')], 2, 101));
  }));
  assert.equal(persistentDuplicateCalls, 4);
  assert.equal(syncLog(persistentDuplicateDb).status, 'error');
  assert.equal(syncLog(persistentDuplicateDb).server_count, 0);
  assert.match(syncLog(persistentDuplicateDb).error, /cross-page duplicate/);
  assert.equal(
    persistentDuplicateDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count,
    0,
  );
  persistentDuplicateDb.close();

  const stableIdDb = initDatabase(join(dir, 'smithery-stable-id-priority.sqlite'));
  const repoA = 'https://github.com/acme/smithery-original';
  const repoB = 'https://github.com/acme/smithery-changed';
  let stablePage = 0;
  await syncSmitheryRegistry(stableIdDb, runtime(async () => {
    stablePage++;
    return Response.json(stablePage === 1
      ? payload(1, [{ ...smitheryEntry('stable/item'), homepage: repoA,
          description: 'old smithery term', useCount: 50, verified: true,
          iconUrl: 'https://example.com/old-stable-icon.png' }], 1, 1)
      : payload(2, [], 1, 1));
  }));
  await syncOfficialRegistry(stableIdDb, runtime(async () => Response.json({
    servers: [{ server: { name: 'other-smithery', version: '1.0.0', description: '',
      repository: { url: repoB, source: 'github' } } }], metadata: { count: 1 },
  })));
  stablePage = 0;
  await syncSmitheryRegistry(stableIdDb, runtime(async () => {
    stablePage++;
    return Response.json(stablePage === 1
      ? payload(1, [{ ...smitheryEntry('stable/item'), homepage: repoB,
          description: 'fresh smithery term', useCount: 3, verified: false,
          iconUrl: null }], 1, 1)
      : payload(2, [], 1, 1));
  }));
  const stable = stableIdDb
    .prepare("SELECT raw_data, keywords, repository_url, repository_source, " +
      "use_count, verified, icon_url " +
      "FROM servers WHERE id = 'smithery:stable/item'").get();
  assert.match(stable.raw_data, /fresh smithery term/);
  assert.ok(JSON.parse(stable.keywords).includes('fresh'));
  assert.ok(!JSON.parse(stable.keywords).includes('old'));
  assert.equal(stable.repository_url, repoB);
  assert.equal(stable.repository_source, 'github');
  assert.equal(stable.use_count, 3);
  assert.equal(stable.verified, 0);
  assert.equal(stable.icon_url, null);
  assert.deepEqual(JSON.parse(
    stableIdDb.prepare("SELECT sources FROM servers WHERE id = 'other-smithery'").get().sources,
  ), ['official']);
  stablePage = 0;
  await syncSmitheryRegistry(stableIdDb, runtime(async () => {
    stablePage++;
    return Response.json(stablePage === 1
      ? payload(1, [{ ...smitheryEntry('stable/item'), homepage: null,
          description: 'repository removed' }], 1, 1)
      : payload(2, [], 1, 1));
  }));
  const withoutRepository = stableIdDb.prepare(
    "SELECT repository_url, repository_source FROM servers WHERE id = 'smithery:stable/item'",
  ).get();
  assert.equal(withoutRepository.repository_url, null);
  assert.equal(withoutRepository.repository_source, null);
  stableIdDb.close();

  const driftDb = initDatabase(join(dir, 'smithery-count-drift.sqlite'));
  let driftPage = 0;
  assert.equal(
    await syncSmitheryRegistry(driftDb, runtime(async () => {
      driftPage++;
      const start = (driftPage - 1) * PAGE_SIZE;
      if (driftPage === 4) return Response.json(payload(4, [], 3, 201));
      const length = driftPage < 3 ? PAGE_SIZE : 1;
      return Response.json(payload(
        driftPage,
        Array.from({ length }, (_, index) => smitheryEntry(`smithery/drift-${start + index}`)),
        driftPage === 1 ? 2 : 3,
        driftPage === 1 ? 200 : 201,
      ));
    })),
    201,
  );
  assert.equal(driftPage, 4);
  assert.equal(syncLog(driftDb).status, 'ok');
  driftDb.close();

  // A catalogue shrink can move the probe several pages beyond current
  // telemetry; an empty response is still an unambiguous terminal.
  const shrinkDb = initDatabase(join(dir, 'smithery-count-shrink.sqlite'));
  let shrinkPage = 0;
  assert.equal(
    await syncSmitheryRegistry(shrinkDb, runtime(async () => {
      shrinkPage++;
      return Response.json(shrinkPage < 3
        ? payload(shrinkPage, Array.from({ length: PAGE_SIZE }, (_, index) =>
            smitheryEntry(`smithery/shrink-${shrinkPage}-${index}`)), 3, 300)
        : payload(3, [], 1, 100));
    })),
    200,
  );
  assert.equal(shrinkPage, 3);
  assert.equal(syncLog(shrinkDb).status, 'ok');
  shrinkDb.close();

  const zeroMathDb = initDatabase(join(dir, 'smithery-zero-math.sqlite'));
  await syncSmitheryRegistry(zeroMathDb, runtime(async () =>
    Response.json({
      servers: [],
      pagination: { currentPage: 1, pageSize: 0, totalPages: 1, totalCount: 0 },
    })));
  assert.equal(syncLog(zeroMathDb).status, 'ok');
  assert.equal(syncLog(zeroMathDb).server_count, 0);
  zeroMathDb.close();

  const advisoryDb = initDatabase(join(dir, 'smithery-advisory-pagination.sqlite'));
  let advisoryPage = 0;
  assert.equal(
    await syncSmitheryRegistry(advisoryDb, runtime(async () => {
      advisoryPage++;
      const servers = advisoryPage === 1
        ? Array.from({ length: PAGE_SIZE }, (_, index) =>
            smitheryEntry(`smithery/advisory-${index}`))
        : advisoryPage === 2 ? [smitheryEntry('smithery/advisory-last')] : [];
      return Response.json({
        servers,
        pagination: {
          currentPage: advisoryPage,
          pageSize: advisoryPage === 1 ? 37 : 0,
          totalPages: 0,
          totalCount: advisoryPage === 1 ? 1 : 9999,
        },
      });
    })),
    101,
  );
  assert.equal(advisoryPage, 3);
  assert.equal(syncLog(advisoryDb).status, 'ok');
  advisoryDb.close();

  const oversizedDb = initDatabase(join(dir, 'smithery-oversized-page.sqlite'));
  await syncSmitheryRegistry(oversizedDb, runtime(async () => Response.json(payload(
    1,
    Array.from({ length: PAGE_SIZE + 1 }, (_, index) =>
      smitheryEntry(`smithery/oversized-${index}`)),
    2,
    PAGE_SIZE + 1,
  ))));
  assert.equal(syncLog(oversizedDb).status, 'error');
  assert.match(syncLog(oversizedDb).error, /exceeds requested page limit/);
  assert.equal(oversizedDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  oversizedDb.close();

  const loopDb = initDatabase(join(dir, 'smithery-page-loop.sqlite'));
  let loopCalls = 0;
  await syncSmitheryRegistry(loopDb, runtime(async () => {
    loopCalls++;
    return Response.json(payload(1, Array.from({ length: PAGE_SIZE }, (_, index) =>
      smitheryEntry(`smithery/loop-${loopCalls}-${index}`)), 2, 200));
  }));
  assert.equal(loopCalls, 2);
  assert.equal(syncLog(loopDb).status, 'error');
  assert.match(syncLog(loopDb).error, /currentPage 1 does not match 2/);
  loopDb.close();

  const noTerminalDb = initDatabase(join(dir, 'smithery-no-terminal.sqlite'));
  let clock = 0;
  await syncSmitheryRegistry(noTerminalDb, {
    now: () => clock,
    sleep: async () => { clock = 5 * 60_000; },
    fetchImpl: async () => Response.json(payload(1, Array.from({ length: PAGE_SIZE }, (_, index) =>
      smitheryEntry(`smithery/no-terminal-${index}`)), 1, 100)),
  });
  assert.equal(syncLog(noTerminalDb).status, 'error');
  assert.match(syncLog(noTerminalDb).error, /exceeded its 5-minute budget/);
  assert.match(syncLog(noTerminalDb).error, /discarded 100 staged servers/);
  assert.match(syncLog(noTerminalDb).error, /last-known-good database unchanged/);
  assert.equal(syncLog(noTerminalDb).server_count, 0);
  assert.equal(noTerminalDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 0);
  noTerminalDb.close();

  const applyDeadlineDb = initDatabase(join(dir, 'smithery-apply-deadline.sqlite'));
  await syncOfficialRegistry(applyDeadlineDb, runtime(async () => Response.json({
    servers: [{ server: { name: 'smithery-lkg', version: '1.0.0', description: 'unchanged' } }],
    metadata: { count: 1 },
  })));
  let applyClock = 0;
  const applyEntry = smitheryEntry('smithery/apply-deadline');
  await syncSmitheryRegistry(applyDeadlineDb, {
    now: () => applyClock,
    sleep: async () => {},
    fetchImpl: async (requestUrl) => {
      const currentPage = Number(new URL(requestUrl).searchParams.get('page'));
      // The crawl itself stages within budget; the clock crosses the deadline
      // only once the terminal probe has been served, so the failure lands on
      // the apply-time deadline check rather than on the crawl budget.
      if (currentPage > 1) applyClock = 5 * 60_000;
      return {
        ok: true, status: 200, statusText: 'OK',
        json: async () => currentPage === 1
          ? payload(1, [applyEntry], 1, 1)
          : payload(2, [], 1, 1),
      };
    },
  });
  assert.equal(syncLog(applyDeadlineDb).status, 'error');
  assert.match(syncLog(applyDeadlineDb).error, /deadline exceeded/);
  assert.equal(applyDeadlineDb.prepare('SELECT COUNT(*) AS count FROM servers').get().count, 1);
  assert.deepEqual(JSON.parse(applyDeadlineDb.prepare('SELECT sources FROM servers').get().sources), ['official']);
  applyDeadlineDb.close();
}
