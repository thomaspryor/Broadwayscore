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

test('applyCheckpointRollback: restores the pre-run entry for a previously-audited show', () => {
  const current = { 'show-a': { at: 'NOW-refused-run', gaps: 0, uncollected: 0 } };
  const checkpointAtStart = { 'show-a': { at: 'PRE-RUN', gaps: 5, uncollected: 5 } };
  const rolled = applyCheckpointRollback(current, ['show-a'], checkpointAtStart);
  assert.deepStrictEqual(rolled['show-a'], checkpointAtStart['show-a']);
});

test('applyCheckpointRollback: deletes the entry for a show never audited before this run', () => {
  const current = { 'show-new': { at: 'NOW-refused-run', gaps: 0 } };
  const rolled = applyCheckpointRollback(current, ['show-new'], {}); // not in checkpointAtStart
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

test('applyCheckpointRollback: mixed batch — some restore, some delete, in one call', () => {
  const current = {
    'show-old': { at: 'NOW', gaps: 0 },
    'show-new': { at: 'NOW', gaps: 0 },
  };
  const checkpointAtStart = { 'show-old': { at: 'PRE-RUN', gaps: 3 } }; // show-new absent
  const rolled = applyCheckpointRollback(current, ['show-old', 'show-new'], checkpointAtStart);
  assert.deepStrictEqual(rolled['show-old'], { at: 'PRE-RUN', gaps: 3 });
  assert.strictEqual('show-new' in rolled, false);
});

test('applyCheckpointRollback: null checkpointAtStart treated as "nothing was pre-existing" (all deletes)', () => {
  const rolled = applyCheckpointRollback({ a: { x: 1 } }, ['a'], null);
  assert.strictEqual('a' in rolled, false);
});

test('applyCheckpointRollback: does not mutate its inputs', () => {
  const current = { a: { x: 1 } };
  const checkpointAtStart = { a: { x: 0 } };
  applyCheckpointRollback(current, ['a'], checkpointAtStart);
  assert.deepStrictEqual(current, { a: { x: 1 } });
  assert.deepStrictEqual(checkpointAtStart, { a: { x: 0 } });
});
