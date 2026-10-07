import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyCell, classifyCellDetailed, isActionableState, mergeLedger, serializeLedger, isDispatchTierOutlet, computeDispatchDecision } = require('./t1-ledger.js');

test('isDispatchTierOutlet: T1/T2 only, unregistered/junk excluded', () => {
  const outlets = {
    nytimes: { tier: 1 },
    theatermania: { tier: 2 },
    'broadway-blog': { tier: 3 },
    'some-t4-blog': { tier: 4 },
    'bad-tier': { tier: '1' },       // non-numeric tier — reject
    'no-tier': { displayName: 'X' }, // registered but tierless — reject
  };
  assert.equal(isDispatchTierOutlet(outlets, 'nytimes'), true, 'T1');
  assert.equal(isDispatchTierOutlet(outlets, 'theatermania'), true, 'T2');
  assert.equal(isDispatchTierOutlet(outlets, 'broadway-blog'), false, 'T3');
  assert.equal(isDispatchTierOutlet(outlets, 'some-t4-blog'), false, 'T4');
  assert.equal(isDispatchTierOutlet(outlets, 'bad-tier'), false, 'string tier');
  assert.equal(isDispatchTierOutlet(outlets, 'no-tier'), false, 'missing tier');
  assert.equal(isDispatchTierOutlet(outlets, 'buy-tickets-directly-from-the-theatre'), false, 'unregistered phantom');
  assert.equal(isDispatchTierOutlet(null, 'nytimes'), false, 'null registry');
});

test('classifyCell: state machine', () => {
  assert.equal(classifyCell({ noReviewExpected: true, suppressed: false, clockAgeHours: 100 }), 'NO_REVIEW_EXPECTED');
  assert.equal(classifyCell({ suppressed: true, clockAgeHours: 100 }), 'SUPPRESSED');
  assert.equal(classifyCell({ clockAgeHours: 5 }), 'IN_FLIGHT', 'under 24h = in flight');
  assert.equal(classifyCell({ clockAgeHours: 48 }), 'GAP', 'over 24h = gap');
  assert.equal(classifyCell({ clockAgeHours: null }), 'IN_FLIGHT', 'unmeasurable clock never counts as a GAP');
  assert.equal(classifyCell({ noReviewExpected: true, suppressed: true, clockAgeHours: 48 }), 'NO_REVIEW_EXPECTED', 'no-review-expected wins');
});

// --- B2: circuit-breaker state + rich semantics ---------------------------

test('classifyCell: circuitOpen converts a GAP to CIRCUIT_OPEN, never an IN_FLIGHT cell', () => {
  assert.equal(classifyCell({ clockAgeHours: 48, circuitOpen: true }), 'CIRCUIT_OPEN',
    'grace spent + breaker open → CIRCUIT_OPEN, not GAP');
  assert.equal(classifyCell({ clockAgeHours: 5, circuitOpen: true }), 'IN_FLIGHT',
    'inside grace the breaker must NOT hide the cell — that is the cheap-fix window');
  assert.equal(classifyCell({ clockAgeHours: null, circuitOpen: true }), 'IN_FLIGHT',
    'unmeasurable clock still wins — no SLA claim without a clock');
  assert.equal(classifyCell({ clockAgeHours: 48, circuitOpen: false }), 'GAP',
    'breaker closed → unchanged pre-B2 behavior');
  assert.equal(classifyCell({ clockAgeHours: 48 }), 'GAP',
    'circuitOpen omitted entirely → unchanged pre-B2 behavior');
});

test('classifyCell: higher-precedence exclusions beat the breaker', () => {
  assert.equal(classifyCell({ noReviewExpected: true, clockAgeHours: 99, circuitOpen: true }), 'NO_REVIEW_EXPECTED');
  assert.equal(classifyCell({ suppressed: true, clockAgeHours: 99, circuitOpen: true }), 'SUPPRESSED',
    'a hardcoded CI-unfetchable outlet keeps its more specific reason');
});

