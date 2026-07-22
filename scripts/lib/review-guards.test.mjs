import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isRejectedNonReview,
  isRetrieved,
  blocksRediscovery,
  hasValidScore,
  hasAggregatorExcerpt,
} = require('./review-guards.js');

/* ──────────────────────────────────────────────────────────────────────────
 * T1-retrieval canonical predicates (Sprint 1, task #291).
 *
 * Fixtures are the five real 2026-07-21 files, trimmed to the classification-
 * relevant fields (verified by reading the live review-texts corpus):
 *   AP/Beaches feature   beaches-2026/ap--mark-kennedy.json
 *   THR interview        hollywood-reporter interview shape
 *   BN news              broadwaynews news shape
 *   Cyrano garbage       cyrano-de-bergerac-west-end-2026/ap--unknown.json
 *   Grace stale-flag     grace-pervades-west-end-2026/guardian--mark-lawson.json
 * ────────────────────────────────────────────────────────────────────────── */

// 1. AP feature: CV feature + wrongArticle high + wrongProduction + invalid, no text.
const AP_BEACHES_FEATURE = {
  outletId: 'ap',
  contentTier: 'invalid',
  wrongProduction: true,
  wrongShow: true,
  contentVerification: { articleType: 'feature', wrongArticle: true, confidence: 'high' },
};

// 2. THR interview: CV interview type, no other flags.
const THR_INTERVIEW = {
  outletId: 'hollywood-reporter',
  contentTier: 'excerpt',
  fullText: 'x'.repeat(1200),
  contentVerification: { articleType: 'interview', wrongArticle: true, confidence: 'high' },
};

// 3. BN news: CV news type.
const BN_NEWS = {
  outletId: 'broadway-news',
  contentTier: 'excerpt',
  fullText: 'x'.repeat(900),
  contentVerification: { articleType: 'news', wrongArticle: true, confidence: 'high' },
};

// 4. Cyrano garbage: invalid tier + wrongProduction, no text/score.
const CYRANO_GARBAGE = {
  outletId: 'ap',
  contentTier: 'invalid',
  wrongProduction: true,
};

// 5. Grace stale-flag: real, scored review carrying a STALE wrongProduction flag
//    (no manual clear yet). Mis-attribution, NOT a non-review.
const GRACE_STALE_WRONGPROD = {
  outletId: 'guardian',
  contentTier: 'complete',
  wrongProduction: true,
  fullText: 'A substantial, real Guardian review of Grace Pervades. '.repeat(40),
  llmScore: { score: 80, band: 'anchored-v6' },
};

// ── isRejectedNonReview: the four non-review encodings ──────────────────────

test('AP/Beaches feature → rejected non-review (cv feature + wrongArticle + invalid)', () => {
  assert.equal(isRejectedNonReview(AP_BEACHES_FEATURE), true);
});

test('THR interview → rejected non-review (cv articleType interview)', () => {
  assert.equal(isRejectedNonReview(THR_INTERVIEW), true);
});

test('BN news → rejected non-review (cv articleType news)', () => {
  assert.equal(isRejectedNonReview(BN_NEWS), true);
});

test('Cyrano garbage → rejected non-review (contentTier invalid, no manual clear)', () => {
  assert.equal(isRejectedNonReview(CYRANO_GARBAGE), true);
});

// ── The critical counter-example: stale wrongProduction is NOT a non-review ──

test('Grace stale wrongProduction flag → NOT a rejected non-review (mis-attribution, real review)', () => {
  assert.equal(isRejectedNonReview(GRACE_STALE_WRONGPROD), false);
});

// ── isRejectedNonReview: exclusions and escape hatches ──────────────────────

test('wrong_production rejectionReason alone (no invalid, no CV non-review type) is NOT a non-review', () => {
  assert.equal(isRejectedNonReview({ outletId: 'nytimes', rejectionReason: 'wrong_production', fullText: 'real' }), false);
});

test('wrong_show rejectionReason alone is NOT a non-review', () => {
  assert.equal(isRejectedNonReview({ outletId: 'nytimes', rejectionReason: 'wrong_show', fullText: 'real' }), false);
});

test('not_a_review rejectionReason (non-star outlet) → non-review', () => {
  assert.equal(isRejectedNonReview({ outletId: 'nytimes', rejectionReason: 'not_a_review' }), true);
});

test('garbage_text rejectionReason → non-review', () => {
  assert.equal(isRejectedNonReview({ outletId: 'nytimes', rejectionReason: 'garbage_text' }), true);
});

test('truncated_text is a fetch-quality failure, NOT a non-review', () => {
  assert.equal(isRejectedNonReview({ outletId: 'nytimes', rejectionReason: 'truncated_text', fullText: 'x'.repeat(2000) }), false);
});

test('manual clear escapes the invalid-tier non-review classification', () => {
  const cleared = { ...AP_BEACHES_FEATURE, wrongProductionManualClear: true };
  assert.equal(isRejectedNonReview(cleared), false);
});

test('json-ld star not_a_review at a known-star outlet is a scored verdict, NOT a non-review', () => {
  const { KNOWN_STAR_OUTLETS } = require('./score-extractors');
  const starOutlet = [...KNOWN_STAR_OUTLETS][0];
  const file = {
    outletId: starOutlet,
    rejectionReason: 'not_a_review',
    aggregatorStarsSource: 'json-ld',
    aggregatorStars: 4,
  };
  assert.equal(isRejectedNonReview(file), false);
});

