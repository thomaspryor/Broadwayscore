/**
 * BRO-177: broadwayOpenings() rendered its card stack in shows.json insertion
 * order with no sort, while the subject/lede picks the week's biggest BW
 * opening via newsworthiness.mjs's gold-tier bump — a gold-tier show could
 * open the same week as a non-gold show and render SECOND even though the
 * subject/lede named it first (the same bug class fixed for WE in
 * londonSection(), 2026-08-02: subject said Tao of Glass, cards led with
 * Brainiac Live).
 *
 * generate.mjs's broadwayOpenings() now sorts its events with
 * compareOpeningStories() (scripts/lib/opening-story-order.js) before
 * rendering — this test locks that comparator's behavior in directly (per
 * CLAUDE.md §15: require() the real function, never copy its logic into the
 * test) so a future edit to the comparator can't silently reintroduce the
 * mismatch.
 *
 * Run: node --test tests/unit/broadwayOpenings-sort.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { compareOpeningStories, sortOpeningStoriesByNewsworthiness, isGoldScore } =
  require('../../scripts/lib/opening-story-order.js');

const GOLD_MIN = 83; // matches newsworthiness.mjs's SCORE_GOLD_MIN_NYC / generate.mjs's SCORE_GOLD_MIN_BROADWAY

test('a gold-tier opening sorts ahead of a non-gold opening regardless of insertion order', () => {
  const events = [
    { show: { id: 'brainiac-live-2026' }, agg: { avg: 74, raw: 74.2, count: 6 } }, // non-gold, appeared first in shows.json
    { show: { id: 'tao-of-glass-2026' }, agg: { avg: 88, raw: 88.4, count: 9 } },  // gold, appeared second
  ];
  const sorted = sortOpeningStoriesByNewsworthiness(events, e => e.agg, GOLD_MIN);
  assert.equal(sorted[0].show.id, 'tao-of-glass-2026', 'gold-tier opening must lead the card stack');
  assert.equal(sorted[1].show.id, 'brainiac-live-2026');
});

test('within the same tier, higher raw score sorts first', () => {
  const events = [
    { show: { id: 'lower-score' }, agg: { avg: 70, raw: 70.1, count: 5 } },
    { show: { id: 'higher-score' }, agg: { avg: 78, raw: 78.9, count: 5 } },
  ];
  const sorted = sortOpeningStoriesByNewsworthiness(events, e => e.agg, GOLD_MIN);
  assert.equal(sorted[0].show.id, 'higher-score');
});

test('when displayed (rounded) scores tie, more reviews sorts first', () => {
  const events = [
    { show: { id: 'fewer-reviews' }, agg: { avg: 64, raw: 63.6, count: 5 } },
    { show: { id: 'more-reviews' }, agg: { avg: 64, raw: 63.6, count: 18 } },
  ];
  const sorted = sortOpeningStoriesByNewsworthiness(events, e => e.agg, GOLD_MIN);
  assert.equal(sorted[0].show.id, 'more-reviews');
});

test('two gold-tier openings still rank by score, not insertion order', () => {
  const events = [
    { show: { id: 'lower-gold' }, agg: { avg: 84, raw: 84.1, count: 10 } },
    { show: { id: 'higher-gold' }, agg: { avg: 91, raw: 91.3, count: 12 } },
  ];
  const sorted = sortOpeningStoriesByNewsworthiness(events, e => e.agg, GOLD_MIN);
  assert.equal(sorted[0].show.id, 'higher-gold');
});

test('compareOpeningStories treats a missing aggregate as non-gold and lowest-ranked', () => {
  const gold = { avg: 90, raw: 90, count: 8 };
  assert.ok(compareOpeningStories(gold, null, GOLD_MIN) < 0, 'gold show must sort before a missing aggregate');
  assert.ok(compareOpeningStories(null, gold, GOLD_MIN) > 0);
});

test('isGoldScore respects the caller-supplied threshold', () => {
  assert.equal(isGoldScore(83, 83), true);
  assert.equal(isGoldScore(82.9, 83), false);
  assert.equal(isGoldScore(null, 83), false);
});
