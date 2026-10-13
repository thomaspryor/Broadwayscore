// BRO-5231: URL-corrected reviews must not be skipped by the "already has good
// text / already scored" short-circuits in collect-review-texts.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isUrlCorrectedRefetch, mayShortCircuitCollected } = require('../../scripts/lib/url-corrected-refetch.js');
const { shouldSkipScoredReview } = require('../../scripts/lib/review-guards.js');

const stale = {
  needsRefetch: true,
  urlCorrectedFrom: 'https://example.com/old',
  contentTier: 'complete',
  textQuality: 'full',
  fullText: 'x'.repeat(4000),
  assignedScore: 77,
};
const opts = (d, over = {}) => ({
  isTruncated: false,
  hasGarbageText: false,
  datelessDateRetry: false,
  completeSkip: d.contentTier === 'complete' || d.textQuality === 'full',
  scoredSkip: shouldSkipScoredReview(d, 0),
  ...over,
});

test('url-corrected complete+scored review is NOT short-circuited', () => {
  assert.equal(isUrlCorrectedRefetch(stale), true);
  assert.equal(opts(stale).completeSkip, true);
  assert.equal(opts(stale).scoredSkip, true);
  assert.equal(mayShortCircuitCollected(stale, opts(stale)), false);
});

test('ordinary complete review is still skipped', () => {
  const d = { ...stale, needsRefetch: false, urlCorrectedFrom: undefined };
  assert.equal(isUrlCorrectedRefetch(d), false);
  assert.equal(mayShortCircuitCollected(d, opts(d)), true);
});

test('ordinary scored-only review is still skipped', () => {
  const d = { fullText: 'x'.repeat(500), assignedScore: 70 };
  assert.equal(mayShortCircuitCollected(d, opts(d)), true);
});

test('needsRefetch without urlCorrectedFrom is not a url correction', () => {
  assert.equal(isUrlCorrectedRefetch({ needsRefetch: true }), false);
  assert.equal(isUrlCorrectedRefetch(null), false);
});

test('collector wires the real predicate (no inline copy)', () => {
  const src = fs.readFileSync(new URL('../../scripts/collect-review-texts.js', import.meta.url), 'utf8');
  assert.match(src, /require\('\.\/lib\/url-corrected-refetch'\)/);
  assert.match(src, /mayShortCircuitCollected\(data,/);
  assert.match(src, /const urlCorrectedRefetch = isUrlCorrectedRefetch\(data\)/);
});
