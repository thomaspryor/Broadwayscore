// BRO-3619: getIssuesWithComments batches the audit's per-card comment
// re-fetch. Mocks global.fetch — no live Linear API calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
process.env.LINEAR_API_KEY = 'test-key';
const { getIssuesWithComments } = require('../../scripts/lib/linear-client.js');
const { buildIssuesWithCommentsByNumberQuery } = require('../../scripts/lib/linear-dispatch.js');

test('buildIssuesWithCommentsByNumberQuery filters by team + number and fetches description and comments', () => {
  const q = buildIssuesWithCommentsByNumberQuery();
  assert.match(q, /team: \{ key: \{ eq: \$teamKey \} \}/);
  assert.match(q, /number: \{ in: \$numbers \}/);
  assert.match(q, /description/);
  assert.match(q, /comments\(first: 50, orderBy: createdAt\) \{ nodes \{ body createdAt \} \}/);
});

test('getIssuesWithComments chunks identifiers into batches, dedupes, drops other teams/garbage', async () => {
  const calls = [];
  global.fetch = async (_url, opts) => {
    const { variables } = JSON.parse(opts.body);
    calls.push(variables);
    return { json: async () => ({ data: { issues: { nodes: variables.numbers.map(n => ({ identifier: `BRO-${n}`, description: '', comments: { nodes: [] } })) } } }) };
  };
  const ids = ['BRO-1', 'bro-2', 'BRO-3', 'BRO-1', 'XYZ-4', 'BRO-abc', null];
  const out = await getIssuesWithComments(ids, { batchSize: 2 });
  assert.deepEqual(calls.map(c => c.numbers), [[1, 2], [3]]);
  assert.deepEqual(calls.map(c => c.first), [2, 1]);
  assert.equal(calls[0].teamKey, 'BRO');
  assert.deepEqual(out.map(i => i.identifier), ['BRO-1', 'BRO-2', 'BRO-3']);
});

test('getIssuesWithComments makes no request for an empty/foreign list', async () => {
  let n = 0;
  global.fetch = async () => { n++; throw new Error('must not fetch'); };
  assert.deepEqual(await getIssuesWithComments(['XYZ-1']), []);
  assert.equal(n, 0);
});
