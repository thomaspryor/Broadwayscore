import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planRoundupGapAlerts, buildRoundupGapAlert, syncRollupCard, ROUNDUP_GAP_ROLLUP_KEY } = require('./audit-show-review-gap.js');

const NOW = Date.parse('2026-10-16T12:00:00Z');
const row = (id, failed) => ({
  showId: id, title: `Show ${id}`, category: 'broadway', openingDate: '2026-10-15',
  ingestResults: Array.from({ length: failed }, (_, i) => ({ ok: false, url: `https://x.example/${id}/${i}` })),
  missing: Array.from({ length: failed }, (_, i) => ({ url: `https://x.example/${id}/${i}`, host: 'x.example', _run: undefined })),
  aggregatorArticles: [{ url: 'a' }],
});

test('N per-show roundup gaps fold into exactly one alert with one stable key', () => {
  const results = ['a', 'b', 'c', 'd', 'e'].map((id) => row(id, 2));
  const plan = planRoundupGapAlerts(results, true, NOW);
  assert.equal(plan.alert.length, 5, 'plan still sees every show');
  const opts = buildRoundupGapAlert(plan);
  assert.ok(opts && !Array.isArray(opts), 'one alert object, not one per show');
  assert.equal(opts.conditionKey, ROUNDUP_GAP_ROLLUP_KEY);
  for (const id of ['a', 'b', 'c', 'd', 'e']) assert.match(opts.description, new RegExp(`Show ${id} \\(${id}\\)`));
  assert.match(opts.title, /across 5 show\(s\)/);
});

test('key is identical across runs and shows, so the next run updates the same card', () => {
  const one = buildRoundupGapAlert(planRoundupGapAlerts([row('a', 1)], true, NOW));
  const many = buildRoundupGapAlert(planRoundupGapAlerts([row('a', 1), row('z', 3)], true, NOW));
  assert.equal(one.conditionKey, many.conditionKey);
});

test('no residual gaps yields no alert', () => {
  assert.equal(buildRoundupGapAlert(planRoundupGapAlerts([row('a', 0)], true, NOW)), null);
  assert.equal(buildRoundupGapAlert(null), null);
});

function fakes(initial, comments) {
  const ledger = { conditions: { [ROUNDUP_GAP_ROLLUP_KEY]: { status: 'open', rollupMembers: initial } } };
  return {
    ledger,
    deps: {
      router: { loadLedger: () => ledger, patchCondition: (k, patch) => { Object.assign(ledger.conditions[k], patch); return true; } },
      linearClient: { getIssue: async () => ({ id: 'uuid-1' }), createComment: async (id, body) => { comments.push({ id, body }); } },
    },
  };
}

test('a show added after the card was filed is commented on the existing card, once', async () => {
  const comments = [];
  const { ledger, deps } = fakes(['a'], comments);
  const plan = planRoundupGapAlerts([row('a', 1), row('b', 2)], true, NOW);
  const r1 = await syncRollupCard(plan, { action: 'silent', linearIdentifier: 'BRO-1' }, deps);
  assert.equal(r1.commented, 1);
  assert.match(comments[0].body, /Show b \(b\)/);
  assert.doesNotMatch(comments[0].body, /Show a \(a\)/);
  assert.deepEqual(ledger.conditions[ROUNDUP_GAP_ROLLUP_KEY].rollupMembers.sort(), ['a', 'b']);
  const r2 = await syncRollupCard(plan, { action: 'silent', linearIdentifier: 'BRO-1' }, deps);
  assert.equal(r2.commented, 0, 'same show set next run adds no comment');
  assert.equal(comments.length, 1);
});

test('a freshly filed card records its shows without commenting', async () => {
  const comments = [];
  const { ledger, deps } = fakes([], comments);
  const plan = planRoundupGapAlerts([row('a', 1), row('b', 1)], true, NOW);
  const r = await syncRollupCard(plan, { action: 'auto', linearIdentifier: 'BRO-2' }, deps);
  assert.equal(r.commented, 0);
  assert.deepEqual(ledger.conditions[ROUNDUP_GAP_ROLLUP_KEY].rollupMembers, ['a', 'b']);
});
