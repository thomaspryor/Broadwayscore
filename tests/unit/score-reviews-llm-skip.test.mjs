/**
 * Unit tests for the score-reviews-llm.js skip predicate (isAlreadyLlmScored).
 *
 * Guards the fix for S1-T1: the original `!== null` check skipped files where
 * assignedScore was undefined (newly-created review files that had never been
 * scored) because `undefined !== null` is true in JavaScript.
 *
 * `typeof review.assignedScore === 'number'` correctly handles all four cases:
 *   - Pan score (0):     typeof 0   === 'number' → skip (don't re-score)
 *   - Rave score (95):  typeof 95  === 'number' → skip (don't re-score)
 *   - Missing field:    typeof undefined === 'undefined' → process (score it!)
 *   - Explicit null:    typeof null      === 'object'    → process (score it!)
 *
 * Per CLAUDE.md §15: require() the real function, never duplicate logic.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isAlreadyLlmScored } = require('../../scripts/lib/review-guards.js');

describe('isAlreadyLlmScored', () => {
  test('Pan score (0) — should skip: already scored at the low extreme', () => {
    assert.strictEqual(isAlreadyLlmScored({ assignedScore: 0 }), true);
  });

  test('Rave score (95) — should skip: already has a high score', () => {
    assert.strictEqual(isAlreadyLlmScored({ assignedScore: 95 }), true);
  });

  test('Field missing (undefined) — should NOT skip: newly-created file needs scoring', () => {
    // This was the bug: `!== null` returned true for undefined, skipping these files
    assert.strictEqual(isAlreadyLlmScored({}), false);
  });

  test('Field explicitly null — should NOT skip: null means not yet scored', () => {
    // `!== null` would correctly allow null through, but typeof handles it too
    assert.strictEqual(isAlreadyLlmScored({ assignedScore: null }), false);
  });

  // Boundary/edge cases
  test('Mid-range score (50) — should skip: any numeric score is final', () => {
    assert.strictEqual(isAlreadyLlmScored({ assignedScore: 50 }), true);
  });

  test('Score of 100 — should skip: maximum valid score', () => {
    assert.strictEqual(isAlreadyLlmScored({ assignedScore: 100 }), true);
  });

  test('Score is string "95" — should NOT skip: string is not a number', () => {
    // Defensive: corrupt data should be re-scored, not silently left alone
    assert.strictEqual(isAlreadyLlmScored({ assignedScore: '95' }), false);
  });
});
