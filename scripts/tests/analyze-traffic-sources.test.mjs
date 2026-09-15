import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { weekStart, median, bucketWeekly, detectSpikes, allWeeks } = require('../analyze-traffic-sources.js');

test('weekStart maps any day to its ISO Monday, for both GA4 and ISO date formats', () => {
  assert.equal(weekStart('20260915'), '2026-09-14'); // Tue → Mon
  assert.equal(weekStart('2026-09-14'), '2026-09-14'); // Mon stays
  assert.equal(weekStart('2026-09-20'), '2026-09-14'); // Sun belongs to the prior Monday
  assert.equal(weekStart('2026-01-01'), '2025-12-29'); // year boundary
});

test('median handles empty, odd and even lengths', () => {
  assert.equal(median([]), 0);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([1, 2, 3, 4]), 2.5);
});

test('allWeeks lists every Monday from the start week through the end week', () => {
  const w = allWeeks('2026-09-01', '2026-09-15');
  assert.deepEqual(w, ['2026-08-31', '2026-09-07', '2026-09-14']);
});

test('bucketWeekly sums daily rows into per-key ISO weeks', () => {
  const s = bucketWeekly([
    { date: '20260907', key: 'google', value: 10 },
    { date: '20260909', key: 'google', value: 5 },
    { date: '20260914', key: 'google', value: 7 },
    { date: '20260908', key: 'reddit.com', value: 2 },
  ]);
  assert.deepEqual(s, {
    google: { '2026-09-07': 15, '2026-09-14': 7 },
    'reddit.com': { '2026-09-07': 2 },
  });
});

test('detectSpikes flags a brand-new source and a 3x jump, ignores the current partial week', () => {
  const weeks = ['2026-08-17', '2026-08-24', '2026-08-31', '2026-09-07', '2026-09-14'];
  const series = {
    steady: { '2026-08-17': 100, '2026-08-24': 110, '2026-08-31': 95, '2026-09-07': 105, '2026-09-14': 40 },
    jump: { '2026-08-17': 20, '2026-08-24': 25, '2026-08-31': 90, '2026-09-07': 30, '2026-09-14': 5 },
    brandNew: { '2026-09-07': 60, '2026-09-14': 400 },
    tiny: { '2026-08-17': 1, '2026-09-07': 9 },
  };
  const spikes = detectSpikes(series, weeks, { minAbs: 30, ratio: 3, currentWeek: '2026-09-14' });
  const keys = spikes.map((s) => `${s.key}@${s.week}`);
  assert.deepEqual(keys.sort(), ['brandNew@2026-09-07', 'jump@2026-08-31']);
  const j = spikes.find((s) => s.key === 'jump');
  assert.equal(j.priorMedian, 22.5);
  assert.equal(j.multiple, 4);
  assert.equal(j.next, 30);
  const n = spikes.find((s) => s.key === 'brandNew');
  assert.equal(n.isNew, true);
  assert.equal(n.multiple, null);
  // The 400 in the current week is never reported as a spike.
  assert.ok(!keys.includes('brandNew@2026-09-14'));
});

test('detectSpikes treats missing weeks as zero rather than skipping them', () => {
  const weeks = ['2026-08-24', '2026-08-31', '2026-09-07'];
  const series = { flaky: { '2026-08-24': 50, '2026-09-07': 50 } };
  // Prior weeks [50, 0] → median 25, 50 is only 2x → no spike.
  assert.deepEqual(detectSpikes(series, weeks, { minAbs: 30, ratio: 3 }), []);
});