test('isActionableState: only GAP may drive a fetch/dispatch', () => {
  assert.equal(isActionableState('GAP'), true);
  assert.equal(isActionableState('IN_FLIGHT'), false, 'waiting, not actionable');
  assert.equal(isActionableState('CIRCUIT_OPEN'), false, 'the whole point — no more spend');
  assert.equal(isActionableState('SUPPRESSED'), false);
  assert.equal(isActionableState('NO_REVIEW_EXPECTED'), false);
  assert.equal(isActionableState('NONSENSE'), false, 'unknown state is never actionable (fail closed)');
});

test('classifyCellDetailed: disposition + reason enum + SLA clock survives unactionable states', () => {
  const gap = classifyCellDetailed({ clockAgeHours: 48.4 });
  assert.deepEqual(
    { s: gap.state, d: gap.disposition, r: gap.reason, a: gap.actionable, c: gap.slaClockHours },
    { s: 'GAP', d: 'actionable', r: 'sla-breach', a: true, c: 48 });

  const broken = classifyCellDetailed({ clockAgeHours: 400, circuitOpen: true, attempts: 3, nextEligibleAt: '2026-08-01T00:00:00.000Z' });
  assert.equal(broken.state, 'CIRCUIT_OPEN');
  assert.equal(broken.disposition, 'unactionable');
  assert.equal(broken.reason, 'outlet-circuit-open');
  assert.equal(broken.actionable, false);
  assert.equal(broken.slaClockHours, 400, 'clock keeps running even when we stop trying');
  assert.equal(broken.attempts, 3);
  assert.equal(broken.nextEligibleAt, '2026-08-01T00:00:00.000Z');

  const excluded = classifyCellDetailed({ noReviewExpected: true, clockAgeHours: 99 });
  assert.equal(excluded.disposition, 'excluded');
  assert.equal(excluded.reason, 'outlet-skips-market');

  const flight = classifyCellDetailed({ clockAgeHours: null });
  assert.equal(flight.disposition, 'waiting');
  assert.equal(flight.reason, 'within-grace');
  assert.equal(flight.slaClockHours, null, 'no clock → no fabricated age');
  assert.equal(flight.attempts, 0);
});

test('mergeLedger carries a CIRCUIT_OPEN cell and preserves its original firstSeenAt', () => {
  // Regression guard for the breaker's whole value: when a GAP flips to
  // CIRCUIT_OPEN the age must NOT reset, or "NYT stuck 400h" silently becomes
  // "NYT stuck 0h" the moment we stop retrying it.
  const prev = { shows: { s: { title: 'S', market: 'broadway', cells: {
    nytimes: { state: 'GAP', firstSeenAt: '2026-06-01T00:00:00.000Z' } } } } };
  const fresh = [{ showId: 's', title: 'S', market: 'broadway',
    cells: [{ outletId: 'nytimes', state: 'CIRCUIT_OPEN' }] }];
  const merged = mergeLedger(prev, fresh, '2026-07-30T00:00:00.000Z');
  assert.equal(merged.shows.s.cells.nytimes.state, 'CIRCUIT_OPEN');
  assert.equal(merged.shows.s.cells.nytimes.firstSeenAt, '2026-06-01T00:00:00.000Z', 'age preserved across the flip');
});

test('mergeLedger preserves firstSeenAt for an existing gap; stamps new ones', () => {
  const prev = { shows: { 'show-a': { title: 'A', market: 'broadway', openingDate: '2026-01-01',
    cells: { newsday: { state: 'GAP', firstSeenAt: '2026-01-02T00:00:00.000Z' } } } } };
  const fresh = [{ showId: 'show-a', title: 'A', market: 'broadway', openingDate: '2026-01-01',
    cells: [
      { outletId: 'newsday', state: 'GAP', url: 'u' },   // pre-existing gap
      { outletId: 'broadwaynews', state: 'GAP' },          // brand-new gap
    ] }];
  const merged = mergeLedger(prev, fresh, '2026-07-22T00:00:00.000Z');
  assert.equal(merged.shows['show-a'].cells.newsday.firstSeenAt, '2026-01-02T00:00:00.000Z', 'preserved');
  assert.equal(merged.shows['show-a'].cells.broadwaynews.firstSeenAt, '2026-07-22T00:00:00.000Z', 'new stamp');
  assert.equal(merged.shows['show-a'].cells.newsday.url, 'u');
});

