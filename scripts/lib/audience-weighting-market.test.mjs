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
