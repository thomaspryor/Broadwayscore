// Broadway.com is a US-only audience source: a London show's broadwayCom entry
// can only be the Broadway production's rating, so it never enters the blend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { calculateCombinedScore } = require('./audience-weighting.js');

const sources = { broadwayCom: { score: 90, reviewCount: 50 }, mezzanine: { score: 70, reviewCount: 50 } };

test('broadwayCom is ignored for London-market shows', () => {
  const r = calculateCombinedScore(sources, { category: 'west-end' });
  assert.equal(r.score, 70);
  assert.equal(r.weights.broadwayCom, 0);
});

test('broadwayCom still counts for Broadway and when category is unknown', () => {
  assert.equal(calculateCombinedScore(sources, { category: 'broadway' }).score, 80);
  assert.equal(calculateCombinedScore(sources, undefined).score, 80);
});

test('inlined London check matches venue-classification.isLondonMarket', () => {
  const { isLondonMarket } = require('./venue-classification.js');
  for (const category of ['west-end', 'off-west-end', 'broadway', 'off-broadway', undefined, null, '']) {
    const r = calculateCombinedScore(sources, { category });
    assert.equal(r.weights.broadwayCom === 0, isLondonMarket(category), String(category));
  }
});

// BRO-4601: a tour or regional entry sharing a Broadway title got the Broadway
// production's Broadway.com rating, and a tour got r/Broadway title chatter.
test('broadwayCom is ignored for tours and regionals', () => {
  for (const category of ['tour', 'regional']) {
    const r = calculateCombinedScore(sources, { category });
    assert.equal(r.score, 70, category);
    assert.equal(r.weights.broadwayCom, 0, category);
  }
});

test('reddit is ignored for tours but kept for regional world premieres', () => {
  const withReddit = { mezzanine: { score: 70, reviewCount: 50 }, reddit: { score: 80, reviewCount: 200 } };
  assert.equal(calculateCombinedScore(withReddit, { category: 'tour' }).weights.reddit, 0);
  assert.ok(calculateCombinedScore(withReddit, { category: 'regional' }).weights.reddit > 0);
  assert.ok(calculateCombinedScore(withReddit, { category: 'broadway' }).weights.reddit > 0);
});
