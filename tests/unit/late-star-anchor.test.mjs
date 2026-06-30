/**
 * Unit tests for scripts/lib/late-star-anchor.js — flag llm-v6 reviews that now
 * carry a high-reliability star for an anchored re-score. MUST scope to anchored
 * markets (WE/OWE); MUST NOT touch already-anchored, human-overridden, flagged,
 * or non-anchored-market reviews.
 *
 * Run: node --test tests/unit/late-star-anchor.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { needsLateStarReanchor } = require('../../scripts/lib/late-star-anchor.js');

const weStar = (over = {}) => ({
  scoreSource: 'llm-v6', originalScore: '3/5', originalScoreSource: 'timeout-svg-stars',
  category: 'west-end', llmScore: { score: 77 }, ...over,
});

describe('needsLateStarReanchor', () => {
  test('flags an llm-v6 WE review with a high-reliability late star → returns its band', () => {
    const r = needsLateStarReanchor(weStar());
    assert.ok(r && r.band, 'should return a band');
    assert.equal(r.band.floor, 51); assert.equal(r.band.ceiling, 70); // 3/5 band
  });

  test('off-west-end is also anchored', () => {
    assert.ok(needsLateStarReanchor(weStar({ category: 'off-west-end' })));
  });

  test('does NOT flag a Broadway review (not an anchored market — llm-v6 is expected)', () => {
    assert.equal(needsLateStarReanchor(weStar({ category: 'broadway' })), null);
  });

  test('does NOT flag an already-anchored review', () => {
    assert.equal(needsLateStarReanchor(weStar({ scoreSource: 'anchored-v6' })), null);
  });

  test('does NOT flag a low-reliability star (extraction may be wrong)', () => {
    assert.equal(needsLateStarReanchor(weStar({ originalScoreSource: 'numeric-stars' })), null);
  });

  test('does NOT flag when there is no star', () => {
    assert.equal(needsLateStarReanchor(weStar({ originalScore: null, originalScoreSource: null })), null);
  });

  test('does NOT disturb a human override or a wrong-flagged review', () => {
    assert.equal(needsLateStarReanchor(weStar({ humanReviewScore: 55 })), null);
    assert.equal(needsLateStarReanchor(weStar({ wrongShow: true })), null);
  });
});
