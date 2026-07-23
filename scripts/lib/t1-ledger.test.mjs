import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyCell, mergeLedger, serializeLedger } = require('./t1-ledger.js');

test('classifyCell: state machine', () => {
  assert.equal(classifyCell({ noReviewExpected: true, suppressed: false, clockAgeHours: 100 }), 'NO_REVIEW_EXPECTED');
  assert.equal(classifyCell({ suppressed: true, clockAgeHours: 100 }), 'SUPPRESSED');
  assert.equal(classifyCell({ clockAgeHours: 5 }), 'IN_FLIGHT', 'under 24h = in flight');
  assert.equal(classifyCell({ clockAgeHours: 48 }), 'GAP', 'over 24h = gap');
  assert.equal(classifyCell({ clockAgeHours: null }), 'IN_FLIGHT', 'unmeasurable clock never counts as a GAP');
  assert.equal(classifyCell({ noReviewExpected: true, suppressed: true, clockAgeHours: 48 }), 'NO_REVIEW_EXPECTED', 'no-review-expected wins');
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
