/**
 * Tests for shouldSkipAlreadyAttempted() (BRO-3024).
 *
 * Regression target: collect-review-texts.js's per-attempt loop had no
 * guard against re-attempting a reviewId already recorded as failed/
 * processed earlier in the same run (781 wasted paid fetches in one 10h
 * run, 2026-09-07). Both call sites now share this one predicate.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { shouldSkipAlreadyAttempted, dedupeAttemptState } = require('./collection-attempt-guard.js');
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const COLLECTOR_SRC = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'collect-review-texts.js'),
  'utf8',
);

describe('shouldSkipAlreadyAttempted', () => {
  test('returns false for a reviewId never attempted', () => {
    const state = { processed: [], failed: [] };
    assert.equal(shouldSkipAlreadyAttempted(state, 'show/outlet.json', false), false);
  });

  test('returns true for a reviewId already processed', () => {
    const state = { processed: ['show/outlet.json'], failed: [] };
    assert.equal(shouldSkipAlreadyAttempted(state, 'show/outlet.json', false), true);
  });

  test('returns true for a reviewId already failed, retryFailed=false', () => {
    const state = { processed: [], failed: ['show/outlet.json'] };
    assert.equal(shouldSkipAlreadyAttempted(state, 'show/outlet.json', false), true);
  });

  test('returns false for a reviewId already failed when retryFailed=true (intentional retry mode)', () => {
    const state = { processed: [], failed: ['show/outlet.json'] };
    assert.equal(shouldSkipAlreadyAttempted(state, 'show/outlet.json', true), false);
  });

  test('does not skip a different reviewId that happens to share a show prefix', () => {
    const state = { processed: [], failed: ['show/outlet-a.json'] };
    assert.equal(shouldSkipAlreadyAttempted(state, 'show/outlet-b.json', false), false);
  });

  test('defaults retryFailed to false when omitted', () => {
    const state = { processed: [], failed: ['show/outlet.json'] };
    assert.equal(shouldSkipAlreadyAttempted(state, 'show/outlet.json'), true);
  });
});

describe('dedupeAttemptState (BRO-3024 owner re-verification)', () => {
  test('collapses duplicate failed entries and reports how many it dropped', () => {
    const state = { processed: [], failed: ['a', 'b', 'a', 'c', 'a'] };
    const removed = dedupeAttemptState(state);
    assert.deepEqual(state.failed, ['a', 'b', 'c'], 'first-seen order preserved');
    assert.equal(removed.failed, 2);
  });

  test('collapses duplicate processed entries too (a concurrent run can duplicate successes)', () => {
    const state = { processed: ['x', 'x', 'y'], failed: [] };
    const removed = dedupeAttemptState(state);
    assert.deepEqual(state.processed, ['x', 'y']);
    assert.equal(removed.processed, 1);
  });

  test('is idempotent — a second pass drops nothing', () => {
    const state = { processed: ['x', 'x'], failed: ['a', 'a'] };
    dedupeAttemptState(state);
    const second = dedupeAttemptState(state);
    assert.deepEqual(second, { processed: 0, failed: 0, succeededAfterFailure: 0, tierBreakdown: 0 });
  });

  test('drops an id that failed then SUCCEEDED, so "(N failed)" stops counting it', () => {
    // Under RETRY_FAILED=true a review can fail and then succeed within the
    // same state file, landing in both arrays. processed is authoritative.
    const state = { processed: ['a', 'b'], failed: ['a', 'c'] };
    const removed = dedupeAttemptState(state);
    assert.deepEqual(state.failed, ['c'], 'the retried-and-succeeded id is gone from failed');
    assert.deepEqual(state.processed, ['a', 'b'], 'processed is untouched');
    assert.equal(removed.succeededAfterFailure, 1);
  });

  test('failed-then-succeeded purge is idempotent and does not touch a genuine failure', () => {
    const state = { processed: ['a'], failed: ['a', 'a', 'z'] };
    const first = dedupeAttemptState(state);
    assert.deepEqual(state.failed, ['z']);
    assert.equal(first.failed, 1, 'one duplicate entry removed');
    assert.equal(first.succeededAfterFailure, 1, 'one failed-then-succeeded id removed');
    const second = dedupeAttemptState(state);
    assert.deepEqual(second, { processed: 0, failed: 0, succeededAfterFailure: 0, tierBreakdown: 0 });
    assert.deepEqual(state.failed, ['z'], 'a genuine failure survives every pass');
  });

  test('holds under RETRY_FAILED=true, the mechanism the in-process guard cannot cover', () => {
    // shouldSkipAlreadyAttempted intentionally allows the re-attempt...
    const state = { processed: [], failed: ['a'] };
    assert.equal(shouldSkipAlreadyAttempted(state, 'a', true), false);
    state.failed.push('a'); // ...so the loop re-appends
    // ...and the write-side dedupe is what keeps the persisted array unique.
    dedupeAttemptState(state);
    assert.deepEqual(state.failed, ['a']);
  });

  test('holds under the concurrent last-writer-wins merge, the other live mechanism', () => {
    // Two runs load the same file, append independently, and the last one
    // to serialise wins. Its array must still be duplicate-free.
    const fromDisk = { processed: [], failed: ['a', 'b'] };
    const runB = { processed: [], failed: [...fromDisk.failed, 'b', 'c'] };
    dedupeAttemptState(runB);
    assert.deepEqual(runB.failed, ['a', 'b', 'c']);
  });

  test('leaves a missing or non-array field alone rather than inventing one', () => {
    const state = { failed: ['a', 'a'] };
    const removed = dedupeAttemptState(state);
    assert.equal('processed' in state, false, 'does not invent a processed array');
    assert.equal(removed.processed, 0);
    assert.deepEqual(state.failed, ['a']);
    assert.deepEqual(dedupeAttemptState(null), { processed: 0, failed: 0, succeededAfterFailure: 0, tierBreakdown: 0 });
    assert.deepEqual(dedupeAttemptState({ failed: 'not-an-array' }).failed, 0);
  });

  test('collect-review-texts.js calls the shared dedupe at BOTH persistence sites', () => {
    // Source-level assertion (CLAUDE.md rule 15): deleting either call site
    // fails this test instead of silently regressing the fix.
    //
    // Deliberately NOT pinned to the destructuring order or quote style of
    // the require line — adding a third export to this module must not break
    // this test. Only the two facts that matter are asserted: the collector
    // imports from this module, and it names dedupeAttemptState.
    const requireLine = COLLECTOR_SRC.split('\n').find(
      (l) => l.includes("require('./lib/collection-attempt-guard.js')"),
    );
    assert.ok(requireLine, 'collect-review-texts.js must require the shared attempt-guard lib');
    assert.ok(
      requireLine.includes('dedupeAttemptState'),
      'collect-review-texts.js must import dedupeAttemptState from the shared lib',
    );

    // Locate both functions explicitly and fail with a legible message if a
    // rename moved them, rather than letting indexOf(-1) produce a slice that
    // silently passes or fails for the wrong reason.
    const loadIdx = COLLECTOR_SRC.indexOf('function loadState()');
    const saveIdx = COLLECTOR_SRC.indexOf('function saveState()');
    assert.notEqual(loadIdx, -1, 'loadState() not found — was it renamed? update this test');
    assert.notEqual(saveIdx, -1, 'saveState() not found — was it renamed? update this test');
    const saveBody = COLLECTOR_SRC.slice(saveIdx);
    const writeIdx = saveBody.indexOf('fs.writeFileSync');
    assert.notEqual(writeIdx, -1, 'saveState() no longer calls fs.writeFileSync — update this test');
    assert.ok(
      saveBody.slice(0, writeIdx).includes('dedupeAttemptState(state)'),
      'saveState() must dedupe BEFORE serialising progress.json',
    );

    // Order-independent: slice from loadState() to whichever function is
    // defined next, so reordering loadState/saveState cannot silently empty
    // this slice (or pass for the wrong reason).
    const afterLoad = COLLECTOR_SRC.slice(loadIdx + 'function loadState()'.length);
    const nextFnIdx = afterLoad.search(/\nfunction /);
    assert.ok(
      afterLoad.slice(0, nextFnIdx === -1 ? undefined : nextFnIdx).includes('dedupeAttemptState(state)'),
      'loadState() must normalise duplicates inherited from a concurrent run',
    );
  });

  test('MOVES failed-then-succeeded ids to recoveredAfterFailure instead of erasing them', () => {
    // Purging them from `failed` is what makes "(N failed)" truthful, but the
    // per-id history must survive — clearFailedFetch() already drops the
    // failed-fetches.json entry on success, so this is the only record left.
    const state = { processed: ['a'], failed: ['a', 'z'] };
    dedupeAttemptState(state);
    assert.deepEqual(state.failed, ['z']);
    assert.deepEqual(state.recoveredAfterFailure, ['a'], 'the flaky id is still recorded somewhere');
  });

  test('recoveredAfterFailure accumulates across runs without duplicating', () => {
    const state = { processed: ['a', 'b'], failed: ['a', 'b'], recoveredAfterFailure: ['a'] };
    dedupeAttemptState(state);
    assert.deepEqual(state.failed, []);
    assert.deepEqual(state.recoveredAfterFailure.sort(), ['a', 'b']);
    const second = dedupeAttemptState(state);
    assert.equal(second.succeededAfterFailure, 0);
    assert.deepEqual(state.recoveredAfterFailure.sort(), ['a', 'b'], 'idempotent');
  });

  test('dedupes tierBreakdown arrays so tier counts match the processed count', () => {
    const state = {
      processed: ['a', 'a'], failed: [],
      tierBreakdown: { playwright: ['a', 'a', 'b'], browserbase: ['c'], amp: 'not-an-array' },
    };
    const removed = dedupeAttemptState(state);
    assert.deepEqual(state.tierBreakdown.playwright, ['a', 'b']);
    assert.deepEqual(state.tierBreakdown.browserbase, ['c'], 'already-unique tiers untouched');
    assert.equal(state.tierBreakdown.amp, 'not-an-array', 'non-array tier left alone');
    assert.equal(removed.tierBreakdown, 1);
  });
});
