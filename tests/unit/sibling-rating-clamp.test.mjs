// BRO-6078: canonical with no rating clamps against its same-URL twin's rating.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { siblingRatingForClamp } = require('../../scripts/lib/sibling-rating-inherit.js');
const { getBestScore } = require('../../scripts/lib/rebuild-helpers.js');
const { canonicalizeUrlForDedup } = require('../../scripts/lib/review-guards.js');
const { detectBandFromReviewFile } = require('../../scripts/lib/star-reliability.js');

const URL = 'https://example.com/review/x';
const canon = { url: URL, outletId: 'timeout', llmScore: { score: 94, confidence: 'high' }, scoreSource: 'llm-v6' };
const files = { 'a.json': canon, 'b.json': { url: URL, originalScore: '3/5 stars', duplicateOf: 'a.json' } };
const load = (n) => files[n] || null;
const pick = (f, d, all, ld) => siblingRatingForClamp(f, d, all, ld, canonicalizeUrlForDedup, detectBandFromReviewFile);

test('inherits the same-URL twin rating', () => {
  assert.equal(pick('a.json', canon, Object.keys(files), load), '3/5 stars');
});
test('own rating wins: no inheritance', () => {
  const own = { ...canon, originalScore: '4/5 stars' };
  assert.equal(pick('a.json', own, Object.keys(files), load), null);
});
test('twins disagreeing on band: no inheritance', () => {
  const f2 = { ...files, 'c.json': { url: URL, originalScore: '5/5 stars' } };
  assert.equal(pick('a.json', canon, Object.keys(f2), (n) => f2[n]), null);
});
test('flagged / other-URL twins ignored', () => {
  const f2 = { 'a.json': canon, 'b.json': { url: URL, originalScore: '3/5 stars', wrongProduction: true }, 'c.json': { url: 'https://example.com/other', originalScore: '3/5 stars' } };
  assert.equal(pick('a.json', canon, Object.keys(f2), (n) => f2[n]), null);
});
test('clamp uses the inherited rating; without it the score is untouched', () => {
  const without = getBestScore({ ...canon }, {});
  const withSib = getBestScore({ ...canon }, { siblingRating: '3/5 stars' });
  assert.ok(without.score > 70, `unclamped ${without.score}`);
  assert.ok(withSib.score >= 51 && withSib.score <= 70, `clamped ${withSib.score}`);
});
