// BRO-6233: the CV wrongArticle routing is one helper (cvWrongArticlePromotion)
// shared by both rebuild CV pre-passes and scoring-delta's replay, the BRO-6225
// partial-window rescore hook is one helper used by both pre-passes, and the
// mirror's cvWrongArticleHighConfidence rule is a named, classified helper.
// Requires the real functions (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideInclusion, FLAG_FIELDS } = require('./scoring-delta.js');
const guards = require('./lib/review-guards.js');
const { queueRescoreForCvPartialWindow, CV_PARTIAL_WINDOW_RESCORE_REASON } = require('./lib/rescore-flagging.js');

const show = { id: 'x-2026', title: 'X', openingDate: '2026-03-20', previewsStartDate: '2026-03-01', category: 'broadway' };
const cvNotReview = { wrongArticle: true, wrongProduction: false, articleType: 'interview', confidence: 'high', verifiedAt: '2026-03-26T00:00:00Z', reasoning: 'An interview, not a review.' };
const base = { assignedScore: 80, contentTier: 'complete', fullText: 'x'.repeat(2000), publishDate: '2026-03-25', outletId: 'nyt', contentVerification: cvNotReview };
const scored = { llmScore: { score: 80, confidence: 'high' } };

test('replay excludes an unscored not-a-review verdict the rebuild would promote', () => {
  assert.equal(guards.cvWrongArticlePromotion(base, cvNotReview), 'nonReview');
  assert.deepEqual(decideInclusion(base, show, guards), { included: false, reason: 'cv-promoted wrongArticle (nonReview)' });
});

test('replay keeps the rebuild carve-outs: ensemble score, human clear, head-of-article verdict', () => {
  const ensemble = { ...base, ...scored };
  assert.equal(guards.cvWrongArticlePromotion(ensemble, cvNotReview), 'advisory');
  assert.equal(decideInclusion(ensemble, show, guards).included, true);
  for (const clear of [{ wrongArticleManualClear: true }, { humanReviewedWrongArticle: false }, { nonReviewManualClear: true }]) {
    assert.equal(decideInclusion({ ...base, ...clear }, show, guards).included, true, JSON.stringify(clear));
  }
  const body = 'The production is a triumph and the cast is superb. '.repeat(120);
  const headCv = { ...cvNotReview, articleType: 'feature' };
  const head = { ...base, fullText: body, contentVerification: headCv };
  assert.equal(guards.cvWrongArticlePromotion(head, headCv, { cvPartialWindow: true }), null);
  assert.equal(decideInclusion(head, show, guards).included, true);
});

test('a routing change on one replay side is a flip (the 0/0 blind spot)', () => {
  const baseline = { ...guards, cvWrongArticlePromotion: () => null };
  assert.equal(decideInclusion(base, show, baseline).included, true);
  assert.equal(decideInclusion(base, show, guards).included, false);
});

test('a baseline without the helper falls back to the working-tree routing', () => {
  const old = { ...guards, cvWrongArticlePromotion: undefined };
  assert.deepEqual(decideInclusion(base, show, old), decideInclusion(base, show, guards));
});

test('wrongShow family, London skip and lane holds route like the pre-pass', () => {
  const cvWs = { ...cvNotReview, wrongProduction: true };
  assert.equal(guards.cvWrongArticlePromotion(base, cvWs), 'wrongShow');
  assert.equal(guards.cvWrongArticlePromotion({ ...base, wrongShowManualClear: true }, cvWs), null);
  assert.equal(guards.cvWrongArticlePromotion(base, cvWs, { skipLondon: true }), null);
  assert.equal(guards.cvWrongArticlePromotion(base, cvNotReview, { laneHolds: (g) => g === 'nonReview' }), null);
  assert.equal(guards.cvWrongArticlePromotion({ ...base, isNonReview: true }, cvNotReview), null);
  assert.equal(guards.cvWrongArticlePromotion(base, { ...cvNotReview, wrongArticle: false }), null);
});

test('fields the routing reads are FLAG_FIELDS, so a data sweep replays', () => {
  for (const f of ['llmScore', 'wrongArticleManualClear', 'humanReviewedWrongArticle', 'nonReviewManualClear', 'wrongShowManualClear', 'contentVerification']) {
    assert.ok(FLAG_FIELDS.has(f), f);
  }
});

