// BRO-3469: the recheck source must also reach COMPLETED cards that carry a
// RECHECK-AFTER stamp (BRO-3382 was Done and unreachable).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildRecheckCandidatesQuery, fetchLinearRecheckCandidates } = require('./linear-recheck-source.js');

const node = (identifier, type) => ({ identifier, title: identifier, description: '', updatedAt: '2026-10-01T00:00:00Z',
  completedAt: type === 'completed' ? '2026-10-01T00:00:00Z' : null, state: { name: type === 'completed' ? 'Done' : 'Backlog', type },
  comments: { nodes: [] } });

test('open query still excludes terminal types; stamped-done query targets completed + stamp', () => {
  const open = buildRecheckCandidatesQuery();
  assert.match(open, /nin: \["completed","canceled","duplicate"\]/);
  const done = buildRecheckCandidatesQuery('stamped-done');
  assert.match(done, /eq: "completed"/);
  assert.match(done, /RECHECK-AFTER/);
  assert.doesNotMatch(done, /nin:/);
});

test('fetch returns a stamped Done card alongside open cards, deduped', async () => {
  const queries = [];
  const client = { graphql: async (q) => {
    queries.push(q);
    return q.includes('eq: "completed"')
      ? { issues: { nodes: [node('BRO-3382', 'completed'), node('BRO-1', 'backlog')], pageInfo: { hasNextPage: false } } }
      : { issues: { nodes: [node('BRO-1', 'backlog')], pageInfo: { hasNextPage: false } } };
  } };
  const r = await fetchLinearRecheckCandidates(client, { teamKey: 'BRO' });
  assert.deepEqual(r.cards.map((c) => c.id).sort(), ['BRO-1', 'BRO-3382']);
  assert.equal(r.cards.find((c) => c.id === 'BRO-3382').status, 'Done');
  assert.equal(queries.length, 2);
  assert.equal(r.error, null);
});

test('an open-pass failure is reported and the stamped-done pass is skipped', async () => {
  let n = 0;
  const r = await fetchLinearRecheckCandidates({ graphql: async () => { n++; throw new Error('boom'); } }, { teamKey: 'BRO' });
  assert.match(r.error, /boom/);
  assert.equal(n, 1);
});
