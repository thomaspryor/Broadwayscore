/**
 * Unit tests for scripts/lib/stuck-rescore-flag.js — the corpus invariant
 * "needsRescore=true ⟹ isScoreable". A violation is a stuck flag that never
 * clears (the seam bug the late-star flagger hit, 2026-06-30).
 *
 * Run: node --test tests/unit/stuck-rescore-flag.test.mjs
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isStuckRescoreFlag } = require('../../scripts/lib/stuck-rescore-flag.js');

// A minimal includable + flagged review (isScoreable=true → NOT stuck).
const flaggedScoreable = (over = {}) => ({
  needsRescore: true,
  rescoreReason: 'fullText added after excerpt-based scoring',
  fullText: 'x'.repeat(2000),
  contentTier: 'complete',
  textStatus: 'complete',
  isFullReview: true,
  outletId: 'timeout',
  criticName: 'Jane Critic',
  llmScore: { score: 70 },
  ...over,
});

describe('isStuckRescoreFlag', () => {
  test('a flagged, scoreable review is NOT stuck', () => {
    assert.equal(isStuckRescoreFlag(flaggedScoreable(), { title: 'Demo' }, 'demo/timeout--jane.json'), false);
  });

  test('a review not flagged at all is NOT stuck (invariant only constrains needsRescore=true)', () => {
    assert.equal(isStuckRescoreFlag(flaggedScoreable({ needsRescore: false })), false);
    assert.equal(isStuckRescoreFlag(flaggedScoreable({ needsRescore: undefined })), false);
  });

  // NB: the duplicateOf exclusion is filesystem-dependent — isIncludableForRebuild
  // reads the referenced sibling on disk to confirm the dup (recovery is opt-in), so
  // it can't be exercised with a synthetic in-memory fixture. That path is covered by
  // the real-corpus audit (audit-stuck-rescore-flags.js) and was proven on the 5 stuck
  // reviews (3 duplicates) during the late-star fix. Here we cover the synthetically
  // detectable exclusion flags.

  test('a flagged isNonReview is stuck', () => {
    assert.equal(isStuckRescoreFlag(flaggedScoreable({ isNonReview: true }), { title: 'Demo' }), true);
  });

  test('a flagged wrongProduction is stuck', () => {
    assert.equal(isStuckRescoreFlag(flaggedScoreable({ wrongProduction: true }), { title: 'Demo' }), true);
  });

  test('null / empty input is not stuck (no throw)', () => {
    assert.equal(isStuckRescoreFlag(null), false);
    assert.equal(isStuckRescoreFlag(undefined), false);
    assert.equal(isStuckRescoreFlag({}), false);
  });
});
