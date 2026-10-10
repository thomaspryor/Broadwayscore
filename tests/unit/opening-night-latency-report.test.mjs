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

test('negative e2e from clock skew is excluded from stats (not in median/p90)', () => {
  const base = new Date('2026-04-15T22:00:00Z');
  // deployed-live is BEFORE first-seen — clock skew
  const entries = makeEntries({
    showId: 'show-skew', reviewKey: 'nytimes:brantley:https://x.com',
    firstSeen: new Date(base.getTime() + 10 * MS_MIN).toISOString(),
    deployed: new Date(base.getTime() + 5 * MS_MIN).toISOString(), // before firstSeen
  });

  const shows = computeLatencyStats(entries);
  const s = shows[0];
  // Negative e2e should be excluded → no valid measurements → null stats
  assert.equal(s.median_e2e_ms, null, 'negative e2e should not enter median');
  assert.equal(s.p90_e2e_ms, null);
});

// --- Per-show rebuild resolution (task #388) ---------------------------------
// 'rebuilt' is never stamped per-reviewKey, so scored-to-rebuilt and
// rebuilt-to-deployed were always null. They now resolve from the show's own
// rebuild lines — and must NOT resolve from the run-level (showId-less) line,
// which says a rebuild happened but not which shows it covered.

test('per-stage gaps resolve rebuilt from the show\'s own rebuild lines', () => {
  const base = new Date('2026-08-08T20:00:00Z');
  const t = m => new Date(base.getTime() + m * MS_MIN).toISOString();
  const entries = [
    { showId: 'isla', reviewKey: 'nytimes:shaw:https://nyt/r', stage: 'review-first-seen', at: t(0) },
    { showId: 'isla', reviewKey: 'nytimes:shaw:https://nyt/r', stage: 'scored', at: t(4) },
    // A rebuild of this show BEFORE it was scored cannot have folded it in.
    { showId: 'isla', reviewKey: null, stage: 'rebuilt', at: t(2), metadata: { reviewCount: 1 } },
    { showId: 'isla', reviewKey: null, stage: 'rebuilt', at: t(7), metadata: { reviewCount: 2 } },
    { showId: null, reviewKey: null, stage: 'deployed-live', at: t(11), metadata: { runId: 'r1' } },
  ];

  const [s] = computeLatencyStats(entries);
  assert.equal(s.per_stage_median_ms['scored-to-rebuilt'], 3 * MS_MIN, 'scored +4 → rebuilt +7');
  assert.equal(s.per_stage_median_ms['rebuilt-to-deployed'], 4 * MS_MIN, 'rebuilt +7 → deployed +11');
  assert.equal(s.median_e2e_ms, 11 * MS_MIN);
});

test('the run-level rebuild line does not resolve a rebuilt time for a show', () => {
  const base = new Date('2026-08-08T20:00:00Z');
  const t = m => new Date(base.getTime() + m * MS_MIN).toISOString();
  const entries = [
    { showId: 'the-peculiar-patriot-off-broadway-2026', reviewKey: 'nytimes:shaw:https://nyt/r', stage: 'review-first-seen', at: t(0) },
    // Run-level only — this show has never had a rebuild of its own.
    { showId: null, reviewKey: null, stage: 'rebuilt', at: t(5), metadata: { scope: 'all-shows', showCount: 1210 } },
    { showId: null, reviewKey: null, stage: 'deployed-live', at: t(9), metadata: { runId: 'r1' } },
  ];

  const [s] = computeLatencyStats(entries);
  assert.equal(s.per_stage_median_ms['scored-to-rebuilt'], null, 'no show rebuild → no gap invented');
  assert.equal(s.per_stage_median_ms['rebuilt-to-deployed'], null);
});

test('--show=ID keeps the global deploy line so a scoped report still has its terminal', () => {
  const base = new Date('2026-08-08T20:00:00Z');
  const t = m => new Date(base.getTime() + m * MS_MIN).toISOString();
  const entries = [
    { showId: 'isla', reviewKey: 'nytimes:shaw:https://nyt/r', stage: 'review-first-seen', at: t(0) },
    { showId: 'other-show', reviewKey: 'var:x:https://v/r', stage: 'review-first-seen', at: t(0) },
    { showId: null, reviewKey: null, stage: 'deployed-live', at: t(6), metadata: { runId: 'r1' } },
  ];

  const shows = computeLatencyStats(entries, { showFilter: 'isla' });
  assert.equal(shows.length, 1);
  assert.equal(shows[0].showId, 'isla');
  assert.equal(shows[0].median_e2e_ms, 6 * MS_MIN, 'global deploy survives the --show filter');
});
