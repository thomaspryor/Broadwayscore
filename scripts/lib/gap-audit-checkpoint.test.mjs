// Task #923 — pure-function coverage for the checkpoint merge + rollback
// branching (CLAUDE.md §15: extract, export, test the real function — never
// re-implement the logic in the test).
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { mergeCheckpointEntries, applyCheckpointRollback } = require('./gap-audit-checkpoint.js');

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

test('applyCheckpointRollback: restores the pre-run TRUSTED entry for a previously-audited show, in full', () => {
  const current = { 'show-a': { at: 'NOW-refused-run', checkedAt: 'NOW-refused-run', gaps: 0, uncollected: 0 } };
  const checkpointAtStart = { 'show-a': { at: 'PRE-RUN', gaps: 5, uncollected: 5 } };
  const rolled = applyCheckpointRollback(current, ['show-a'], checkpointAtStart);
  // Trusted fields (at/gaps/uncollected) come back exactly as they were —
  // classifyGapEntry() in newsletter-preflight.js must never see this run's
  // refused numbers. checkedAt (scheduling-only) is the one field allowed to
  // advance, so the show ages out of "most overdue" on the NEXT selection.
  assert.deepStrictEqual(rolled['show-a'], { ...checkpointAtStart['show-a'], checkedAt: 'NOW-refused-run' });
});

test('applyCheckpointRollback: BRO-392 P0 regression guard — never adopts the refused run\'s gaps/uncollected', () => {
  // The refused run computed gaps:0/uncollected:0 — exactly the numbers a
  // real coverage recovery would produce. If these leaked through,
  // newsletter-preflight.js's classifyGapEntry() would read a fresh `at` +
  // `uncollected:0` as 'ok' and clear a send on data the blast-radius guard
  // explicitly refused to trust.
  const checkpointAtStart = { 'show-a': { at: 'PRE-RUN-TRUSTED', gaps: 5, uncollected: 5 } };
  const current = { 'show-a': { at: 'NOW-refused-run', checkedAt: 'NOW-refused-run', gaps: 0, uncollected: 0 } };
  const rolled = applyCheckpointRollback(current, ['show-a'], checkpointAtStart);
  assert.strictEqual(rolled['show-a'].at, 'PRE-RUN-TRUSTED', 'at must stay the last TRUSTED timestamp, never this run\'s refused stamp');
  assert.strictEqual(rolled['show-a'].gaps, 5, 'gaps must stay the last TRUSTED value, never this run\'s refused number');
  assert.strictEqual(rolled['show-a'].uncollected, 5, 'uncollected must stay the last TRUSTED value, never this run\'s refused number');
});

test('applyCheckpointRollback: BRO-392 starvation-loop guard — checkedAt still advances even though at/gaps roll back', () => {
  // This is the actual fix: scheduling (checkedAt) must move forward even on
  // a refused run, or gap-audit-freshness.js's compareAuditPriority keeps
  // re-selecting the same chronically-risky show into nearly every batch
  // (the literal bug: the same ~9-10 shows recurred in nearly every hourly
  // run because the ONLY timestamp, `at`, never advanced).
  const checkpointAtStart = { 'show-a': { at: '2026-08-17T00:00:00.000Z', gaps: 3, uncollected: 3 } };
  let checkpoint = checkpointAtStart;
  for (let run = 1; run <= 10; run++) {
    const thisRunStamp = { at: new Date(Date.now() + run).toISOString(), checkedAt: new Date(Date.now() + run).toISOString(), gaps: 0, uncollected: 0 };
    checkpoint = applyCheckpointRollback({ 'show-a': thisRunStamp }, ['show-a'], checkpointAtStart);
    assert.strictEqual(checkpoint['show-a'].checkedAt, thisRunStamp.checkedAt, `run ${run}: checkedAt must advance to this run's real attempt time`);
    assert.strictEqual(checkpoint['show-a'].at, '2026-08-17T00:00:00.000Z', `run ${run}: at must stay pinned to the last trusted value`);
  }
});

