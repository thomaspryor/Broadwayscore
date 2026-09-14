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
    assert.deepEqual(second, { processed: 0, failed: 0 });
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
    assert.deepEqual(dedupeAttemptState(null), { processed: 0, failed: 0 });
    assert.deepEqual(dedupeAttemptState({ failed: 'not-an-array' }).failed, 0);
  });

  test('collect-review-texts.js calls the shared dedupe at BOTH persistence sites', () => {
    // Source-level assertion (CLAUDE.md rule 15): deleting either call site
    // fails this test instead of silently regressing the fix.
    assert.match(
      COLLECTOR_SRC,
      /const \{ shouldSkipAlreadyAttempted, dedupeAttemptState \} = require\('\.\/lib\/collection-attempt-guard\.js'\);/,
      'collect-review-texts.js must import dedupeAttemptState from the shared lib',
    );
    const saveState = COLLECTOR_SRC.slice(COLLECTOR_SRC.indexOf('function saveState()'));
    assert.ok(
      saveState.slice(0, saveState.indexOf('fs.writeFileSync')).includes('dedupeAttemptState(state)'),
      'saveState() must dedupe BEFORE serialising progress.json',
    );
    const loadState = COLLECTOR_SRC.slice(
      COLLECTOR_SRC.indexOf('function loadState()'),
      COLLECTOR_SRC.indexOf('function saveState()'),
    );
    assert.ok(
      loadState.includes('dedupeAttemptState(state)'),
      'loadState() must normalise duplicates inherited from a concurrent run',
    );
  });
});