test('medium-confidence cv.wrongArticle on a review-type file is NOT a non-review (matches rebuild high-only gate)', () => {
  assert.equal(isRejectedNonReview({
    outletId: 'nytimes',
    contentTier: 'complete',
    fullText: 'A real review. '.repeat(50),
    contentVerification: { articleType: 'review', wrongArticle: true, confidence: 'medium' },
  }), false);
});

test('high-confidence cv.wrongArticle (no non-review articleType) IS a non-review', () => {
  assert.equal(isRejectedNonReview({
    outletId: 'nytimes',
    contentTier: 'complete',
    fullText: 'x'.repeat(500),
    contentVerification: { articleType: 'other', wrongArticle: true, confidence: 'high' },
  }), true);
});

test('clean CV review type with text → NOT a non-review', () => {
  assert.equal(isRejectedNonReview({
    outletId: 'nytimes',
    contentTier: 'complete',
    fullText: 'A real review. '.repeat(50),
    contentVerification: { articleType: 'review', wrongArticle: false },
  }), false);
});

test('null / undefined data → false (never throws)', () => {
  assert.equal(isRejectedNonReview(null), false);
  assert.equal(isRejectedNonReview(undefined), false);
});

// ── isRetrieved / blocksRediscovery: the RETRIEVED axis (S1-T2) ─────────────

test('scoreable file (text + score) is retrieved and blocks rediscovery', () => {
  const scored = { outletId: 'nytimes', contentTier: 'complete', fullText: 'A real review. '.repeat(50), llmScore: { score: 88 } };
  assert.equal(isRetrieved(scored), true);
  assert.equal(blocksRediscovery(scored), true);
});

test('rejected-feature file is NOT retrieved and does NOT block rediscovery', () => {
  assert.equal(isRetrieved(AP_BEACHES_FEATURE), false);
  assert.equal(blocksRediscovery(AP_BEACHES_FEATURE), false);
});

test('manual-cleared file blocks rediscovery even with no other content', () => {
  const cleared = { outletId: 'nytimes', wrongProduction: true, wrongProductionManualClear: true };
  assert.equal(isRetrieved(cleared), true);
  assert.equal(blocksRediscovery(cleared), true);
});

test('Grace stale wrongProduction (real, scored review) is retrieved → blocks rediscovery', () => {
  assert.equal(isRetrieved(GRACE_STALE_WRONGPROD), true);
  assert.equal(blocksRediscovery(GRACE_STALE_WRONGPROD), true);
});

test('cross-market-excluded file WITH full text still blocks rediscovery (retrieved != rebuild-included)', () => {
  // isIncludableForRebuild would exclude this via the cross-market context guard,
  // but we physically hold the outlet's review text — do NOT reopen discovery.
  const crossMarket = {
    outletId: 'guardian',
    contentTier: 'complete',
    fullText: 'A real West End review syndicated to a US-market show slot. '.repeat(30),
    crossOutletDuplicate: false,
  };
  assert.equal(isRetrieved(crossMarket), true);
  assert.equal(blocksRediscovery(crossMarket), true);
});

test('scored wrongProduction FP (Proof-2026-04-17 class) stays retrieved → keeps blocking URL rediscovery', () => {
  const scoredWrongProdFp = {
    outletId: 'nytimes',
    contentTier: 'complete',
    wrongProduction: true, // FP flag, but the review was scored
    fullText: 'A real review that a wrongProduction FP flag was set on. '.repeat(30),
    llmScore: { score: 74 },
  };
  assert.equal(isRetrieved(scoredWrongProdFp), true);
  assert.equal(blocksRediscovery(scoredWrongProdFp), true);
});

test('aggregator excerpt (no first-party text) counts as retrieved content', () => {
  assert.equal(hasAggregatorExcerpt({ bwwExcerpt: 'raved…' }), true);
  assert.equal(isRetrieved({ outletId: 'showscore', bwwExcerpt: 'raved…' }), true);
});

test('empty stub (no text, no score, no clear) is NOT retrieved → discovery reopens', () => {
  const emptyStub = { outletId: 'times-uk', contentTier: 'excerpt', fullText: '' };
  assert.equal(isRetrieved(emptyStub), false);
  assert.equal(blocksRediscovery(emptyStub), false);
});

test('null / undefined data → not retrieved (never throws)', () => {
  assert.equal(isRetrieved(null), false);
  assert.equal(blocksRediscovery(undefined), false);
});

// ── hasValidScore: the SCORED axis's score-presence half (S1-T2) ────────────

test('hasValidScore recognizes each score path', () => {
  assert.equal(hasValidScore({ humanReviewScore: 90 }), true);
  assert.equal(hasValidScore({ adjudicatedScore: 55 }), true);
  assert.equal(hasValidScore({ llmScore: { score: 72 } }), true);
  assert.equal(hasValidScore({ assignedScore: 61 }), true);
  assert.equal(hasValidScore({ aggregatorStars: 4 }), true);
  assert.equal(hasValidScore({ originalScoreNormalized: 80, originalScore: '4/5' }), true);
});

test('hasValidScore rejects unparseable originalScore and empty data', () => {
  assert.equal(hasValidScore({ originalScore: 'N/A' }), false);
  assert.equal(hasValidScore({ originalScore: '4/5', originalScoreCleared: true }), false);
  assert.equal(hasValidScore({}), false);
  assert.equal(hasValidScore(null), false);
});
