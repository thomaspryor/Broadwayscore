import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { humanScoreOutsideStarBand } = require('../../scripts/lib/human-score-star-guard.js');

// Real Slam Frank shape: Culture Sauce 2/5 stars, anchored 39 in band 31-50.
const twoStar = { originalScore: '2/5 stars', originalScoreSource: 'unicode-stars', llmScore: { score: 39 } };

test('Culture Sauce 2/5: the 58 and 66 overrides that were wrongly applied are refused', () => {
  for (const s of [58, 66]) {
    const r = humanScoreOutsideStarBand(twoStar, s);
    assert.equal(r.floor, 31);
    assert.equal(r.ceiling, 50);
  }
});

test('a score inside the star band is allowed, including both edges', () => {
  for (const s of [31, 39, 50]) assert.equal(humanScoreOutsideStarBand(twoStar, s), null);
});

test('3/5 and 4/5 bands match starToBand (51-70, 71-90)', () => {
  assert.equal(humanScoreOutsideStarBand({ originalScore: '3/5 stars' }, 60), null);
  assert.equal(humanScoreOutsideStarBand({ originalScore: '3/5 stars' }, 71).ceiling, 70);
  assert.equal(humanScoreOutsideStarBand({ originalScore: '4/5' }, 78), null);
  assert.equal(humanScoreOutsideStarBand({ originalScore: '4/5' }, 91).floor, 71);
});

test('an uncorroborated generic-pattern star (Mincemeat junk 1/5, BRO-4499) does not block a correct override', () => {
  const junk = { originalScore: '1/5', originalScoreSource: 'numeric-stars', llmScore: { score: 85, confidence: 'high' } };
  assert.equal(humanScoreOutsideStarBand(junk, 80), null);
});

test('a review with no star or grade is never blocked', () => {
  assert.equal(humanScoreOutsideStarBand({ llmScore: { score: 49 } }, 90), null);
  assert.equal(humanScoreOutsideStarBand(null, 90), null);
});
