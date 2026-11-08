// LIVE-DATA-LANE: reads data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-7050: one automated classifier verdict must not hide an aggregator-listed review.
// Requires the real functions (review-guards.js explainExclusion / soloVerdictHeld /
// isRejectedByReasonExclusion / isRejectedAtExclusion, single-verdict-guard.js).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const guards = require('../../scripts/lib/review-guards');
const { explainExclusion, soloVerdictHeld, isRejectedByReasonExclusion, isRejectedAtExclusion, isNonReviewDemotedByFreshCV } = guards;
const { evaluateSoloVerdictHold, aggregatorListedBy } = require('../../scripts/lib/single-verdict-guard');

const QUOTE = 'a beautifully staged revival that lands every joke and every heartbreak';
const BODY = `Opening night review. The house was full. The critic writes that this is ${QUOTE}, and the ensemble earns it. `.repeat(8);
const show = { id: 'demo-off-broadway-2026', title: 'Demo', openingDate: '2026-11-05', status: 'open', venue: 'Demo Theatre' };
const FP = '/nonexistent/demo-off-broadway-2026/timeout--jane-roe.json';
const review = (extra = {}) => ({
  outletId: 'timeout', outlet: 'Time Out', criticName: 'Jane Roe',
  url: 'https://www.timeout.com/newyork/theater/demo-review', fullText: BODY, publishDate: '2026-11-06',
  contentTier: 'complete', assignedScore: 80, scoreSource: 'llm-v6', llmScore: { score: 80, confidence: 'high' },
  dtliExcerpt: `"${QUOTE}" … more`, ...extra,
});
const gemini = (extra = {}) => review({ isNonReview: true, nonReviewClassifiedBy: 'gemini', nonReviewType: 'feature', ...extra });

describe('the regression: a lone classifier verdict on an aggregator-listed review', () => {
  test('control: the unflagged review is included', () => {
    assert.equal(explainExclusion(review(), show, FP), null);
  });

  test('gemini isNonReview + a listing whose quote is in the body: stays included, hold reported', () => {
    const d = gemini();
    assert.equal(explainExclusion(d, show, FP), null);
    const h = soloVerdictHeld(d, 'nonReview');
    assert.equal(h.held, true);
    assert.deepEqual(h.families, ['gemini']);
    assert.deepEqual(h.listedBy, ['dtliExcerpt']);
  });

  test('without the guard (kill switch) the same file is excluded as nonReview', () => {
    process.env.SINGLE_VERDICT_GUARD_DISABLED = '1';
    try { assert.equal(explainExclusion(gemini(), show, FP), 'nonReview'); } finally { delete process.env.SINGLE_VERDICT_GUARD_DISABLED; }
  });

  test('CV-promoted wrongShow + listing: stays included', () => {
    const d = review({ wrongShow: true, wrongShowReason: 'CV-promoted: review names another production' });
    assert.equal(explainExclusion(d, show, FP), null);
    assert.equal(soloVerdictHeld(d, 'wrongShow').held, true);
  });

  test('single-voice ensemble rejection + listing + a score: rejection and rejectedAt both stand down', () => {
    const d = review({ rejectionReason: 'not_a_review', rejectedBy: 'ensemble-scoreability-check',
      rejectedAt: '2026-11-06T10:00:00Z', rejectionReasoning: 'claude: looks like a feature' });
    assert.equal(isRejectedByReasonExclusion(d), false);
    assert.equal(isRejectedAtExclusion(d), false);
  });
});

