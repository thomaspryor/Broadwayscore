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
