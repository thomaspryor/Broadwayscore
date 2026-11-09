// LIVE-DATA-LANE: reads data/site-image-versions.json (untracked core data); data/grosses.json (untracked core data); data/audience-buzz.json (untracked core data); +7 more. Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * Critic and outlet profiles must count a review once (BRO-4759). The rebuild copies a
 * returning production's earlier-run reviews onto its entry (inheritedFromShowId); the profile
 * builder in src/lib/data-reviews.ts skips those copies. The rule is required, never re-implemented
 * (CLAUDE.md §15).
 *
 * Run: npx tsx --test tests/unit/data-reviews-inherited.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInheritedReview } from '../../src/lib/data-reviews';

test('a row carrying inheritedFromShowId is an inherited copy', () => {
  assert.equal(isInheritedReview({ inheritedFromShowId: 'kramerfauci-off-broadway-2026' }), true);
});

test('native rows are not inherited', () => {
  assert.equal(isInheritedReview({}), false);
  assert.equal(isInheritedReview({ inheritedFromShowId: undefined }), false);
  assert.equal(isInheritedReview({ inheritedFromShowId: null }), false);
  assert.equal(isInheritedReview({ inheritedFromShowId: '' }), false);
});
