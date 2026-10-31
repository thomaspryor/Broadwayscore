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
  assert.equal(pick('a.json', canon, Object.keys(files), load).file, 'b.json');
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
test('letter grade twin from a grade-printing outlet is inherited', () => {
  const f2 = { 'a.json': { ...canon, outletId: 'ew' }, 'b.json': { url: URL, outletId: 'ew', originalScore: 'B+' } };
  const sib = pick('a.json', f2['a.json'], Object.keys(f2), (n) => f2[n]);
  assert.ok(sib, 'EW B+ should inherit');
  assert.ok(getBestScore({ ...f2['a.json'] }, { siblingRating: sib }).score <= 84);
});
test('different critic on a shared URL without a duplicate link is not a twin', () => {
  const a = { ...canon, criticName: 'Ann Lee' };
  const f2 = { 'a.json': a, 'b.json': { url: URL, originalScore: '3/5 stars', criticName: 'Bob Roe' } };
  assert.equal(pick('a.json', a, Object.keys(f2), (n) => f2[n]), null);
  f2['b.json'].duplicateOf = 'a.json';
  assert.ok(pick('a.json', a, Object.keys(f2), (n) => f2[n]));
});
test('relay-only twin rating does not bind', () => {
  const f2 = { 'a.json': canon, 'b.json': { url: URL, starRating: 'n/a', aggregatorStars: '3/5 stars' } };
  assert.equal(pick('a.json', canon, Object.keys(f2), (n) => f2[n]), null);
});
test('percentage twin ratings are not inherited', () => {
  const f2 = { 'a.json': canon, 'b.json': { url: URL, originalScore: '40%' } };
  assert.equal(pick('a.json', canon, Object.keys(f2), (n) => f2[n]), null);
});
test('clamp uses the inherited rating; without it the score is untouched', () => {
  const without = getBestScore({ ...canon }, {});
  const withSib = getBestScore({ ...canon }, { siblingRating: pick('a.json', canon, Object.keys(files), load) });
  assert.ok(without.score > 70, `unclamped ${without.score}`);
  assert.ok(withSib.score >= 51 && withSib.score <= 70, `clamped ${withSib.score}`);
});
