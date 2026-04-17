import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeLatencyStats, median, percentile } = require('../../scripts/opening-night-latency-report.js');

const MS_MIN = 60 * 1000;

// Build a synthetic JSONL-style entry array
function makeEntries({ showId, reviewKey, firstSeen, collected, scored, rebuilt, deployed }) {
  const entries = [];
  if (firstSeen) entries.push({ showId, reviewKey, stage: 'review-first-seen', at: firstSeen });
  if (collected) entries.push({ showId, reviewKey, stage: 'review-text-collected', at: collected });
  if (scored)    entries.push({ showId, reviewKey, stage: 'scored', at: scored });
  if (rebuilt)   entries.push({ showId, stage: 'rebuilt', reviewKey: null, at: rebuilt, metadata: { reviewCount: 3 } });
  if (deployed)  entries.push({ showId: null, stage: 'deployed-live', reviewKey: null, at: deployed, metadata: { runId: 'run-1' } });
  return entries;
}

test('computeLatencyStats: single review end-to-end', () => {
  const base = new Date('2026-04-15T22:00:00Z');
  const entries = makeEntries({
    showId: 'show-a', reviewKey: 'nytimes:brantley:https://x.com',
    firstSeen: new Date(base.getTime() + 0).toISOString(),
    collected: new Date(base.getTime() + 5 * MS_MIN).toISOString(),
    scored:    new Date(base.getTime() + 10 * MS_MIN).toISOString(),
    rebuilt:   new Date(base.getTime() + 12 * MS_MIN).toISOString(),
    deployed:  new Date(base.getTime() + 14 * MS_MIN).toISOString(),
  });

  const shows = computeLatencyStats(entries);
  assert.equal(shows.length, 1);
  const s = shows[0];
  assert.equal(s.showId, 'show-a');
  assert.ok(s.median_e2e_ms !== null, 'median_e2e_ms should exist');
  assert.ok(s.median_e2e_ms > 13 * MS_MIN, 'e2e should be ~14 min');
  assert.equal(s.reviews_over_15min, 0, 'under 15 min');
  assert.equal(s.reviews_over_60min, 0);
  assert.ok(s.per_stage_median_ms['first-seen-to-collected'] !== null);
});

test('computeLatencyStats: review over 15 min is flagged', () => {
  const base = new Date('2026-04-15T22:00:00Z');
  const entries = makeEntries({
    showId: 'show-b', reviewKey: 'guardian:akbar:https://g.com',
    firstSeen: new Date(base.getTime() + 0).toISOString(),
    collected: new Date(base.getTime() + 5 * MS_MIN).toISOString(),
    scored:    new Date(base.getTime() + 20 * MS_MIN).toISOString(),
    rebuilt:   null,
    deployed:  new Date(base.getTime() + 25 * MS_MIN).toISOString(),
  });

  const shows = computeLatencyStats(entries);
  const s = shows[0];
  assert.equal(s.reviews_over_15min, 1);
  assert.equal(s.reviews_over_60min, 0);
});

test('computeLatencyStats: showFilter filters correctly', () => {
  const base = new Date('2026-04-15T22:00:00Z');
  const entriesA = makeEntries({
    showId: 'show-a', reviewKey: 'nytimes:brantley:https://x.com',
    firstSeen: new Date(base.getTime()).toISOString(),
    deployed: new Date(base.getTime() + 10 * MS_MIN).toISOString(),
  });
  const entriesB = makeEntries({
    showId: 'show-b', reviewKey: 'guardian:akbar:https://g.com',
    firstSeen: new Date(base.getTime()).toISOString(),
    deployed: new Date(base.getTime() + 20 * MS_MIN).toISOString(),
  });

  const all = computeLatencyStats([...entriesA, ...entriesB]);
  assert.equal(all.length, 2);

  const filtered = computeLatencyStats([...entriesA, ...entriesB], { showFilter: 'show-a' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].showId, 'show-a');
});

test('median and percentile helpers', () => {
  assert.equal(median([1, 2, 3, 4, 5]), 3);
  assert.equal(median([1, 2]), 1.5);
  assert.equal(median([]), null);
  assert.equal(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90), 90);
  assert.equal(percentile([], 90), null);
});
