import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  showsNeedingGather,
  showsNeedingAggregatorGather,
  POLLER_MAX_AGE_MS,
} = require('../../scripts/lib/gather-idempotency.js');

const NOW = Date.parse('2026-10-03T12:00:00Z');
const poller = (suffix, status = 'in_progress', ageMin = 5) => ({
  status,
  displayTitle: `Opening Night Poller — ${suffix}`,
  createdAt: new Date(NOW - ageMin * 60000).toISOString(),
});

test('aggregators-only gather skips a show with an in-flight TARGETED poller', () => {
  const out = showsNeedingAggregatorGather([], [poller('a-2026')], ['a-2026', 'b-2026'], { now: NOW });
  assert.deepEqual(out, ['b-2026']);
});

test('queued targeted poller also blocks; completed one does not', () => {
  assert.deepEqual(showsNeedingAggregatorGather([], [poller('a-2026', 'queued')], ['a-2026'], { now: NOW }), []);
  assert.deepEqual(showsNeedingAggregatorGather([], [poller('a-2026', 'completed')], ['a-2026'], { now: NOW }), ['a-2026']);
});

test('auto poller never blocks (would starve gather)', () => {
  assert.deepEqual(showsNeedingAggregatorGather([], [poller('auto')], ['a-2026'], { now: NOW }), ['a-2026']);
});

test('prefix collisions do not match', () => {
  assert.deepEqual(
    showsNeedingAggregatorGather([], [poller('the-bear-bites-back-2025')], ['the-bear-2025'], { now: NOW }),
    ['the-bear-2025'],
  );
});

test('stuck poller older than the job timeout stops blocking', () => {
  const stuck = poller('a-2026', 'in_progress', POLLER_MAX_AGE_MS / 60000 + 5);
  assert.deepEqual(showsNeedingAggregatorGather([], [stuck], ['a-2026'], { now: NOW }), ['a-2026']);
});

test('still dedups against active gather runs and fails open on bad poller input', () => {
  const gather = [{ status: 'in_progress', displayTitle: 'Gather Review Data — a-2026' }];
  assert.deepEqual(showsNeedingAggregatorGather(gather, [], ['a-2026', 'b-2026'], { now: NOW }), ['b-2026']);
  assert.deepEqual(showsNeedingAggregatorGather([], undefined, ['a-2026'], { now: NOW }), ['a-2026']);
});

test('a run with no createdAt is treated as fresh (blocks)', () => {
  const noTs = { status: 'in_progress', displayTitle: 'Opening Night Poller — a-2026' };
  assert.deepEqual(showsNeedingAggregatorGather([], [noTs], ['a-2026'], { now: NOW }), []);
});

test('poller queue wait counts toward age but stays inside the cap (healthy 75-min run queued 30 min still blocks)', () => {
  assert.deepEqual(showsNeedingAggregatorGather([], [poller('a-2026', 'in_progress', 105)], ['a-2026'], { now: NOW }), []);
});

test('FULL gather dedup ignores pollers: showsNeedingGather takes no poller input', () => {
  assert.equal(showsNeedingGather.length, 2);
  assert.deepEqual(showsNeedingGather([], ['a-2026']), ['a-2026']);
});

test('opening-night-reviews.yml wires the poller-aware helper into the aggregators-only guard only', () => {
  const yml = readFileSync(new URL('../../.github/workflows/opening-night-reviews.yml', import.meta.url), 'utf8');
  assert.match(yml, /showsNeedingAggregatorGather\(runs, pollers, want\)/);
  assert.match(yml, /--workflow=opening-night-poller\.yml --json status,displayTitle,createdAt/);
  const full = yml.match(/NEEDED_FULL=[\s\S]*?\n          '\)/)[0];
  assert.doesNotMatch(full, /showsNeedingAggregatorGather/);
});