describe('what the guard must NOT release', () => {
  test('openai + kimi two-model consensus is not a solo verdict (reviewer finding)', () => {
    const d = review({ rejectionReason: 'wrong_production', rejectedBy: 'ensemble-scoreability-check',
      rejectedAt: '2026-11-06T10:00:00Z', rejectionReasoning: 'openai: original U.K. staging; kimi: original U.K. staging' });
    assert.equal(soloVerdictHeld(d, 'rejection').held, false);
    assert.equal(isRejectedByReasonExclusion(d), true);
  });
  test('a refused CV clear keeps a nonReview label in force even when an aggregator lists it (BRO-6745)', () => {
    const d = gemini({ contentVerification: { clearRefusal: true, verifiedAt: '2026-11-01T00:00:00Z', articleType: 'review', isValid: true } });
    assert.equal(isNonReviewDemotedByFreshCV(d), false);
  });
  test('a held nonReview with no contentVerification record is still demoted-by-hold', () => {
    assert.equal(isNonReviewDemotedByFreshCV(gemini({})), true);
  });

  test('two classifier families (gemini + a current high-confidence CV article-type verdict) is a second check: stays excluded', () => {
    const d = gemini({ contentVerification: { isValid: true, confidence: 'high', articleTypeConfidence: 'high', articleType: 'interview' } });
    assert.equal(soloVerdictHeld(d, 'nonReview').held, false);
    assert.equal(explainExclusion(d, show, FP) !== null, true);
  });

  test('a multi-model ensemble rejection is a consensus, not a lone verdict', () => {
    const d = review({ rejectionReason: 'wrong_show', rejectedBy: 'ensemble-scoreability-check', rejectionAgreeCount: 3,
      rejectionReasoning: 'claude: other show; openai: other show; gemini: other show' });
    assert.equal(soloVerdictHeld(d, 'rejection').held, false);
    assert.equal(isRejectedByReasonExclusion(d), true);
  });

  test('a human or hard signal blocks the hold', () => {
    for (const extra of [{ manualReviewedBy: 'owner' }, { wrongAttribution: true }, { fabricatedEntry: true }, { incompleteReason: 'wrong_content' }]) {
      assert.equal(soloVerdictHeld(gemini(extra), 'nonReview').held, false, JSON.stringify(extra));
    }
  });

  test('an unrecognised flag source never holds', () => {
    assert.equal(soloVerdictHeld(review({ isNonReview: true }), 'nonReview').held, false);
    assert.equal(soloVerdictHeld(review({ wrongProduction: true, wrongProductionDetectedBy: 'url-year-guard' }), 'wrongProduction').held, false);
  });

  test('a bare excerpt whose quote is not in this file body is not a listing of this file (same critic, other piece)', () => {
    const d = gemini({ dtliExcerpt: '"A completely different review of another night entirely" … x' });
    assert.deepEqual(aggregatorListedBy(d), []);
    assert.equal(soloVerdictHeld(d, 'nonReview').held, false);
  });

  test('a full-text score alone does not hold a nonReview flag (a scorer rates interviews too)', () => {
    const d = gemini({ dtliExcerpt: undefined });
    assert.equal(soloVerdictHeld(d, 'nonReview').held, false);
  });

  test('a listing with no score does not hold an ensemble rejection (nothing countable to restore)', () => {
    const d = review({ assignedScore: undefined, rejectionReason: 'not_a_review', rejectedBy: 'ensemble-scoreability-check', rejectionReasoning: 'claude: interview' });
    assert.equal(soloVerdictHeld(d, 'rejection').held, false);
  });

  test('metaExcerpt (the page\'s own headline) is not an aggregator listing', () => {
    const d = gemini({ dtliExcerpt: undefined, metaExcerpt: `${QUOTE} …` });
    assert.deepEqual(aggregatorListedBy(d), []);
  });
});

describe('writers stop minting the verdict (so the flag is never written)', () => {
  const { shouldSuppressExcerptOnlyAggregatorListed } = require('../../scripts/lib/excerpt-wrongshow-guard');
  const { nonReviewStampBlockReason } = require('../../scripts/lib/flagged-recovery');

  test('llm-scoring: any ensemble rejection on an excerpt-only aggregator-listed file writes no flag', () => {
    for (const rejection of ['not_a_review', 'wrong_show', 'wrong_production']) {
      const r = shouldSuppressExcerptOnlyAggregatorListed({ rejection, scoredTextType: 'excerpt', fileData: { fullText: null, dtliExcerpt: 'quote' } });
      assert.equal(r.suppress, true, rejection);
    }
  });

  test('llm-scoring: a verdict that read a real body, or an unlisted file, is not suppressed', () => {
    assert.equal(shouldSuppressExcerptOnlyAggregatorListed({ rejection: 'not_a_review', scoredTextType: 'fullText', fileData: { fullText: BODY, dtliExcerpt: 'q' } }).suppress, false);
    assert.equal(shouldSuppressExcerptOnlyAggregatorListed({ rejection: 'not_a_review', scoredTextType: 'excerpt', fileData: { fullText: null, metaExcerpt: 'headline' } }).suppress, false);
    assert.equal(shouldSuppressExcerptOnlyAggregatorListed({ rejection: 'garbage_text', scoredTextType: 'excerpt', fileData: { dtliExcerpt: 'q' } }).suppress, false);
  });

  test('classify-non-reviews: the Gemini stamp is blocked when an aggregator lists the review', () => {
    assert.match(nonReviewStampBlockReason(review(), false) || '', /aggregator lists this review/);
    assert.equal(nonReviewStampBlockReason(review({ dtliExcerpt: undefined }), false), null);
    assert.equal(nonReviewStampBlockReason(review(), false, { independentCheckAgrees: true }), null);
  });
});

describe('plumbing', () => {
  test('evaluateSoloVerdictHold rejects unknown kinds and missing data', () => {
    assert.equal(evaluateSoloVerdictHold(null, 'nonReview').held, false);
    assert.equal(evaluateSoloVerdictHold(gemini(), 'bogus').held, false);
  });

  test('rebuild-all-reviews.js records every hold to data/audit/single-verdict-holds.json', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'scripts/rebuild-all-reviews.js'), 'utf8');
    assert.match(src, /soloVerdictHeld\(data, svKind\)/);
    assert.match(src, /single-verdict-holds\.json/);
    for (const k of ['showId', 'outletId', 'classifiers: sv.families']) assert.ok(src.includes(k), k);
  });
});
