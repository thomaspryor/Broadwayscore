/**
 * Regression test for BRO-4152 #3: extract-theatre-record.js's
 * --no-skip-existing merge only filled fullText when it was blank, leaving a
 * paywall stub / invalid-tier body (and its stale wrongShow/score state)
 * stuck on disk forever even after TR's complete text became available.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeTrReviewOnExisting } = require('./tr-merge-review.js');

const TR_REVIEW_DATA = {
  showId: 'golden-boy-off-west-end-2026',
  outletId: 'daily-mail',
  outlet: 'Daily Mail',
  criticName: 'Patrick Marmion',
  publishDate: '2026-09-16',
  fullText: 'Golden Boy is a barnstorming revival at the Almeida that lands every punch.',
  isFullReview: true,
  contentTier: 'complete',
  contentTierReason: 'Full review text from Theatre Record',
  source: 'theatre-record',
  theatreRecordUrl: 'https://www.theatrerecord.com/archive/2026/9/golden-boy',
  addedAt: '2026-09-24T00:00:00.000Z',
  textWordCount: 13,
};

test('replaces a paywall-stub fullText and bumps contentTier together', () => {
  const existing = {
    showId: 'golden-boy-off-west-end-2026',
    outletId: 'daily-mail',
    outlet: 'Daily Mail',
    criticName: 'Patrick Marmion',
    url: 'https://www.dailymail.co.uk/tvshowbiz/article-golden-boy.html',
    fullText: 'Shining: Josh O’Connor Showbiz / Theatre... [Mail+ subscribers only]',
    contentTier: 'invalid',
    source: 'submit-review-form',
    sources: ['submit-review-form'],
  };
  const merged = mergeTrReviewOnExisting(existing, TR_REVIEW_DATA);
  assert.equal(merged.fullText, TR_REVIEW_DATA.fullText);
  assert.equal(merged.textWordCount, TR_REVIEW_DATA.textWordCount);
  assert.equal(merged.contentTier, 'complete');
  assert.equal(merged.contentTierReason, TR_REVIEW_DATA.contentTierReason);
  // url (an identity field this merge never touches) is preserved
  assert.equal(merged.url, existing.url);
  assert.ok(merged.sources.includes('theatre-record'));
  assert.equal(merged.theatreRecordUrl, TR_REVIEW_DATA.theatreRecordUrl);
});

test('clears stale wrongShow/wrongProduction + score state tied to the replaced body', () => {
  // Shape mirrors the real kinky-boots-the-musical-west-end-2026 Daily Mail
  // file: a ScrapingBee-fetched wrong-show scrape with a full ensemble score
  // and a wrongShow verdict, both computed against text that TR's real
  // Kinky Boots review would replace.
  const existing = {
    fullText: 'Clueless (Trafalgar Theatre, London)... [1000+ chars of the wrong show]',
    contentTier: 'invalid',
    contentTierReason: 'Wrong show',
    wrongShow: true,
    wrongShowReason: 'CV-promoted: review is for Clueless, not Kinky Boots',
    wrongProduction: true,
    wrongProductionReason: 'CV-promoted: review is for Clueless, not Kinky Boots',
    contentVerification: {
      isValid: false,
      wrongProduction: true,
      wrongArticle: false,
      isFilmTv: false,
      reasoning: 'Wrong production',
    },
    contentVerificationPromoted: 'rebuild: promoted from contentVerification',
    llmScore: { score: 64, bucket: 'Positive' },
    llmMetadata: { model: 'ensemble:claude+gpt+gemini' },
    ensembleData: { votes: [1, 1, 0] },
    assignedScore: 64,
    needsReview: true,
    needsReviewReason: 'Collector LLM: wrong production (high conf) but already scored',
    rejectedAt: '2026-04-02T10:26:59.966Z',
    rejectedBy: 'ensemble-scoreability-check',
    rejectionReason: 'wrong_show',
    rejectionReasoning: 'claude: this review is about Clueless...',
    incompleteReason: 'wrong_content',
    incompleteDetail: 'CV-promoted: wrong show',
    textQuality: 'full',
    truncationSignals: ['no_ending_punctuation'],
    textStatus: 'complete',
    classifiedAt: '2026-04-02T10:15:02.343Z',
    promptVersion: '5.3.0',
    needsRefetch: true,
    _scoreNote: 'Re-collected for score extraction (2026-04-04)',
  };
  const merged = mergeTrReviewOnExisting(existing, TR_REVIEW_DATA);

  assert.equal(merged.fullText, TR_REVIEW_DATA.fullText, 'fullText replaced');
  assert.equal(merged.contentTier, 'complete');
  assert.equal(merged.wrongShow, undefined, 'stale wrongShow cleared');
  assert.equal(merged.wrongShowReason, undefined);
  assert.equal(merged.wrongProduction, undefined, 'stale wrongProduction cleared');
  assert.equal(merged.wrongProductionReason, undefined);
  assert.equal(merged.contentVerification.isValid, true, 'embedded CV verdict corrected too');
  assert.equal(merged.contentVerification.wrongProduction, false);
  assert.ok(merged.wrongProductionOverride, 'clear is recorded so guards don\'t re-promote it next rebuild');

  for (const field of [
    'llmScore', 'llmMetadata', 'ensembleData', 'assignedScore', 'needsReview',
    'needsReviewReason', 'rejectedAt', 'rejectedBy', 'rejectionReason',
    'rejectionReasoning', 'contentVerificationPromoted', 'incompleteReason',
    'incompleteDetail', 'textQuality', 'truncationSignals', 'textStatus',
    'classifiedAt', 'promptVersion', '_scoreNote',
  ]) {
    assert.equal(merged[field], undefined, `${field} cleared`);
  }
  assert.equal(merged.needsRefetch, false, 'needsRefetch reset so a stale flag can\'t trigger a re-clobber');
});

test('does NOT touch fullText/contentTier/scores when the existing content is already good', () => {
  const existing = {
    fullText: 'A perfectly good, already-complete review of the correct show.',
    contentTier: 'complete',
    llmScore: { score: 80, bucket: 'Rave' },
    assignedScore: 80,
    sources: ['guardian'],
  };
  const merged = mergeTrReviewOnExisting(existing, TR_REVIEW_DATA);
  assert.equal(merged.fullText, existing.fullText, 'good existing text is preserved, not overwritten');
  assert.equal(merged.contentTier, 'complete');
  assert.deepEqual(merged.llmScore, existing.llmScore, 'score on a good file is left alone');
  assert.equal(merged.assignedScore, 80);
  // Non-gated fields still update unconditionally
  assert.equal(merged.theatreRecordUrl, TR_REVIEW_DATA.theatreRecordUrl);
  assert.ok(merged.sources.includes('theatre-record'));
});

test('does not mutate the input objects', () => {
  const existing = { fullText: '', contentTier: 'invalid' };
  const existingCopy = { ...existing };
  const reviewDataCopy = { ...TR_REVIEW_DATA };
  mergeTrReviewOnExisting(existing, TR_REVIEW_DATA);
  assert.deepEqual(existing, existingCopy);
  assert.deepEqual(TR_REVIEW_DATA, reviewDataCopy);
});
