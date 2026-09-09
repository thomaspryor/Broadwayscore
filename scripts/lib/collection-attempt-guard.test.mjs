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
const { shouldSkipAlreadyAttempted } = require('./collection-attempt-guard.js');

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
