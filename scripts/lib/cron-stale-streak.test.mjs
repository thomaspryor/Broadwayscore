import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DEFAULT_ESCALATE_AFTER_DAYS, updateStaleStreaks } = require('./cron-stale-streak.js');

/** Streak entry shorthand for building prior state in tests. */
const at = (days, lastCounted) => ({ days, lastCounted });

test('a first-time stale cron starts at 1 and does not escalate', () => {
  const r = updateStaleStreaks(null, ['Opening Night Orchestrator'], { today: '2026-08-01' });
  assert.equal(r.staleStreak['Opening Night Orchestrator'].days, 1);
  assert.deepEqual(r.escalate, []);
});

test('escalation fires on the third consecutive stale DAY, not before', () => {
  let state = { staleStreak: {} };
  const names = ['Sweep WE Aggregators'];
  const days = ['2026-08-01', '2026-08-02', '2026-08-03'];
  for (const today of days.slice(0, 2)) {
    const r = updateStaleStreaks(state, names, { today });
    assert.deepEqual(r.escalate, [], `should not escalate on ${today}`);
    state = { staleStreak: r.staleStreak };
  }
  const third = updateStaleStreaks(state, names, { today: days[2] });
  assert.equal(third.staleStreak['Sweep WE Aggregators'].days, DEFAULT_ESCALATE_AFTER_DAYS);
  assert.deepEqual(third.escalate, ['Sweep WE Aggregators']);
});

test('two checks on the SAME day count once — no early escalation from a manual re-dispatch', () => {
  // check-cron-health has no concurrency group: the noon cron and a manual
  // workflow_dispatch can both land on one day. Counting invocations rather
  // than days would push an entry over the line 24h early and make
  // "consecutive days" a lie (Codex ship-check finding).
  let state = { staleStreak: { A: at(2, '2026-08-01') } };
  const first = updateStaleStreaks(state, ['A'], { today: '2026-08-02' });
  assert.equal(first.staleStreak.A.days, 3);
  const sameDayAgain = updateStaleStreaks({ staleStreak: first.staleStreak }, ['A'], { today: '2026-08-02' });
  assert.equal(sameDayAgain.staleStreak.A.days, 3, 'second run on the same day must not increment');
});

test('an entry stale past the boundary stays eligible (router handles repeats)', () => {
  const r = updateStaleStreaks({ staleStreak: { A: at(10, '2026-08-01') } }, ['A'], { today: '2026-08-02' });
  assert.equal(r.staleStreak.A.days, 11);
  assert.deepEqual(r.escalate, ['A']);
});

test('recovery clears the streak so the NEXT outage restarts at 1', () => {
  const recovered = updateStaleStreaks(
    { staleStreak: { A: at(5, '2026-08-01'), B: at(1, '2026-08-01') } },
    ['B'],
    { today: '2026-08-02' }
  );
  assert.deepEqual(recovered.recovered, ['A']);
  assert.equal(recovered.staleStreak.A, undefined);

  const relapse = updateStaleStreaks({ staleStreak: recovered.staleStreak }, ['A'], { today: '2026-08-03' });
  assert.equal(relapse.staleStreak.A.days, 1, 'a recovered cron must not escalate instantly on relapse');
  assert.deepEqual(relapse.escalate, []);
});

test('a state file written before staleStreak existed does not over-escalate', () => {
  // Legacy shape: a `stale` array, no streak map. Seeding a streak from it
  // would be a guess about duration; starting at 1 is the honest answer.
  const legacy = { stale: ['A', 'B'], redispatched: [], updatedAt: '2026-08-01T12:00:00Z' };
  const r = updateStaleStreaks(legacy, ['A', 'B'], { today: '2026-08-02' });
  assert.deepEqual(r.escalate, []);
  assert.equal(r.staleStreak.A.days, 1);
});

test('a pre-day-keying numeric streak is adopted as-is, not incremented', () => {
  // Legacy state carries no date, so we cannot tell whether it was already
  // counted today; incrementing could escalate 24h early on migration day.
  // Adopt and stamp — err late, never early (Codex ship-check finding).
  const r = updateStaleStreaks({ staleStreak: { A: 4 } }, ['A'], { today: '2026-08-02' });
  assert.equal(r.staleStreak.A.days, 4);
  assert.equal(r.staleStreak.A.lastCounted, '2026-08-02');
  assert.deepEqual(r.escalate, ['A']);
});

test('one missed daily check still counts as consecutive; a longer gap restarts', () => {
  const missedOne = updateStaleStreaks({ staleStreak: { A: at(2, '2026-08-01') } }, ['A'], { today: '2026-08-03' });
  assert.equal(missedOne.staleStreak.A.days, 3, 'a single skipped check must not break the streak');

  const longGap = updateStaleStreaks({ staleStreak: { A: at(2, '2026-08-01') } }, ['A'], { today: '2026-08-09' });
  assert.equal(longGap.staleStreak.A.days, 1, '8 days apart is not "3 consecutive days"');
  assert.deepEqual(longGap.escalate, []);
});

test('a clock that moves backwards does not inflate the streak', () => {
  const r = updateStaleStreaks({ staleStreak: { A: at(2, '2026-08-05') } }, ['A'], { today: '2026-08-04' });
  assert.equal(r.staleStreak.A.days, 2);
});

test('empty / duplicate / whitespace names are normalised away', () => {
  const r = updateStaleStreaks({ staleStreak: {} }, ['  A  ', 'A', '', '   ', 'B'], { today: '2026-08-02' });
  assert.deepEqual(Object.keys(r.staleStreak).sort(), ['A', 'B']);
  assert.equal(r.staleStreak.A.days, 1);
});

test('an all-clear check clears every streak and escalates nothing', () => {
  const r = updateStaleStreaks(
    { staleStreak: { A: at(9, '2026-08-01'), B: at(4, '2026-08-01') } },
    [],
    { today: '2026-08-02' }
  );
  assert.deepEqual(r.staleStreak, {});
  assert.deepEqual(r.escalate, []);
  assert.deepEqual(r.recovered, ['A', 'B']);
});

test('the escalation boundary is configurable', () => {
  const r = updateStaleStreaks({ staleStreak: { A: at(1, '2026-08-01') } }, ['A'], {
    today: '2026-08-02',
    escalateAfterDays: 2,
  });
  assert.deepEqual(r.escalate, ['A']);
});
