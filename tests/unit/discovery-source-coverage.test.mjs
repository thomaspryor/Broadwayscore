// Tests for scripts/lib/discovery-source-coverage.js's pure decision
// function (card #1445). Guards against the TodayTix-only-for-months
// incident: a source contributing 0 candidates for consecutive runs must
// be flagged, not silently absorbed by a catch block.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { computeNextState, ZERO_STREAK_ALERT_THRESHOLD } = require('../../scripts/lib/discovery-source-coverage.js');

test('first run with a non-zero count starts a clean streak', () => {
  const { nextState, silentSources } = computeNextState(null, { todaytix: 44 }, '2026-08-13T00:00:00.000Z');
  assert.equal(nextState.sources.todaytix.lastCount, 44);
  assert.equal(nextState.sources.todaytix.zeroStreak, 0);
  assert.equal(nextState.sources.todaytix.totalRuns, 1);
  assert.equal(nextState.sources.todaytix.lastNonZeroAt, '2026-08-13T00:00:00.000Z');
  assert.deepEqual(silentSources, []);
});

test('a single zero run does not alert (threshold is consecutive, not one-shot)', () => {
  const { nextState, silentSources } = computeNextState(null, { playbillBroadway: 0 }, '2026-08-13T00:00:00.000Z');
  assert.equal(nextState.sources.playbillBroadway.zeroStreak, 1);
  assert.equal(silentSources.length, 0);
});

test('consecutive zero runs accumulate a streak and cross the alert threshold', () => {
  let state = null;
  const days = ['2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13'];
  let silentSources = [];
  for (const day of days) {
    ({ nextState: state, silentSources } = computeNextState(state, { todaytix: 0 }, `${day}T00:00:00.000Z`));
  }
  assert.equal(state.sources.todaytix.zeroStreak, days.length);
  assert.ok(days.length >= ZERO_STREAK_ALERT_THRESHOLD);
  assert.equal(silentSources.length, 1);
  assert.equal(silentSources[0].name, 'todaytix');
  assert.equal(silentSources[0].zeroStreak, days.length);
});

test('a non-zero run resets an existing zero streak to 0', () => {
  let state = null;
  ({ nextState: state } = computeNextState(state, { obVenueListings: 0 }, '2026-08-11T00:00:00.000Z'));
  ({ nextState: state } = computeNextState(state, { obVenueListings: 0 }, '2026-08-12T00:00:00.000Z'));
  ({ nextState: state } = computeNextState(state, { obVenueListings: 5 }, '2026-08-13T00:00:00.000Z'));
  assert.equal(state.sources.obVenueListings.zeroStreak, 0);
  assert.equal(state.sources.obVenueListings.lastNonZeroAt, '2026-08-13T00:00:00.000Z');
  assert.equal(state.sources.obVenueListings.totalRuns, 3);
});

test('sources are tracked independently — one going silent does not affect another', () => {
  let state = null;
  for (let i = 0; i < ZERO_STREAK_ALERT_THRESHOLD; i++) {
    ({ nextState: state } = computeNextState(state, { todaytix: 40, playbillBroadway: 0 }, `2026-08-1${i}T00:00:00.000Z`));
  }
  const { silentSources } = computeNextState(state, { todaytix: 40, playbillBroadway: 0 }, '2026-08-20T00:00:00.000Z');
  assert.equal(silentSources.length, 1);
  assert.equal(silentSources[0].name, 'playbillBroadway');
});

test('a source absent from this run\'s sourceCounts is left untouched (not run this pass, e.g. WE flags off)', () => {
  let state = null;
  ({ nextState: state } = computeNextState(state, { todaytix: 40, todaytixWE: 60 }, '2026-08-10T00:00:00.000Z'));
  ({ nextState: state } = computeNextState(state, { todaytix: 42 }, '2026-08-11T00:00:00.000Z'));
  assert.equal(state.sources.todaytixWE.totalRuns, 1);
  assert.equal(state.sources.todaytixWE.zeroStreak, 0);
  assert.equal(state.sources.todaytix.totalRuns, 2);
});