test('mergeLedger drops cells no longer present (gap closed)', () => {
  const prev = { shows: { 's': { title: 'S', market: 'broadway', cells: {
    newsday: { state: 'GAP', firstSeenAt: 'x' }, ap: { state: 'GAP', firstSeenAt: 'y' } } } } };
  const fresh = [{ showId: 's', title: 'S', market: 'broadway', cells: [{ outletId: 'newsday', state: 'GAP' }] }];
  const merged = mergeLedger(prev, fresh, 'now');
  assert.deepEqual(Object.keys(merged.shows.s.cells), ['newsday'], 'ap gap closed → dropped');
});

test('a show with no cells is omitted entirely', () => {
  const merged = mergeLedger({}, [{ showId: 's', title: 'S', market: 'broadway', cells: [] }], 'now');
  assert.deepEqual(merged.shows, {});
});

test('serializeLedger is deterministic — key order does not change the bytes', () => {
  const a = { shows: { b: { market: 'broadway', title: 'B', cells: { z: { state: 'GAP', firstSeenAt: 't' }, a: { state: 'IN_FLIGHT', firstSeenAt: 't' } } }, a: { title: 'A', market: 'broadway', cells: {} } } };
  // Same content, different insertion order.
  const b = { shows: { a: { title: 'A', market: 'broadway', cells: {} }, b: { title: 'B', market: 'broadway', cells: { a: { firstSeenAt: 't', state: 'IN_FLIGHT' }, z: { firstSeenAt: 't', state: 'GAP' } } } } };
  assert.equal(serializeLedger(a), serializeLedger(b), 'byte-identical regardless of key order');
});

test('re-merging a serialized ledger with the SAME fresh cells is a fixed point (no diff)', () => {
  const fresh = [{ showId: 's', title: 'S', market: 'broadway', openingDate: '2026-01-01',
    cells: [{ outletId: 'newsday', state: 'GAP', url: 'u' }] }];
  const run1 = mergeLedger({}, fresh, '2026-07-22T10:00:00.000Z');
  const bytes1 = serializeLedger(run1);
  // Second run: prior = run1, a LATER nowIso — but the existing cell keeps its firstSeenAt.
  const run2 = mergeLedger(run1, fresh, '2026-07-22T11:00:00.000Z');
  assert.equal(serializeLedger(run2), bytes1, 'consecutive runs on unchanged data produce no diff');
});


// --- BRO-89: dispatch-storm tier-scoping (computeDispatchDecision) ---
//
// Failure mode that shipped in T1-retrieval Sprint 2 and was caught by a later
// two-model ship-check against live code: censusMissing (the hard, roundup-named
// bucket) counted EVERY tier, so a show with 3+ unscored T3 blogs and no real
// T1/T2 gap still went `dispatchable` + `severity:'major'` and re-fired a FULL
// gather+collect every audit run. Only registered T1/T2 outlets may drive a
// fetch or escalate severity.

const DISPATCH_OUTLETS = {
  nytimes: { tier: 1, displayName: 'The New York Times' },
  nypost: { tier: 2, displayName: 'New York Post' },
  variety: { tier: 1, displayName: 'Variety' },
  // Three REGISTERED T3 blogs (they have a tier, they are just not
  // dispatch-tier). Registered and phantom are separate cases and each needs
  // its own fixture -- an unregistered id would exercise the phantom path
  // below instead of the registered-T3 path this fixture is here to cover.
  'some-blog': { tier: 3, displayName: 'Some Blog' },
  'another-blog': { tier: 3, displayName: 'Another Blog' },
  'third-blog': { tier: 3, displayName: 'Third Blog' },
};

