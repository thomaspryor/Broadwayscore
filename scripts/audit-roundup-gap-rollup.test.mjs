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

test('every open per-show roundup-gap key is offered to the quiet resolve; the rollup and closed keys are not (BRO-5132)', () => {
  const { openLegacyRoundupGapKeys } = require('./audit-show-review-gap.js');
  const conditions = {
    [ROUNDUP_GAP_ROLLUP_KEY]: { status: 'open' },
    'roundup-gap:elf-lyons-the-woman-on-the-edge-off-broadway-2026': { status: 'open', linearIdentifier: 'BRO-4344' },
    'roundup-gap:old-show-2026': { status: 'resolved' },
    'review-gap:opening-window:elf-lyons-the-woman-on-the-edge-off-broadway-2026': { status: 'open' },
  };
  assert.deepEqual(openLegacyRoundupGapKeys(conditions), ['roundup-gap:elf-lyons-the-woman-on-the-edge-off-broadway-2026']);
  assert.deepEqual(openLegacyRoundupGapKeys(undefined), []);
});

// BRO-6687: slow markets (off-Broadway past day 3, West End, off-West End) join the
// rollup for 21 days, counting only cited rows and reverify exclusions.
const slow = (id, category, openingDate, extra = {}) => ({ showId: id, title: `Show ${id}`, category, openingDate, missing: [], flaggedMisses: [], ingestResults: [], ingestSkippedByCap: [], aggregatorArticles: [], ...extra });

test('a West End show with a cap-skipped cited review alerts on day 11', () => {
  const r = slow('mg', 'west-end', '2026-10-05', {
    missing: [{ url: 'https://c.example/forum', serpCensus: true }, { url: 'https://n.example/review', weRef: true }],
    ingestResults: [{ url: 'https://c.example/forum', ok: false, noop: true }],
    ingestSkippedByCap: [{ url: 'https://n.example/review' }],
  });
  const plan = planRoundupGapAlerts([r], true, NOW);
  assert.equal(plan.alert.length, 1);
  assert.deepEqual([plan.alert[0].counts.residual, plan.alert[0].counts.capped], [1, 1]);
  assert.deepEqual(plan.alert[0].missing.map((m) => m.url), ['https://n.example/review']);
  assert.match(buildRoundupGapAlert(plan).description, /n\.example\/review/);
});

test('census-only and prior-run gaps do not hold a slow-market alert open', () => {
  const r = slow('x', 'off-west-end', '2026-10-10', {
    missing: [{ url: 'https://c.example/a', serpCensus: true }, { url: 'https://old.example/r', priorRun: true }],
    flaggedMisses: [{ url: 'https://f.example/r', reverify: false, confirmedNonReview: true }],
  });
  const plan = planRoundupGapAlerts([r], true, NOW);
  assert.equal(plan.alert.length, 0);
  assert.deepEqual(plan.resolve, ['x']);
});

test('a reverify exclusion counts; an ingest that landed this run does not', () => {
  const r = slow('y', 'off-broadway', '2026-10-06', {
    missing: [{ url: 'https://ok.example/r' }],
    ingestResults: [{ url: 'https://ok.example/r', ok: true }],
    flaggedMisses: [{ url: 'https://rv.example/r', reverify: true }],
  });
  const plan = planRoundupGapAlerts([r], true, NOW);
  assert.equal(plan.alert[0].counts.residual, 1);
  assert.equal(plan.alert[0].counts.flaggedOut, 1);
});

test('slow-market window ends at 21 days and never includes Broadway past day 3', () => {
  const late = slow('late', 'west-end', '2026-09-20', { missing: [{ url: 'https://n.example/r' }] });
  const bway = slow('bw', 'broadway', '2026-10-06', { missing: [{ url: 'https://n.example/r' }] });
  assert.equal(planRoundupGapAlerts([late, bway], true, NOW).alert.length, 0);
});
