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
  assert.match(pq, /loadLiveScoreLookup\(\)/);
  assert.match(pq, /shouldSkipForPriorRejection\(\{ \.\.\.data, assignedScore: score \}/, 'skip cache must hash the same score the prompt uses');
  assert.doesNotMatch(pq.slice(pq.indexOf('async function processReview')), /const score = typeof data\.assignedScore/);
  const cc = fs.readFileSync(new URL('../generate-critic-consensus.js', import.meta.url), 'utf8');
  assert.match(cc, /liveRows:\s*liveReviewRows/);
});

test('stored quotes picked for another verdict direction are re-picked, and stamped so they do not loop', () => {
  const { verdictBand } = require('./live-review-score.js');
  assert.equal(verdictBand(59), 'mixed');
  assert.equal(verdictBand(80), 'positive');
  assert.equal(verdictBand(39), 'negative');
  assert.equal(verdictBand(undefined), 'unknown');
  const pq = fs.readFileSync(new URL('../extract-pull-quotes.js', import.meta.url), 'utf8');
  assert.match(pq, /data\.llmPullQuoteVerdictBand \|\| verdictBand\(data\.assignedScore\)/);
  assert.match(pq, /current\.llmPullQuoteVerdictBand = verdictBand\(score\)/);
});
