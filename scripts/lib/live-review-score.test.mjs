// BRO-8060 cousin: LLM prompts that state a review's verdict must use the site score.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildLiveScoreLookup } = require('./live-review-score.js');

test('site score wins over the raw file score; no twin keeps the file score', () => {
  const f = buildLiveScoreLookup([
    { showId: 's', outletId: 'nysr', criticName: 'C Critic', url: 'https://ex.com/c', assignedScore: 80 },
    { showId: 'other', outletId: 'nysr', criticName: 'C Critic', url: 'https://ex.com/c', assignedScore: 10 },
  ]);
  assert.equal(f('s', { outletId: 'nysr', criticName: 'C Critic', url: 'https://ex.com/c', assignedScore: 59 }), 80);
  assert.equal(f('s', { outletId: 'x', criticName: 'Nobody', url: 'https://ex.com/z', assignedScore: 59 }), 59);
  assert.equal(f('missing', { assignedScore: 42 }), 42);
});

// Every script that tells an LLM a review's verdict must read the site score.
test('verdict-prompting scripts are wired to live scores', () => {
  const pq = fs.readFileSync(new URL('../extract-pull-quotes.js', import.meta.url), 'utf8');
  assert.match(pq, /loadLiveScoreLookup\(path\.join\(REVIEW_TEXTS_DIR/);
  assert.match(pq, /shouldSkipForPriorRejection\(\{ \.\.\.data, assignedScore: score \}/, 'skip cache must hash the same score the prompt uses');
  assert.doesNotMatch(pq.slice(pq.indexOf('async function processReview')), /const score = typeof data\.assignedScore/);
  const cc = fs.readFileSync(new URL('../generate-critic-consensus.js', import.meta.url), 'utf8');
  assert.match(cc, /liveRows:\s*liveReviewRows/);
});

test('re-pick rules: wrong direction re-picks; human, locked, foreign-edited and no-live cases never do', () => {
  const { verdictBand, needsRetone, quoteVerdictStamp } = require('./live-review-score.js');
  assert.equal(verdictBand(59), 'mixed');
  assert.equal(verdictBand(80), 'positive');
  assert.equal(verdictBand(39), 'negative');
  assert.equal(verdictBand(undefined), 'unknown');
  const base = { llmPullQuote: 'A quote.', assignedScore: 59 };
  const live = { liveAvailable: true };
  assert.equal(needsRetone(base, 80, live), true, 'unstamped quote judged on 59, site 80');
  assert.equal(needsRetone(base, 62, live), false, 'same direction');
  assert.equal(needsRetone(base, 80, { liveAvailable: false }), false, 'no reviews.json: never flip back to file scores');
  assert.equal(needsRetone({ ...base, humanReviewScore: 80 }, 80, live), false);
  assert.equal(needsRetone({ ...base, llmPullQuoteSource: 'human-override' }, 80, live), false);
  assert.equal(needsRetone({ ...base, _locked: true }, 80, live), false);
  const stamped = { ...base, llmPullQuoteVerdictBand: quoteVerdictStamp(80, 'A quote.') };
  assert.equal(needsRetone(stamped, 80, live), false, 'already picked for positive');
  assert.equal(needsRetone(stamped, 30, live), true, 'site score moved to negative');
  assert.equal(needsRetone({ ...stamped, llmPullQuote: 'Merged in.' }, 80, live), true, 'stale stamp falls back to the file score (59 mixed vs site positive)');
  assert.equal(needsRetone({ ...base, approvedFixes: [{ field: 'llmPullQuote', fixId: 'x' }] }, 80, live), false, 'quote set by a review-field-edit plan');
  const pq = fs.readFileSync(new URL('../extract-pull-quotes.js', import.meta.url), 'utf8');
  assert.match(pq, /needsRetone\(data, score, \{ liveAvailable: !!liveScoreFor \}\)/);
  assert.match(pq, /liveScoreFor\(show, data\)/, 'key on the directory, like the rebuild');
  assert.match(pq, /current\.llmPullQuoteVerdictBand = quoteVerdictStamp\(score, quote\)/);
});
