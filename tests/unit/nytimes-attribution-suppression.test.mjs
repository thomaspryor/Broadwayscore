/**
 * Regression test for task #1180: a valid, content-verified, already-scored
 * T1 review (NYT/Disruption, Tim Teeman) sat excluded from the composite on
 * wrongAttribution:true alone, set on the unverified premise that "Tim
 * Teeman has never been an NYT theater critic". A direct cookie-authenticated
 * fetch of the live NYT page returned NYT's own GraphQL byline block naming
 * Tim Teeman with a real nyt://person/ entity ID — the flag was wrong, not
 * the review.
 *
 * Logic is require()'d from scripts/lib/review-guards.js — never copied
 * (CLAUDE.md §15). Fixture mirrors the real shape of
 * data/review-texts/disruption-off-broadway-2026/nytimes--tim-teeman.json.
 *
 * Run: node --test tests/unit/nytimes-attribution-suppression.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { isIncludableForRebuild, hasValidScore } = require('../../scripts/lib/review-guards');

const disruptionReview = {
  outletId: 'nytimes',
  criticName: 'Tim Teeman',
  fullText: 'If you’re panicking about how insidiously intrusive artificial intelligence is becoming in our lives…'.repeat(5),
  contentTier: 'complete',
  contentVerification: { isValid: true, wrongArticle: false, wrongProduction: false },
  assignedScore: 49,
};

describe('nytimes--tim-teeman: wrongAttribution alone suppresses an otherwise valid review', () => {
  it('is excluded while wrongAttribution:true is set, even with full text + a score', () => {
    const flagged = { ...disruptionReview, wrongAttribution: true, wrongAttributionReason: 'unconfirmed byline' };
    assert.strictEqual(isIncludableForRebuild(flagged), false);
  });

  it('does not simply lack a score while flagged — hasValidScore is independently true', () => {
    // Proves the exclusion above is caused by the flag, not a missing score.
    const flagged = { ...disruptionReview, wrongAttribution: true, wrongAttributionReason: 'unconfirmed byline' };
    assert.strictEqual(hasValidScore(flagged), true);
  });
});

describe('nytimes--tim-teeman: manual-clear pattern restores inclusion', () => {
  it('is includable once wrongAttribution is cleared via the manual-verify breadcrumb', () => {
    const cleared = {
      ...disruptionReview,
      crossOutletVerified: true,
      crossOutletVerifiedNote: 'Live-page GraphQL byline block confirms genuine "By Tim Teeman" NYT byline.',
      wrongArticleManualClear: true,
      // wrongAttribution / wrongAttributionReason intentionally absent — this
      // is the post-clear shape safeWriteReview() persists.
    };
    assert.strictEqual(isIncludableForRebuild(cleared), true);
    assert.strictEqual(hasValidScore(cleared), true);
  });

  it('a bare delete without the breadcrumb is NOT what this test asserts — presence of the flag is what matters', () => {
    // isIncludableForRebuild only reads wrongAttribution itself; the
    // breadcrumb fields exist for safeWriteReview's re-flag guard, not for
    // this predicate. Confirms the predicate has no hidden dependency on
    // wrongArticleManualClear/crossOutletVerified.
    const clearedNoBreadcrumb = { ...disruptionReview };
    assert.strictEqual(isIncludableForRebuild(clearedNoBreadcrumb), true);
  });
});
