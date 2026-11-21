import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { promotionLatencies, slowHotSpanPromotions, median } = require('./pending-promotion-latency.js');

const shows = new Map([
  ['the-unbelievers-off-broadway-2026', { id: 'the-unbelievers-off-broadway-2026', openingDate: '2026-11-05', category: 'off-broadway' }],
  ['speculations-off-west-end-2026', { id: 'speculations-off-west-end-2026', openingDate: '2026-11-06', category: 'off-west-end' }],
]);

const rec = (showId, file, firstSeenAt, bylineExtractedAt, extra = {}) => ({
  showId, file, review: { bylineSource: 'replay-pending-bylines', firstSeenAt, bylineExtractedAt, outletId: file.split('--')[0], ...extra },
});

// The real BRO-7032 miss: found 03:39:59Z, promoted 04:33:43Z by the next run's pre-loop drain.
const unbelieversTM = rec('the-unbelievers-off-broadway-2026', 'theatermania--rachel-graham.json', '2026-11-06T03:39:59.227Z', '2026-11-06T04:33:43.591Z');

test('the Unbelievers TheaterMania strand (54 min, press-night hot span) is flagged slow', () => {
  const rows = promotionLatencies([unbelieversTM], shows);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].latencyMin, 54);
  assert.equal(rows[0].hotSpan, true);
  assert.deepEqual(slowHotSpanPromotions(rows).map((r) => r.file), ['theatermania--rachel-graham.json']);
});

test('a same-run promotion (in-loop drain) passes', () => {
  const rows = promotionLatencies([rec('the-unbelievers-off-broadway-2026', 'theatermania--x.json', '2026-11-06T03:39:59Z', '2026-11-06T03:44:10Z')], shows);
  assert.equal(rows[0].latencyMin, 4);
  assert.equal(slowHotSpanPromotions(rows).length, 0);
});

test('slow promotions outside the hot span (next morning) are reported but not failed', () => {
  const rows = promotionLatencies([rec('the-unbelievers-off-broadway-2026', 'talkinbroadway--y.json', '2026-11-06T15:40:00Z', '2026-11-06T22:36:00Z')], shows);
  assert.equal(rows[0].hotSpan, false);
  assert.equal(slowHotSpanPromotions(rows).length, 0);
});

test('--since excludes earlier finds; non-replay bylines and unknown shows are ignored', () => {
  const rows = promotionLatencies([
    unbelieversTM,
    rec('speculations-off-west-end-2026', 'times-uk--a.json', '2026-11-06T19:00:00Z', '2026-11-06T19:00:30Z'),
    rec('speculations-off-west-end-2026', 'guardian--b.json', '2026-11-06T19:00:00Z', '2026-11-06T21:00:00Z', { bylineSource: 'extractor' }),
    rec('no-such-show', 'x--c.json', '2026-11-06T19:00:00Z', '2026-11-06T21:00:00Z'),
  ], shows, { since: '2026-11-06T14:09:25Z' });
  assert.deepEqual(rows.map((r) => r.file), ['times-uk--a.json']);
});

test('the max-min budget is respected and median handles even/odd/empty', () => {
  const rows = promotionLatencies([unbelieversTM], shows);
  assert.equal(slowHotSpanPromotions(rows, 60).length, 0);
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 10]), 3);
});

const { hotSpanEvidence, strandedHotSpanStubs } = require('./pending-promotion-latency.js');

test('an untrustworthy discovery clock (firstSeenAt stamped at/after refetch) is neither slow nor evidence', () => {
  // Real shape: i-became-we theatermania had firstSeenAt 02:56 AFTER pendingRefetchedAt 02:37.
  const rows = promotionLatencies([
    rec('the-unbelievers-off-broadway-2026', 'a--x.json', '2026-11-06T03:39:59Z', '2026-11-06T05:40:00Z', { pendingRefetchedAt: '2026-11-06T03:39:59Z' }),
    rec('the-unbelievers-off-broadway-2026', 'b--y.json', '2026-11-06T03:56:00Z', '2026-11-06T03:37:00Z'),
  ], shows);
  assert.ok(rows.every((r) => r.unknownClock));
  assert.equal(slowHotSpanPromotions(rows).length, 0);
  assert.equal(hotSpanEvidence(rows).length, 0);
});

test('duplicates are skipped; the budget compares raw ms (45.4 min is slow at 45)', () => {
  const rows = promotionLatencies([
    rec('the-unbelievers-off-broadway-2026', 'dup--x.json', '2026-11-06T03:00:00Z', '2026-11-06T05:00:00Z', { duplicateOf: 'tm--a.json' }),
    rec('the-unbelievers-off-broadway-2026', 'tm--z.json', '2026-11-06T03:00:00Z', '2026-11-06T03:45:24Z'),
  ], shows);
  assert.deepEqual(rows.map((r) => r.file), ['tm--z.json']);
  assert.equal(slowHotSpanPromotions(rows, 45).length, 1);
});

test('stranded hot-span stubs are listed once older than the budget', () => {
  const pending = [
    { showId: 'the-unbelievers-off-broadway-2026', file: 'theatermania--3bc71485.json', review: { firstSeenAt: '2026-11-06T03:39:59Z' } },
    { showId: 'the-unbelievers-off-broadway-2026', file: 'blog--q.json', review: { firstSeenAt: '2026-11-07T15:00:00Z' } },
  ];
  assert.equal(strandedHotSpanStubs(pending, shows, { now: new Date('2026-11-06T04:00:00Z') }).length, 0);
  const late = strandedHotSpanStubs(pending, shows, { now: new Date('2026-11-06T04:33:00Z') });
  assert.deepEqual(late.map((s) => [s.file, s.waitingMin]), [['theatermania--3bc71485.json', 53]]);
});