test('computeDispatchDecision: isTripped is required, and its absence throws at the call', () => {
  assert.throws(
    () => computeDispatchDecision({ censusMissing: ['nytimes'], outlets: DISPATCH_OUTLETS }),
    /isTripped is required/,
    'omitting the breaker must fail loudly, not silently re-enable dispatch for every circuit-open outlet',
  );
  // The dangerous shape: with no T1/T2 gap the filter callback never runs, so a
  // missing isTripped would go unnoticed until the first show that has one.
  assert.throws(
    () => computeDispatchDecision({ censusMissing: [], outlets: DISPATCH_OUTLETS }),
    /isTripped is required/,
    'must throw even when there is no gap to test the breaker against',
  );
});

test('dispatch storm: 3+ registered T3 census-missing outlets alone must NOT make a show dispatchable or major', () => {
  const censusMissing = ['some-blog', 'another-blog', 'third-blog'];
  const { censusMissingT12, dispatchable, severity } = computeDispatchDecision({ censusMissing, outlets: DISPATCH_OUTLETS, isTripped: () => false });
  assert.deepEqual(censusMissingT12, [], 'no T1/T2 outlet is missing -- three registered T3 blogs and nothing else');
  assert.equal(dispatchable, false, 'a T3-only census gap must never re-fire a gather (the storm)');
  assert.equal(severity, 'minor', 'T3 volume alone must never escalate to major');
});

test('dispatch storm: phantom (completely unregistered) outletIds are excluded from tier counting without throwing', () => {
  const censusMissing = ['phantom-outlet-1', 'phantom-outlet-2', 'phantom-outlet-3', 'variety'];
  assert.doesNotThrow(() => computeDispatchDecision({ censusMissing, outlets: DISPATCH_OUTLETS, isTripped: () => false }));
  const { censusMissingT12, censusMissingActionable, dispatchable, severity } =
    computeDispatchDecision({ censusMissing, outlets: DISPATCH_OUTLETS, isTripped: () => false });
  assert.deepEqual(censusMissingT12, ['variety'], 'phantom outletIds (undefined tier) must not count as T1/T2');
  assert.deepEqual(censusMissingActionable, ['variety']);
  assert.equal(dispatchable, true, 'the one real T1 gap must still be dispatchable');
  assert.equal(severity, 'minor', 'a single actionable miss stays minor regardless of phantom-outlet count');
});

test('dispatch storm: 3+ real T1/T2 misses correctly escalate to dispatchable + major', () => {
  const censusMissing = ['nytimes', 'nypost', 'variety', 'some-blog'];
  const { censusMissingT12, dispatchable, severity } = computeDispatchDecision({ censusMissing, outlets: DISPATCH_OUTLETS, isTripped: () => false });
  assert.deepEqual(censusMissingT12.sort(), ['nypost', 'nytimes', 'variety']);
  assert.equal(dispatchable, true);
  assert.equal(severity, 'major', '3 actionable T1/T2 misses must still escalate');
});

test('dispatch storm: a circuit-open T1/T2 outlet is visible in censusMissingT12 but excluded from dispatchable/severity', () => {
  const censusMissing = ['nytimes', 'nypost', 'variety'];
  const { censusMissingT12, circuitOpenIds, censusMissingActionable, dispatchable, severity } = computeDispatchDecision({
    censusMissing, outlets: DISPATCH_OUTLETS, isTripped: (id) => id === 'nytimes',
  });
  assert.deepEqual(censusMissingT12.sort(), ['nypost', 'nytimes', 'variety'], 'tripped outlet stays visible');
  assert.deepEqual(circuitOpenIds, ['nytimes']);
  assert.deepEqual(censusMissingActionable.sort(), ['nypost', 'variety']);
  assert.equal(dispatchable, true, 'the other two non-tripped T1/T2 misses still make it dispatchable');
  assert.equal(severity, 'minor', 'only 2 actionable misses -- below the major threshold once the tripped outlet is excluded');
});

test('dispatch storm: a broken census extractor escalates to major even with zero actionable misses', () => {
  const { dispatchable, severity } = computeDispatchDecision({
    censusMissing: [], outlets: DISPATCH_OUTLETS, censusExtractorBroken: true, isTripped: () => false,
  });
  assert.equal(dispatchable, false, 'no actionable outlet to fetch -- extractor breakage alone must not storm-dispatch');
  assert.equal(severity, 'major', 'a broken extractor is still alert-worthy at major severity');
});
