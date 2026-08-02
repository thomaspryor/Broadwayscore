import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DEFAULT_ESCALATE_AFTER_DAYS, updateStaleStreaks } = require('./cron-stale-streak.js');

test('a first-time stale cron starts at 1 and does not escalate', () => {
  const r = updateStaleStreaks(null, ['Opening Night Orchestrator']);
  assert.equal(r.staleStreak['Opening Night Orchestrator'], 1);
  assert.deepEqual(r.escalate, []);
});

test('escalation fires on the third consecutive stale check, not before', () => {
  let state = { staleStreak: {} };
  const names = ['Sweep WE Aggregators'];
  for (let day = 1; day <= 2; day += 1) {
    const r = updateStaleStreaks(state, names);
    assert.deepEqual(r.escalate, [], `should not escalate on day ${day}`);
    state = { staleStreak: r.staleStreak };
  }
  const third = updateStaleStreaks(state, names);
  assert.equal(third.staleStreak['Sweep WE Aggregators'], DEFAULT_ESCALATE_AFTER_DAYS);
  assert.deepEqual(third.escalate, ['Sweep WE Aggregators']);
});

test('an entry stale past the boundary stays eligible (router handles repeats)', () => {
  const r = updateStaleStreaks({ staleStreak: { A: 10 } }, ['A']);
  assert.equal(r.staleStreak.A, 11);
  assert.deepEqual(r.escalate, ['A']);
});

test('recovery clears the streak so the NEXT outage restarts at 1', () => {
  const recovered = updateStaleStreaks({ staleStreak: { A: 5, B: 1 } }, ['B']);
  assert.deepEqual(recovered.recovered, ['A']);
  assert.equal(recovered.staleStreak.A, undefined);

  const relapse = updateStaleStreaks({ staleStreak: recovered.staleStreak }, ['A']);
  assert.equal(relapse.staleStreak.A, 1, 'a recovered cron must not escalate instantly on relapse');
  assert.deepEqual(relapse.escalate, []);
});

test('a state file written before staleStreak existed does not over-escalate', () => {
  // Legacy shape: a `stale` array, no streak map. Seeding a streak from it
  // would be a guess about duration; starting at 1 is the honest answer.
  const legacy = { stale: ['A', 'B'], redispatched: [], updatedAt: '2026-08-01T12:00:00Z' };
  const r = updateStaleStreaks(legacy, ['A', 'B']);
  assert.deepEqual(r.escalate, []);
  assert.equal(r.staleStreak.A, 1);
});

test('empty / duplicate / whitespace names are normalised away', () => {
  const r = updateStaleStreaks({ staleStreak: {} }, ['  A  ', 'A', '', '   ', 'B']);
  assert.deepEqual(Object.keys(r.staleStreak).sort(), ['A', 'B']);
  assert.equal(r.staleStreak.A, 1);
});

test('an all-clear check clears every streak and escalates nothing', () => {
  const r = updateStaleStreaks({ staleStreak: { A: 9, B: 4 } }, []);
  assert.deepEqual(r.staleStreak, {});
  assert.deepEqual(r.escalate, []);
  assert.deepEqual(r.recovered, ['A', 'B']);
});

test('the escalation boundary is configurable', () => {
  const r = updateStaleStreaks({ staleStreak: { A: 1 } }, ['A'], { escalateAfterDays: 2 });
  assert.deepEqual(r.escalate, ['A']);
});
