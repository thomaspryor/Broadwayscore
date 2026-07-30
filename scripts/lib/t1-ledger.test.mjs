import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyCell, classifyCellDetailed, isActionableState, mergeLedger, serializeLedger, isDispatchTierOutlet } = require('./t1-ledger.js');

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
