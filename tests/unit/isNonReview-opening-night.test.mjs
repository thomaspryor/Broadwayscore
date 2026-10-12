/**
 * BRO-4189: CV-promoted isNonReview mislabelled opening-night reviews as
 * "preview" (reasoning: "a preview article written before or immediately upon
 * opening"). Two halves of the fix, both exercised through the real modules:
 *   1. content-verifier prompt: "preview" means written before the critic saw
 *      the production; publish timing near opening is never the test.
 *   2. isNonReviewCorroborationCandidate (scripts/lib/is-scoreable.js): lets
 *      the ensemble score a CV-promoted non-review file (fullText >= 1500) so
 *      isNonReviewDemotedByFreshCV's hasHighConfidenceLlmScore corroboration
 *      can ever be satisfied.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  buildVerificationPrompt,
  PREVIEW_ARTICLE_TYPE_GUIDANCE,
} = require('../../scripts/lib/content-verifier.js');
const {
  isScoreable,
  isNonReviewCorroborationCandidate,
  maskCvNonReviewVerdict,
  NONREVIEW_CORROBORATION_MIN_CHARS,
} = require('../../scripts/lib/is-scoreable.js');
const { isNonReviewDemotedByFreshCV } = require('../../scripts/lib/review-guards.js');

const SHOW = { id: 'cats-west-end-2026', title: 'Cats', category: 'west-end', status: 'open', openingDate: '2026-08-06' };

// Shape of cats-west-end-2026/musical-theatre-review--ron-cohen.json (5/5 stars,
// CV called it "a preview piece written before or immediately upon opening").
function cvPromotedPreview(overrides = {}) {
  const body = 'Cats at Regent\'s Park Open Air Theatre is a triumph. Melanie La Barrie is superb as Grizabella and the staging is thrilling. '.repeat(20);
  return {
    showId: 'cats-west-end-2026',
    outletId: 'musical-theatre-review',
    outlet: 'Musical Theatre Review',
    criticName: 'Ron Cohen',
    url: 'https://musicaltheatrereview.com/cats-regents-park-open-air-theatre/',
    publishDate: '2026-08-07',
    fullText: body,
    contentTier: 'complete',
    isNonReview: true,
    rejectionReason: 'not_a_review',
    isNonReviewReason: 'CV-promoted (not a review): This is a preview piece written before or immediately upon opening',
    contentVerificationPromoted: 'rebuild: promoted from contentVerification (llm:claude-haiku, high)',
    contentVerification: {
      isValid: false, confidence: 'high', wrongArticle: true, wrongProduction: false,
      isFilmTv: false, articleType: 'preview', articleTypeConfidence: 'high',
      verifiedAt: '2026-08-12T21:00:00.000Z',
    },
    ...overrides,
  };
}

describe('BRO-4189 CV prompt: preview is defined by whether the critic saw the show, not by timing', () => {
  test('prompt carries the timing-is-not-the-test guidance and drops the old bare definition', () => {
    const { prompt } = buildVerificationPrompt({
      scrapedText: 'A thrilling revival. '.repeat(40), showTitle: 'Cats', outletName: 'Musical Theatre Review',
      criticName: 'Ron Cohen', openingDate: '2026-08-06', publishDate: '2026-08-07', market: 'west-end',
    });
    assert.ok(prompt.includes(PREVIEW_ARTICLE_TYPE_GUIDANCE));
    assert.match(prompt, /written BEFORE the critic saw the production/);
    assert.match(prompt, /Timing is NOT the test/);
    assert.match(prompt, /immediately upon opening[^.]*are REVIEWS, not previews/);
    assert.doesNotMatch(prompt, /preview\*\*: written before opening, previewing what to expect/);
  });

  test('opening-week temporal hint also says near-opening publication is not preview evidence', () => {
    const { prompt } = buildVerificationPrompt({
      scrapedText: 'A thrilling revival. '.repeat(40), showTitle: 'Cats', outletName: 'X',
      openingDate: '2026-08-06', publishDate: '2026-08-06', market: 'west-end',
    });
    assert.match(prompt, /Publication near opening is also NOT evidence the article is a preview/);
  });
});

describe('BRO-4189 scoreable gate: CV-promoted non-reviews can be ensemble-scored for corroboration', () => {
  test('plain isScoreable still refuses the file; the corroboration gate admits it', () => {
    const d = cvPromotedPreview();
    assert.strictEqual(isScoreable(d, SHOW), false);
    assert.strictEqual(isNonReviewCorroborationCandidate(d, SHOW), true);
  });

  test('refuses short text, non-CV provenance, and human-set flags', () => {
    assert.strictEqual(NONREVIEW_CORROBORATION_MIN_CHARS, 1500);
    assert.strictEqual(isNonReviewCorroborationCandidate(cvPromotedPreview({ fullText: 'x'.repeat(1499) }), SHOW), false);
    assert.strictEqual(isNonReviewCorroborationCandidate(cvPromotedPreview({ isNonReviewReason: 'manual (not a review): forum thread' }), SHOW), false);
    assert.strictEqual(isNonReviewCorroborationCandidate(cvPromotedPreview({ manualNonReviewSet: true }), SHOW), false);
    assert.strictEqual(isNonReviewCorroborationCandidate(cvPromotedPreview({ nonReviewOverride: 'human' }), SHOW), false);
  });

  test('independent exclusions still apply (wrongShow, duplicateOf, CV wrongProduction)', () => {
    assert.strictEqual(isNonReviewCorroborationCandidate(cvPromotedPreview({ wrongShow: true }), SHOW), false);
    assert.strictEqual(isNonReviewCorroborationCandidate(cvPromotedPreview({ duplicateOf: 'other.json' }), SHOW), false);
    const wp = cvPromotedPreview();
    wp.contentVerification = { ...wp.contentVerification, wrongProduction: true };
    assert.strictEqual(isNonReviewCorroborationCandidate(wp, SHOW), false);
  });

  test('mask is a copy (no mutation), and a scored file + fresh CV review verdict demotes the flag', () => {
    const d = cvPromotedPreview();
    const masked = maskCvNonReviewVerdict(d);
    assert.strictEqual(d.isNonReview, true);
    assert.strictEqual(d.rejectionReason, 'not_a_review');
    assert.strictEqual(d.contentVerification.wrongArticle, true);
    assert.strictEqual(masked.isNonReview, undefined);

    // End state the corroboration path needs: a fresh high-confidence CV
    // "review" verdict alone is refused for CV-promoted provenance...
    const freshCv = { isValid: true, confidence: 'high', wrongArticle: false, wrongProduction: false,
      isFilmTv: false, articleType: 'review', articleTypeConfidence: 'high', verifiedAt: '2026-10-12T00:00:00.000Z' };
    const reverified = cvPromotedPreview({ contentVerification: freshCv });
    assert.strictEqual(isNonReviewDemotedByFreshCV(reverified), false);
    // ...and succeeds once the ensemble score this gate unlocks exists.
    assert.strictEqual(isNonReviewDemotedByFreshCV({ ...reverified, llmScore: { score: 92, confidence: 'high' } }), true);
  });
});