test('applyCheckpointRollback: a show never trusted before this run keeps only its checkedAt, not invented trusted fields', () => {
  const current = { 'show-new': { at: 'NOW-refused-run', checkedAt: 'NOW-refused-run', gaps: 0 } };
  const rolled = applyCheckpointRollback(current, ['show-new'], {}); // not in checkpointAtStart
  // No `at`/`gaps`/`uncollected` — checkpointTs() reads a missing `at`
  // (falling back from checkedAt only when set) and classifyGapEntry() both
  // already treat a missing uncollected as "no-data", a soft warn never a
  // false "ok". checkedAt survives so scheduling still moves forward.
  assert.deepStrictEqual(rolled['show-new'], { checkedAt: 'NOW-refused-run' });
});

test('applyCheckpointRollback: a never-trusted show with NO checkedAt this run (legacy call shape) is fully deleted', () => {
  const current = { 'show-new': { gaps: 0 } }; // no checkedAt at all
  const rolled = applyCheckpointRollback(current, ['show-new'], {});
  assert.strictEqual('show-new' in rolled, false);
});

test('applyCheckpointRollback: leaves shows THIS run never touched completely alone', () => {
  const current = {
    'show-a': { at: 'NOW-refused-run', gaps: 0 },
    'show-b': { at: 'CONCURRENT-run-fresh-stamp', gaps: 9 }, // a different, healthy run stamped this
  };
  const rolled = applyCheckpointRollback(current, ['show-a'], { 'show-a': { at: 'PRE-RUN', gaps: 5 } });
  assert.deepStrictEqual(rolled['show-b'], current['show-b'], 'a concurrent run\'s fresh stamp for an untouched show must survive rollback');
});

test('applyCheckpointRollback: mixed batch — some restore trusted history, some get a checkedAt-only marker', () => {
  const current = {
    'show-old': { at: 'NOW', checkedAt: 'NOW', gaps: 0 },
    'show-new': { at: 'NOW', checkedAt: 'NOW', gaps: 0 },
  };
  const checkpointAtStart = { 'show-old': { at: 'PRE-RUN', gaps: 3 } }; // show-new absent
  const rolled = applyCheckpointRollback(current, ['show-old', 'show-new'], checkpointAtStart);
  assert.deepStrictEqual(rolled['show-old'], { at: 'PRE-RUN', gaps: 3, checkedAt: 'NOW' });
  assert.deepStrictEqual(rolled['show-new'], { checkedAt: 'NOW' });
});

test('applyCheckpointRollback: null checkpointAtStart treated as "nothing was pre-existing"', () => {
  const rolled = applyCheckpointRollback({ a: { checkedAt: 'NOW', x: 1 } }, ['a'], null);
  assert.deepStrictEqual(rolled['a'], { checkedAt: 'NOW' });
});

test('applyCheckpointRollback: a persisted null prior entry restores cleanly instead of throwing', () => {
  const checkpointAtStart = { 'show-a': null };
  const current = { 'show-a': { at: 'NOW-refused-run', checkedAt: 'NOW-refused-run', gaps: 0 } };
  assert.doesNotThrow(() => applyCheckpointRollback(current, ['show-a'], checkpointAtStart));
  const rolled = applyCheckpointRollback(current, ['show-a'], checkpointAtStart);
  // null spreads to {} — the trusted side contributes nothing, checkedAt survives.
  assert.deepStrictEqual(rolled['show-a'], { checkedAt: 'NOW-refused-run' });
});

test('applyCheckpointRollback: does not mutate its inputs', () => {
  const current = { a: { x: 1 } };
  const checkpointAtStart = { a: { x: 0 } };
  applyCheckpointRollback(current, ['a'], checkpointAtStart);
  assert.deepStrictEqual(current, { a: { x: 1 } });
  assert.deepStrictEqual(checkpointAtStart, { a: { x: 0 } });
});