test('isCvWrongArticleHighConfidence is the mirror rule explainExclusion applies', () => {
  assert.equal(guards.isCvWrongArticleHighConfidence(base), true);
  assert.equal(guards.explainExclusion(base, show), 'cvWrongArticleHighConfidence');
  assert.equal(guards.isCvWrongArticleHighConfidence({ ...base, wrongArticleManualClear: true }), false);
  assert.equal(guards.isCvWrongArticleHighConfidence({ ...base, contentVerification: { ...cvNotReview, confidence: 'medium' } }), false);
});

test('queueRescoreForCvPartialWindow flags a score older than the head-of-article verdict once', () => {
  const body = 'The production is a triumph and the cast is superb. '.repeat(120);
  const cv = { wrongArticle: true, wrongProduction: false, articleType: 'feature', confidence: 'high', verifiedAt: '2026-10-01T00:00:00Z' };
  const d = {
    outletId: 'theatermania', url: 'https://www.theatermania.com/news/x', showId: 's', fullText: body, contentTier: 'complete', wordCount: 1100,
    isNonReview: true, rejectionReason: 'not_a_review', isNonReviewReason: 'CV-promoted (not a review): feature',
    contentVerification: cv, llmScore: { score: 80, confidence: 'high' }, llmMetadata: { scoredAt: '2026-09-01T00:00:00Z' },
  };
  assert.equal(queueRescoreForCvPartialWindow(d, null, null), true);
  assert.equal(d.needsRescore, true);
  assert.equal(d.rescoreReason, CV_PARTIAL_WINDOW_RESCORE_REASON);
  assert.equal(queueRescoreForCvPartialWindow(d, null, null), false);
});

test('both rebuild CV pre-passes use the shared routing and rescore helpers', () => {
  const src = fs.readFileSync(new URL('./rebuild-all-reviews.js', import.meta.url), 'utf8');
  assert.equal((src.match(/\bcvWrongArticlePromotion\(/g) || []).length, 2, 'main + upcoming-show pre-pass');
  assert.equal((src.match(/\bqueueRescoreForCvPartialWindow\(/g) || []).length, 2, 'main + upcoming-show pre-pass');
  assert.ok(!/\bneedsRescoreForCvPartialWindow\(/.test(src), 'call queueRescoreForCvPartialWindow, not the bare predicate');
});

// BRO-6973: a clean-boolean verdict whose own articleType says interview/news is excluded too.
const cvCleanInterview = { isValid: true, wrongArticle: false, wrongProduction: false, articleType: 'interview', articleTypeConfidence: 'high', confidence: 'high', verifiedAt: '2026-03-26T00:00:00Z', reasoning: 'Interview with the choreographer.' };
const cleanBase = { ...base, contentVerification: cvCleanInterview };

test('BRO-6973: clean isValid verdict with high-confidence interview/news articleType is promoted to nonReview', () => {
  for (const articleType of ['interview', 'news', 'box-office', 'obituary']) {
    const cv = { ...cvCleanInterview, articleType };
    assert.equal(guards.cvWrongArticlePromotion({ ...base, contentVerification: cv }, cv), 'nonReview', articleType);
  }
  assert.deepEqual(decideInclusion(cleanBase, show, guards), { included: false, reason: 'cv-promoted wrongArticle (nonReview)' });
});

test('BRO-6973: preview/feature, medium articleType confidence, ensemble score and human clear stay live', () => {
  for (const cv of [{ ...cvCleanInterview, articleType: 'preview' }, { ...cvCleanInterview, articleType: 'feature' }, { ...cvCleanInterview, articleTypeConfidence: 'medium' }, { ...cvCleanInterview, articleType: 'review' }, { ...cvCleanInterview, isValid: false }]) {
    assert.equal(guards.cvWrongArticlePromotion({ ...base, contentVerification: cv }, cv), null, JSON.stringify(cv));
  }
  assert.equal(guards.cvWrongArticlePromotion({ ...cleanBase, ...scored }, cvCleanInterview), 'advisory');
  assert.equal(decideInclusion({ ...cleanBase, nonReviewManualClear: true }, show, guards).included, true);
});

test('BRO-6973: a head-of-article "news" verdict on a long clean-boolean row stays advisory', () => {
  const cv = { ...cvCleanInterview, articleType: 'news' };
  const cvLib = require('./lib/content-verifier.js');
  const long = { ...base, fullText: 'The production is a triumph. '.repeat(400), contentVerification: cv };
  assert.equal(cvLib.isCvVerdictFromPartialWindow(cv, long.fullText, long), true);
  assert.equal(guards.cvWrongArticlePromotion(long, cv, { cvPartialWindow: true }), null);
});
