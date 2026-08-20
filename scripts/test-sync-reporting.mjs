import assert from 'node:assert/strict';

const { reportSyncResults } = await import('../packages/mcp-server/dist/sync-report.js');
const messages = [];
const error = new Error('official transport exploded');
const counts = reportSyncResults(
  [
    { status: 'rejected', reason: error },
    { status: 'fulfilled', value: 42 },
    { status: 'rejected', reason: { code: 'BAD_JSON', cursor: 'page-7' } },
  ],
  (message) => messages.push(message),
);

assert.deepEqual(counts, [0, 42, 0]);
assert.equal(messages.length, 2);
assert.match(messages[0], /Official sync rejected:/);
assert.match(messages[0], /Error: official transport exploded/);
assert.match(messages[0], /test-sync-reporting\.mjs/);
assert.match(messages[1], /Smithery sync rejected:/);
assert.match(messages[1], /BAD_JSON/);
assert.match(messages[1], /page-7/);

console.log('sync reporting checks passed');
