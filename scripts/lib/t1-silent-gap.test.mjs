import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifySilentGap, shouldAlertGap } = require('./t1-silent-gap.js');

const NOW = new Date('2026-07-18T12:00:00Z');
const classify = (file, over = {}) =>
  classifySilentGap({ file, show: {}, tier: 1, outletScored: false, now: NOW, ...over });

// Fixture shapes are the two real 2026-07-18 incident files, trimmed.
const TIMES_EMPTY_STUB = {
  url: 'https://www.thetimes.com/culture/theatre-dance/article/the-oresteia-review-david-morrissey-bg8qzzhhn',
  criticName: 'Clive Davis',
  contentTier: 'excerpt',
  fullText: '',
};

const NYT_BOT_STUB_REJECTED = {
  url: 'https://www.nytimes.com/2026/07/15/theater/the-potluck-review-cesar-alvarez.html',
  criticName: 'Helen Shaw',
  contentTier: 'truncated',
  fullText: 'x'.repeat(2956),
  assignedScore: 62,
  rejectedBy: 'ensemble-scoreability-check',
  rejectedAt: '2026-07-18T06:37:19.249Z',
};

test('Times/Oresteia incident shape: empty T1 stub is a recoverable empty-body gap', () => {
  assert.deepEqual(classify(TIMES_EMPTY_STUB), { type: 'empty-body', recoverable: true });
});

test('NYT/Potluck incident shape: scoreability-rejected bot-stub is a gap even with an assignedScore', () => {
  assert.deepEqual(classify(NYT_BOT_STUB_REJECTED), { type: 'rejected-unscoreable', recoverable: false });
});

test('rejection re-fetched AFTER rejectedAt is revalidated (canonical) → unscored, not rejected', () => {
  const refetched = { ...NYT_BOT_STUB_REJECTED, textFetchedAt: '2026-07-18T07:00:00.000Z' };
  // passesFlagFilters treats post-rejection re-fetch as revalidated; the text
  // is fresh (< grace window) so nothing escalates yet.
  assert.equal(classify(refetched), null);
});

test('content present, never scored, past the grace window → unscored', () => {
  const gap = classify({
    url: 'https://x', fullText: 'y'.repeat(1000), contentTier: 'complete',
    textFetchedAt: '2026-07-17T00:00:00Z',
  }, { tier: 2 });
  assert.deepEqual(gap, { type: 'unscored', recoverable: false });
});

test('content fetched within the 12h grace window is NOT yet a gap', () => {
  assert.equal(classify({
    url: 'https://x', fullText: 'y'.repeat(1000), contentTier: 'complete',
    textFetchedAt: '2026-07-18T09:00:00Z',
  }), null);
});

test('tier 3+ outlets are never a silent gap', () => {
  assert.equal(classify(TIMES_EMPTY_STUB, { tier: 3 }), null);
});

test('outlet already scored (sibling file or reviews.json) → no gap', () => {
  assert.equal(classify(TIMES_EMPTY_STUB, { outletScored: true }), null);
});

test('legitimate editorial exclusions are not gaps', () => {
  for (const excl of [
    { wrongProduction: true },
    { wrongShow: true },
    { isNonReview: true },
    { isNotReview: true },
    { nonReviewFlag: true },
    { nonReviewContent: true },
    { isRoundupArticle: true },
    { fabricatedEntry: true },
    { isSyndicatedDuplicate: true },
    { crossOutletDuplicate: true },
    { wrongAttribution: true },
    { suspectedMisattribution: true },
    { duplicateOf: 'whatsonstage--matt-trueman.json' },
    { duplicateTextOf: 'a.json' },
    { rejectedAt: '2026-07-01T00:00:00Z', rejectionReason: 'not_a_review' },
    { humanReviewedWrongProduction: true },
    { contentVerification: { wrongArticle: true, confidence: 'high' } },
  ]) {
    assert.equal(classify({ ...TIMES_EMPTY_STUB, ...excl }), null,
      `expected null for ${JSON.stringify(excl)}`);
  }
});

test('wrong-URL discovery phantoms (QA finding) are not gaps and never recovered', () => {
  for (const sig of [
    { incompleteReason: 'url_content_mismatch', contentTier: 'stub' },
    { incompleteReason: 'scraper_garbage', contentTier: 'stub' },
    { incompleteReason: 'wrong_content' },
    { isBlockedReviewUrl: true, contentTier: 'stub' },
    { bwwAggregatorAmbiguous: true, contentTier: 'stub' },
  ]) {
    assert.equal(classify({ ...TIMES_EMPTY_STUB, ...sig }), null,
      `expected null for ${JSON.stringify(sig)}`);
  }
});

test('scored + includable file is not a gap (canonical predicate says it reaches reviews.json)', () => {
  assert.equal(classify({
    url: 'https://x', fullText: 'y'.repeat(5000),
    llmScore: { score: 39 }, assignedScore: 39,
  }), null);
});

test('adjudicated star-stub (The Stage class) is scored, not a gap', () => {
  assert.equal(classify({ url: 'https://x', fullText: '', contentTier: 'excerpt', adjudicatedScore: 62 }), null);
});

test('empty stub with contentTier=stub (flag-excluded but not editorial) is a recoverable gap', () => {
  assert.deepEqual(classify({ ...TIMES_EMPTY_STUB, contentTier: 'stub' }),
    { type: 'empty-body', recoverable: true });
});

test('empty-body over the retry cap stays a gap but is no longer recoverable', () => {
  assert.deepEqual(classify({ ...TIMES_EMPTY_STUB, aggUrlRecoveryCount: 3 }),
    { type: 'empty-body', recoverable: false });
});

test('flag-excluded empty stub over the retry cap is still REPORTED (2026-07-18: thestage paywall stubs vanished from the audit unresolved)', () => {
  assert.deepEqual(classify({
    ...TIMES_EMPTY_STUB, contentTier: 'stub', incompleteReason: 'paywall', aggUrlRecoveryCount: 3,
  }), { type: 'empty-body', recoverable: false });
});

test('contentTier=invalid garbage is NOT an empty-body gap (re-ingest can only re-fetch garbage)', () => {
  assert.equal(classify({
    ...TIMES_EMPTY_STUB, contentTier: 'invalid', aggUrlRecoveryCount: 3,
  }), null);
});

test('star-scored textless stub is not a gap; junk originalScore stub still is', () => {
  // First-party page stars (stage-star-svg pattern) — rebuild will score it.
  assert.equal(classify({
    ...TIMES_EMPTY_STUB, contentTier: 'stub',
    originalScore: '3/5 stars', originalScoreNormalized: 60, aggUrlRecoveryCount: 3,
  }), null);
  // Letter grade parses via isUnambiguousRatingString — also a valid score.
  assert.equal(classify({
    ...TIMES_EMPTY_STUB, contentTier: 'stub', originalScore: 'B+', aggUrlRecoveryCount: 3,
  }), null);
  // Unparseable originalScore is NOT a score — must stay visible as a gap.
  assert.deepEqual(classify({
    ...TIMES_EMPTY_STUB, contentTier: 'stub', originalScore: 'N/A', aggUrlRecoveryCount: 3,
  }), { type: 'empty-body', recoverable: false });
});

test('alert dedupe: never-alerted fires, recent alert suppresses, 8-day-old re-fires', () => {
  assert.equal(shouldAlertGap(null, NOW), true);
  assert.equal(shouldAlertGap('2026-07-17T12:00:00Z', NOW), false);
  assert.equal(shouldAlertGap('2026-07-10T11:00:00Z', NOW), true);
  assert.equal(shouldAlertGap('garbage', NOW), true);
});
