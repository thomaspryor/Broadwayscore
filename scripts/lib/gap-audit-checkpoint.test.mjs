// Task #923 — pure-function coverage for the checkpoint merge + rollback
// branching (CLAUDE.md §15: extract, export, test the real function — never
// re-implement the logic in the test).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { mergeCheckpointEntries, applyCheckpointRollback, DEFAULT_QUARANTINE_STREAK_CAP } = require('./gap-audit-checkpoint.js');

test('mergeCheckpointEntries: writes only the touched ids, leaves others untouched', () => {
  const current = {
    'show-a': { at: '2026-08-01T00:00:00.000Z', gaps: 0 },
    'show-b': { at: '2026-08-01T00:00:00.000Z', gaps: 2 },
  };
  const merged = mergeCheckpointEntries(current, { 'show-a': { at: '2026-08-03T00:00:00.000Z', gaps: 1 } });
  assert.deepStrictEqual(merged['show-a'], { at: '2026-08-03T00:00:00.000Z', gaps: 1 });
  // show-b was never in `entries` — must survive byte-for-byte.
  assert.deepStrictEqual(merged['show-b'], current['show-b']);
});

test('mergeCheckpointEntries: an undefined entry value deletes the id', () => {
  const current = { 'show-a': { gaps: 0 }, 'show-b': { gaps: 1 } };
  const merged = mergeCheckpointEntries(current, { 'show-a': undefined });
  assert.strictEqual('show-a' in merged, false);
  assert.deepStrictEqual(merged['show-b'], { gaps: 1 });
});

test('mergeCheckpointEntries: adds a new id not previously present', () => {
  const merged = mergeCheckpointEntries({ 'show-a': { gaps: 0 } }, { 'show-c': { gaps: 3 } });
  assert.deepStrictEqual(Object.keys(merged).sort(), ['show-a', 'show-c']);
});

test('mergeCheckpointEntries: null/undefined current treated as empty', () => {
  assert.deepStrictEqual(mergeCheckpointEntries(null, { a: { x: 1 } }), { a: { x: 1 } });
  assert.deepStrictEqual(mergeCheckpointEntries(undefined, {}), {});
});

test('mergeCheckpointEntries: does not mutate its inputs', () => {
  const current = { a: { x: 1 } };
  const entries = { a: { x: 2 }, b: { x: 3 } };
  mergeCheckpointEntries(current, entries);
  assert.deepStrictEqual(current, { a: { x: 1 } });
  assert.deepStrictEqual(entries, { a: { x: 2 }, b: { x: 3 } });
});

test('applyCheckpointRollback: restores the pre-run entry for a previously-audited show, stamping streak=1', () => {
  const current = { 'show-a': { at: 'NOW-refused-run', gaps: 0, uncollected: 0 } };
  const checkpointAtStart = { 'show-a': { at: 'PRE-RUN', gaps: 5, uncollected: 5 } };
  const rolled = applyCheckpointRollback(current, ['show-a'], checkpointAtStart);
  assert.deepStrictEqual(rolled['show-a'], { ...checkpointAtStart['show-a'], quarantineStreak: 1 });
});

test('applyCheckpointRollback: a show never audited before this run gets a streak-only marker, not a full delete', () => {
  const current = { 'show-new': { at: 'NOW-refused-run', gaps: 0 } };
  const rolled = applyCheckpointRollback(current, ['show-new'], {}); // not in checkpointAtStart
  // No `at`/`gaps`/`uncollected` — checkpointTs() and classifyGapEntry()
  // both already treat that as "never audited" / "no-data", so this is
  // observationally identical to a full delete for every existing reader,
  // but durable enough to count toward the streak cap (BRO-392 P1 finding).
  assert.deepStrictEqual(rolled['show-new'], { quarantineStreak: 1 });
});

test('applyCheckpointRollback: leaves shows THIS run never touched completely alone', () => {
  const current = {
    'show-a': { at: 'NOW-refused-run', gaps: 0 },
    'show-b': { at: 'CONCURRENT-run-fresh-stamp', gaps: 9 }, // a different, healthy run stamped this
  };
  const rolled = applyCheckpointRollback(current, ['show-a'], { 'show-a': { at: 'PRE-RUN', gaps: 5 } });
  assert.deepStrictEqual(rolled['show-b'], current['show-b'], 'a concurrent run\'s fresh stamp for an untouched show must survive rollback');
});

test('applyCheckpointRollback: mixed batch — some restore trusted history, some get a streak-only marker', () => {
  const current = {
    'show-old': { at: 'NOW', gaps: 0 },
    'show-new': { at: 'NOW', gaps: 0 },
  };
  const checkpointAtStart = { 'show-old': { at: 'PRE-RUN', gaps: 3 } }; // show-new absent
  const rolled = applyCheckpointRollback(current, ['show-old', 'show-new'], checkpointAtStart);
  assert.deepStrictEqual(rolled['show-old'], { at: 'PRE-RUN', gaps: 3, quarantineStreak: 1 });
  assert.deepStrictEqual(rolled['show-new'], { quarantineStreak: 1 });
});

