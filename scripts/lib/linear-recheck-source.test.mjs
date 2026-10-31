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

// ── Recently completed issues (BRO-3469, the 24h Done window) ──
const src = require('./linear-recheck-source.js');
const { selectRecheckTargets } = require('./autonomous-recheck-core.js');

const NOW = Date.parse('2026-10-13T12:00:00Z');
const issue = (id, extra = {}) => ({
  identifier: id,
  title: `t ${id}`,
  description: '',
  updatedAt: '2026-10-13T10:00:00Z',
  completedAt: '2026-10-13T09:00:00Z',
  state: { name: 'Done', type: 'completed' },
  comments: { nodes: [] },
  ...extra,
});

function pagedClient(pages, calls = []) {
  return {
    calls,
    async graphql(query, vars) {
      calls.push({ query, vars });
      const p = pages[calls.length - 1];
      if (p instanceof Error) throw p;
      return p;
    },
  };
}
const page = (nodes, next) => ({ issues: { nodes, pageInfo: { hasNextPage: !!next, endCursor: next || null } } });

test('switched off: no network call at all', async () => {
  const client = pagedClient([]);
  const r = await src.fetchRecentlyCompletedLinearCandidates(client, { env: { RECHECK_INCLUDE_COMPLETED_LINEAR: '0' } });
  assert.deepEqual(r, { cards: [], truncated: false, error: null, skipped: true });
  assert.equal(client.calls.length, 0);
});

test('on by default: fetches completed issues and maps them to Done cards', async () => {
  const client = pagedClient([page([issue('BRO-3382', { completedAt: '2026-10-13T08:49:09Z' })])]);
  const r = await src.fetchRecentlyCompletedLinearCandidates(client, { env: {}, now: () => NOW, windowHours: 24, teamKey: 'BRO' });
  assert.equal(r.skipped, false);
  assert.equal(r.error, null);
  assert.equal(r.cards.length, 1);
  assert.equal(r.cards[0].id, 'BRO-3382');
  assert.equal(r.cards[0].status, 'Done');
  assert.equal(r.cards[0].completedDate, '2026-10-13');
  // completedAt bound = window + 24h slack, frozen once
  assert.equal(client.calls[0].vars.since, new Date(NOW - 48 * 3600 * 1000).toISOString());
  assert.match(client.calls[0].query, /type: \{ eq: "completed" \}/);
  assert.match(client.calls[0].query, /completedAt: \{ gte: \$since \}/);
});

test('every page shares one frozen cutoff', async () => {
  let t = NOW;
  const client = pagedClient([page([issue('A')], 'c1'), page([issue('B')])]);
  const r = await src.fetchRecentlyCompletedLinearCandidates(client, { env: {}, now: () => (t += 1000), teamKey: 'BRO' });
  assert.equal(r.cards.length, 2);
  assert.equal(client.calls[0].vars.since, client.calls[1].vars.since);
  assert.equal(client.calls[1].vars.after, 'c1');
});

test('page cap reports truncated', async () => {
  const pages = Array.from({ length: src.COMPLETED_MAX_PAGES }, (_, i) => page([issue(`X-${i}`)], `c${i}`));
  const r = await src.fetchRecentlyCompletedLinearCandidates(pagedClient(pages), { env: {}, teamKey: 'BRO' });
  assert.equal(r.truncated, true);
  assert.equal(r.cards.length, src.COMPLETED_MAX_PAGES);
});

test('a mid-pagination failure keeps the cards already fetched and reports the error', async () => {
  const client = pagedClient([page([issue('A')], 'c1'), new Error('Linear 500')]);
  const r = await src.fetchRecentlyCompletedLinearCandidates(client, { env: {}, teamKey: 'BRO' });
  assert.equal(r.cards.length, 1);
  assert.equal(r.truncated, true);
  assert.match(r.error, /Linear 500/);
});

test('the two sources are isolated: a completed-fetch failure does not touch the non-terminal result', async () => {
  const good = pagedClient([page([issue('BRO-1', { state: { name: 'Backlog', type: 'backlog' }, completedAt: null })])]);
  const bad = pagedClient([new Error('boom')]);
  const [nonTerminal, completed] = await Promise.all([
    src.fetchLinearRecheckCandidates(good, { teamKey: 'BRO' }),
    src.fetchRecentlyCompletedLinearCandidates(bad, { env: {}, teamKey: 'BRO' }),
  ]);
  assert.equal(nonTerminal.error, null);
  assert.equal(nonTerminal.cards.length, 1);
  assert.match(completed.error, /boom/);
});

test('the non-terminal query still excludes completed issues (unchanged)', () => {
  assert.match(src.buildRecheckCandidatesQuery(), /nin: \["completed","canceled","duplicate"\]/);
});

test('acceptance: a card Done within 24h with a runnable VERIFY is selected as a recheck target', async () => {
  const client = pagedClient([page([issue('BRO-3382', {
    completedAt: '2026-10-13T08:49:09Z',
    description: '## Acceptance criteria\nVERIFY: node --test scripts/lib/recheck-stamp.test.mjs',
  })])]);
  const r = await src.fetchRecentlyCompletedLinearCandidates(client, { env: {}, now: () => NOW, teamKey: 'BRO' });
  const targets = selectRecheckTargets({ doneCards: r.cards, launchEntries: [], windowHours: 24, now: NOW });
  assert.deepEqual(targets.map((t) => t.cardId), ['BRO-3382']);
});
