/**
 * BRO-2282 — 285 WE review-text files carry needsReview:true + an already-
 * computed assignedScore, with a needsReviewReason matching "already scored".
 *
 * Investigation found needsReview itself is never read by explainExclusion() —
 * it's a purely informational breadcrumb. Of a 289-file sample, 90 already pass
 * explainExclusion (the flag has zero effect on them); the other 199 are
 * genuinely excluded via wrongProduction/wrongShow/rejectionReason/etc, and a
 * manual read of a 20-file sample confirmed those exclusions are correct
 * (wrong-show/wrong-production text really is present).
 *
 * The one concretely fixable, generalizable bug in the sample: John Proctor Is
 * the Villain (WE), whatsonstage--sarah-crompton.json. Its fetched fullText was
 * cookie-consent boilerplate ahead of a genuine, complete review; the LLM
 * ensemble classified the whole blob 'garbage_text' and rejected it. But
 * assignedScore was independently computed from scoreSource:'wos-star-images' —
 * a markup-based extractor (extractUKStarRating in score-extractors.js) that
 * counts star <img> tags in the raw page HTML, never reading the rejected
 * prose at all. hasStructuralStarScore() (scripts/lib/review-guards.js) closes
 * this gap for the small set of outlet star-rating extractors confirmed to be
 * markup-based rather than prose-scanned — see STRUCTURAL_STAR_SOURCES there
 * for the full list and why prose-pattern extractors (unicode-stars,
 * text-pattern, ...) are deliberately excluded.
 *
 * A corpus-wide direct scan (every file under data/review-texts/*, all
 * markets) found exactly 2 files flip from excluded to included under this
 * change: the John Proctor file above, and
 * starlight-express-west-end-2024/timeout-london--andrzej-lukowski.json (same
 * shape: LLM misread a real Time Out review as a critic-roundup, but
 * scoreSource:'timeout-svg-stars' had already read the page's own star SVGs).
 * Both were read by hand and confirmed genuine.
 *
 * Logic is require()'d from the lib — never copied (CLAUDE.md §15).
 *
 * Run: node --test tests/unit/we-reviews-blocked-by-needsReview.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { explainExclusion, hasStructuralStarScore, isRejectedNonReview, STRUCTURAL_STAR_SOURCES } =
  require('../../scripts/lib/review-guards.js');

// Shaped after the real john-proctor-is-the-villain-west-end-2026/
// whatsonstage--sarah-crompton.json record (fields trimmed to what the
// predicates under test actually read).
const johnProctorShaped = {
  showId: 'john-proctor-is-the-villain-west-end-2026',
  outletId: 'whatsonstage',
  assignedScore: 90,
  originalScore: '5/5 stars',
  originalScoreNormalized: 100,
  scoreSource: 'wos-star-images',
  originalScoreSource: 'wos-star-images',
  rejectedBy: 'ensemble-scoreability-check',
  rejectionReason: 'garbage_text',
  needsReview: true,
  needsReviewReason: 'Collector LLM: not a review (other, high conf) but already scored — needs human verification',
  contentTier: 'excerpt',
};

describe('hasStructuralStarScore', () => {
  it('is true for a garbage_text rejection with a markup-based star score (John Proctor shape)', () => {
    assert.equal(hasStructuralStarScore(johnProctorShaped), true);
  });

  it('is true for not_a_review rejections too', () => {
    assert.equal(hasStructuralStarScore({ ...johnProctorShaped, rejectionReason: 'not_a_review' }), true);
  });

  it('is false when wrongProduction is true — a structural score cannot vouch for the content being the right show', () => {
    assert.equal(hasStructuralStarScore({ ...johnProctorShaped, wrongProduction: true }), false);
  });

  it('is false when wrongShow is true', () => {
    assert.equal(hasStructuralStarScore({ ...johnProctorShaped, wrongShow: true }), false);
  });

  it('is false for wrong_show rejections — a content-correctness verdict a star score cannot override', () => {
    assert.equal(hasStructuralStarScore({ ...johnProctorShaped, rejectionReason: 'wrong_show' }), false);
  });

  it('is false for wrong_production rejections', () => {
    assert.equal(hasStructuralStarScore({ ...johnProctorShaped, rejectionReason: 'wrong_production' }), false);
  });

  it('is false when the score source is a prose-pattern extractor (unicode-stars), not markup-based', () => {
    assert.equal(
      hasStructuralStarScore({ ...johnProctorShaped, scoreSource: 'unicode-stars', originalScoreSource: 'unicode-stars' }),
      false
    );
    assert.equal(STRUCTURAL_STAR_SOURCES.has('unicode-stars'), false);
  });

  it('is false when there is no rejectionReason at all (nothing to except)', () => {
    const { rejectionReason, ...rest } = johnProctorShaped;
    assert.equal(hasStructuralStarScore(rest), false);
  });

  it('is false when originalScoreNormalized is missing or out of range', () => {
    assert.equal(hasStructuralStarScore({ ...johnProctorShaped, originalScoreNormalized: undefined }), false);
    assert.equal(hasStructuralStarScore({ ...johnProctorShaped, originalScoreNormalized: 0 }), false);
    assert.equal(hasStructuralStarScore({ ...johnProctorShaped, originalScoreNormalized: 101 }), false);
  });

  it('is false for null/undefined input', () => {
    assert.equal(hasStructuralStarScore(null), false);
    assert.equal(hasStructuralStarScore(undefined), false);
  });
});

describe('explainExclusion — structural star score carve-out (BRO-2282)', () => {
  it('includes the John Proctor / WhatsOnStage shape (was excluded via rejectionReason before the fix)', () => {
    assert.equal(explainExclusion(johnProctorShaped), null);
  });

  it('still excludes a garbage_text rejection with NO independent score signal', () => {
    const noScore = { ...johnProctorShaped, scoreSource: undefined, originalScoreSource: undefined, originalScoreNormalized: undefined };
    assert.equal(explainExclusion(noScore), 'rejectionReason');
  });

  it('still excludes when wrongProduction is set, even with a structural star score', () => {
    assert.equal(explainExclusion({ ...johnProctorShaped, wrongProduction: true }), 'wrongProduction');
  });

  it('still excludes wrong_show-rejected content even when aggregatorStars/scoreSource happen to be present', () => {
    // Regression guard for the corpus finding that some wrong_show rejections
    // (my-neighbour-totoro, mamma-mia in the 289-file sample) carry a plausible-
    // looking score sourced from content that is itself about the wrong show.
    const wrongShowShaped = { ...johnProctorShaped, rejectionReason: 'wrong_show' };
    assert.equal(explainExclusion(wrongShowShaped), 'rejectionReason');
  });

  it('still respects the rejectedAt gate for stale, unaddressed rejections without a structural score', () => {
    const staleNoScore = {
      showId: johnProctorShaped.showId,
      rejectedAt: '2026-03-01T00:00:00.000Z',
    };
    assert.equal(explainExclusion(staleNoScore), 'rejectedAt');
  });

  it('clears the rejectedAt gate too when a structural star score is present', () => {
    const staleWithScore = { ...johnProctorShaped, rejectedAt: '2026-03-01T00:00:00.000Z' };
    assert.equal(explainExclusion(staleWithScore), null);
  });
});

describe('isRejectedNonReview — kept in lock-step with the inclusion gate (BRO-2282)', () => {
  it('does not treat the John Proctor / WhatsOnStage shape as a non-review needing rediscovery', () => {
    assert.equal(isRejectedNonReview(johnProctorShaped), false);
  });

  it('still treats a garbage_text rejection with no independent score as a non-review', () => {
    const noScore = { ...johnProctorShaped, scoreSource: undefined, originalScoreSource: undefined, originalScoreNormalized: undefined };
    assert.equal(isRejectedNonReview(noScore), true);
  });

  // ship-check finding (Codex adversarial review): hasStructuralStarScore only
  // overrides explainExclusion's rejectionReason/rejectedAt gates — it does NOT
  // override the separate cvWrongArticleHighConfidence gate. A file can carry
  // both a structural star score AND a high-confidence contentVerification
  // wrongArticle verdict from a different pipeline stage; the original
  // `if (hasStructuralStarScore(data)) return false` short-circuited past that
  // check entirely, letting a still-excluded-by-explainExclusion file be marked
  // "retrieved" (not awaiting rediscovery) — a permanently missing review the
  // pipeline believed was covered.
  it('still treats a structurally-scored file as a non-review when CV separately flags high-confidence wrongArticle', () => {
    const wrongArticleToo = {
      ...johnProctorShaped,
      contentVerification: { wrongArticle: true, confidence: 'high' },
    };
    assert.equal(isRejectedNonReview(wrongArticleToo), true);
  });

  it('does not flip on a LOW-confidence wrongArticle verdict alongside a structural star score', () => {
    const lowConfWrongArticle = {
      ...johnProctorShaped,
      contentVerification: { wrongArticle: true, confidence: 'low' },
    };
    assert.equal(isRejectedNonReview(lowConfWrongArticle), false);
  });
});

describe('hasStructuralStarScore — originalScoreCleared (ship-check finding)', () => {
  it('is false once a later pass (fix-p0-score-corruption.js) invalidates the extraction', () => {
    assert.equal(hasStructuralStarScore({ ...johnProctorShaped, originalScoreCleared: true }), false);
  });

  it('explainExclusion still excludes once originalScoreCleared is set', () => {
    assert.equal(explainExclusion({ ...johnProctorShaped, originalScoreCleared: true }), 'rejectionReason');
  });
});
