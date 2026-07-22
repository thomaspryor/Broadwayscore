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
