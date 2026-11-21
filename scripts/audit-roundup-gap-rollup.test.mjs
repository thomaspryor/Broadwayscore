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
const slow = (id, category, openingDate, extra = {}) => ({ showId: id, title: `Show ${id}`, category, openingDate, missing: [], flaggedMisses: [], ingestResults: [], ingestSkippedByCap: [], aggregatorArticles: [], computedAt: new Date(NOW - 3600000).toISOString(), ...extra });

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

test('a slow-market row not re-audited for 72h stays out (it can neither clear nor be fixed)', () => {
  const stale = slow('st', 'west-end', '2026-10-10', { missing: [{ url: 'https://n.example/r' }], computedAt: new Date(NOW - 73 * 3600000).toISOString() });
  const undated = slow('nd', 'west-end', '2026-10-10', { missing: [{ url: 'https://n.example/r' }], computedAt: undefined });
  const plan = planRoundupGapAlerts([stale, undated], true, NOW);
  assert.deepEqual([plan.alert.length, plan.resolve.length], [0, 0]);
});

test('a slow-market row audited 60h ago still alerts (inside the 72h cutoff)', () => {
  const r = slow('mid', 'west-end', '2026-10-10', { missing: [{ url: 'https://m.example/r' }], computedAt: new Date(NOW - 60 * 3600000).toISOString() });
  assert.deepEqual(planRoundupGapAlerts([r], true, NOW).alert.map(a => a.showId || a), planRoundupGapAlerts([{ ...r, computedAt: new Date(NOW - 3600000).toISOString() }], true, NOW).alert.map(a => a.showId || a));
  assert.equal(planRoundupGapAlerts([r], true, NOW).alert.length, 1);
});

test('a reverify row recovered this run does not hold the slow-market alert', () => {
  const r = slow('rc', 'off-west-end', '2026-10-10', {
    flaggedMisses: [{ url: 'https://rv.example/r', reverify: true }],
    recoveryResults: [{ url: 'https://rv.example/r', recovered: true }],
  });
  assert.deepEqual(planRoundupGapAlerts([r], true, NOW).resolve, ['rc']);
});

test('off-Broadway uses the roundup path through day 3 and the slow path from day 4', () => {
  const day = (d) => new Date(NOW - d * 86400000).toISOString().slice(0, 10);
  // Census-only gap: the roundup path counts it (uningested), the slow path does not.
  const mk = (id, d) => slow(id, 'off-broadway', day(d), { missing: [{ url: 'https://c.example/a', serpCensus: true }], aggregatorArticles: [{ url: 'https://bww.example/rr' }] });
  const plan = planRoundupGapAlerts([mk('d2', 2), mk('d5', 5)], false, NOW);
  assert.deepEqual(plan.alert.map((a) => a.showId), ['d2']);
  assert.deepEqual(plan.resolve, ['d5']);
});

// BRO-6687: an expected (correct, permanent) ingest rejection is settled, the
// same rule as the Broadway residual; a conflict and a plain failure stay gaps.
test('slow market: expected ingest rejections are settled, conflicts and failures still alert', () => {
  const r = slow('z', 'west-end', '2026-10-06', {
    missing: [{ url: 'https://e.example/r' }, { url: 'https://c.example/r' }, { url: 'https://f.example/r' }],
    ingestResults: [
      { url: 'https://e.example/r', ok: false, noop: true, expected: true, expectedReason: 'prior-production-quarantined' },
      { url: 'https://c.example/r', ok: false, noop: true, conflict: true, conflictReason: 'cross-show-url-owned' },
      { url: 'https://f.example/r', ok: false },
    ],
  });
  const plan = planRoundupGapAlerts([r], true, NOW);
  const c = plan.alert[0].counts;
  assert.deepEqual([c.residual, c.failedIngest, c.conflictIngest], [2, 1, 1]);
  assert.deepEqual(plan.alert[0].missing.map((m) => m.url), ['https://c.example/r', 'https://f.example/r']);
  const onlyExpected = slow('e', 'west-end', '2026-10-06', { missing: [{ url: 'https://e.example/r' }], ingestResults: [r.ingestResults[0]] });
  assert.deepEqual(planRoundupGapAlerts([onlyExpected], true, NOW).resolve, ['e']);
  // A plain noop (file already there) is not a failed ingest, matching computeResidualCounts.
  const onlyNoop = slow('n', 'west-end', '2026-10-06', { missing: [{ url: 'https://n.example/r' }], ingestResults: [{ url: 'https://n.example/r', ok: false, noop: true }] });
  assert.deepEqual(planRoundupGapAlerts([onlyNoop], true, NOW).resolve, ['n']);
});

// BRO-6687 (BRO-5489 rule): the window comes from today's shows.json, not the row.
test('slow market: a carried row with a stale openingDate alerts from the current show entry', () => {
  const r = slow('dogstar', 'off-west-end', null, { missing: [{ url: 'https://n.example/r' }] });
  assert.equal(planRoundupGapAlerts([r], true, NOW).alert.length, 0, 'row alone: no opening date, no window');
  const showById = new Map([['dogstar', { id: 'dogstar', category: 'off-west-end', openingDate: '2026-10-10' }]]);
  assert.deepEqual(planRoundupGapAlerts([r], true, NOW, { showById }).alert.map((a) => a.showId), ['dogstar']);
  const moved = new Map([['dogstar', { id: 'dogstar', category: 'off-west-end', openingDate: '2027-01-10' }]]);
  const r2 = slow('dogstar', 'off-west-end', '2026-10-10', { missing: [{ url: 'https://n.example/r' }] });
  assert.equal(planRoundupGapAlerts([r2], true, NOW, { showById: moved }).alert.length, 0, 'rescheduled show leaves the window');
});