test('applyCheckpointRollback: P0 (Codex adversarial review) — never adopts the refused run\'s gaps/uncollected, even once the breaker trips', () => {
  // The refused run computed gaps:0/uncollected:0 — exactly the numbers a
  // real coverage recovery would produce. If these leaked through once the
  // circuit breaker trips, newsletter-preflight.js's classifyGapEntry()
  // would read a fresh `at` + `uncollected:0` as 'ok' and clear a send on
  // data the blast-radius guard explicitly refused to trust.
  const checkpointAtStart = { 'show-a': { at: 'PRE-RUN', gaps: 5, uncollected: 5, quarantineStreak: 3 } };
  const current = { 'show-a': { at: 'NOW-refused-run-4', gaps: 0, uncollected: 0 } };
  const rolled = applyCheckpointRollback(current, ['show-a'], checkpointAtStart, { streakCap: 3 });
  assert.strictEqual(rolled['show-a'].at, 'NOW-refused-run-4', 'the timestamp DOES advance — that is the fix');
  assert.strictEqual(rolled['show-a'].gaps, 5, 'gaps must stay the last TRUSTED value, never this run\'s refused number');
  assert.strictEqual(rolled['show-a'].uncollected, 5, 'uncollected must stay the last TRUSTED value, never this run\'s refused number');
});

test('applyCheckpointRollback: a chronically-risky NEVER-trusted show still reaches the breaker (streak survives across runs with no `at`)', () => {
  let checkpoint = {};
  for (let run = 1; run <= 4; run++) {
    const checkpointAtStart = JSON.parse(JSON.stringify(checkpoint));
    const current = { 'brand-new-show': { at: `RUN-${run}`, gaps: 2, uncollected: 2 } };
    checkpoint = applyCheckpointRollback(current, ['brand-new-show'], checkpointAtStart, { streakCap: 3 });
    if (run <= 3) {
      assert.strictEqual(checkpoint['brand-new-show'].quarantineStreak, run, `run ${run}: streak must keep counting even with no trusted history`);
      assert.strictEqual(checkpoint['brand-new-show'].at, undefined, `run ${run}: still no trusted timestamp`);
    } else {
      assert.strictEqual(checkpoint['brand-new-show'].at, 'RUN-4', 'once the breaker trips, the timestamp finally advances');
      assert.strictEqual(checkpoint['brand-new-show'].uncollected, undefined, 'never adopts the untrusted uncollected count — stays no-data, not a false "ok"');
    }
  }
});

test('applyCheckpointRollback: quarantineStreak accumulates across repeated rollbacks', () => {
  const checkpointAtStart = { 'show-a': { at: 'PRE-RUN', gaps: 5, quarantineStreak: 1 } };
  const current = { 'show-a': { at: 'NOW-refused-run-2', gaps: 0 } };
  const rolled = applyCheckpointRollback(current, ['show-a'], checkpointAtStart);
  assert.strictEqual(rolled['show-a'].quarantineStreak, 2);
  assert.strictEqual(rolled['show-a'].at, 'PRE-RUN', 'still restores the stale timestamp below the cap');
});

test('applyCheckpointRollback: circuit breaker trips once streak exceeds the cap — this run\'s fresh stamp stands', () => {
  const checkpointAtStart = { 'show-a': { at: 'PRE-RUN', gaps: 5, quarantineStreak: 3 } };
  const current = { 'show-a': { at: 'NOW-refused-run-4', gaps: 0 } };
  const rolled = applyCheckpointRollback(current, ['show-a'], checkpointAtStart, { streakCap: 3 });
  assert.strictEqual(rolled['show-a'].at, 'NOW-refused-run-4', 'must NOT restore the stale PRE-RUN timestamp once the cap is exceeded');
  assert.strictEqual(rolled['show-a'].quarantineStreak, 0, 'streak resets once the breaker trips');
});

test('applyCheckpointRollback: default streak cap matches the exported constant', () => {
  assert.strictEqual(DEFAULT_QUARANTINE_STREAK_CAP, 3);
  const checkpointAtStart = { 'show-a': { at: 'PRE-RUN', quarantineStreak: DEFAULT_QUARANTINE_STREAK_CAP } };
  const current = { 'show-a': { at: 'NOW-fresh', gaps: 0 } };
  const rolled = applyCheckpointRollback(current, ['show-a'], checkpointAtStart);
  assert.strictEqual(rolled['show-a'].at, 'NOW-fresh', 'default cap must trip without passing opts.streakCap explicitly');
});

test('applyCheckpointRollback: null checkpointAtStart treated as "nothing was pre-existing" (streak-only markers)', () => {
  const rolled = applyCheckpointRollback({ a: { x: 1 } }, ['a'], null);
  assert.deepStrictEqual(rolled['a'], { quarantineStreak: 1 });
});

test('applyCheckpointRollback: a persisted null prior entry restores cleanly instead of throwing', () => {
  const checkpointAtStart = { 'show-a': null };
  const current = { 'show-a': { at: 'NOW-refused-run', gaps: 0 } };
  assert.doesNotThrow(() => applyCheckpointRollback(current, ['show-a'], checkpointAtStart));
  const rolled = applyCheckpointRollback(current, ['show-a'], checkpointAtStart);
  assert.strictEqual(rolled['show-a'].quarantineStreak, 1);
});

test('applyCheckpointRollback: does not mutate its inputs', () => {
  const current = { a: { x: 1 } };
  const checkpointAtStart = { a: { x: 0 } };
  applyCheckpointRollback(current, ['a'], checkpointAtStart);
  assert.deepStrictEqual(current, { a: { x: 1 } });
  assert.deepStrictEqual(checkpointAtStart, { a: { x: 0 } });
});
