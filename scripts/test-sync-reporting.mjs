import assert from 'node:assert/strict';

const { reportSyncResults } = await import('../packages/mcp-server/dist/sync-report.js');
const { settleSequentially } = await import(
  '../packages/mcp-server/dist/sync-orchestration.js'
);
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

const order = [];
const sequential = await settleSequentially([
  async () => {
    order.push('official');
    return 10;
  },
  async () => {
    order.push('glama');
    throw new Error('glama unavailable');
  },
  async () => {
    order.push('smithery');
    return 30;
  },
]);
assert.deepEqual(order, ['official', 'glama', 'smithery']);
assert.deepEqual(sequential.map((result) => result.status), [
  'fulfilled',
  'rejected',
  'fulfilled',
]);
assert.equal(sequential[0].value, 10);
assert.match(sequential[1].reason.message, /glama unavailable/);
assert.equal(sequential[2].value, 30);

console.log('sync reporting checks passed');
