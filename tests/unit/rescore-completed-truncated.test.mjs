// BRO-5243: a truncated row completed by a later fetch must be rescored; its
// score was read from partial text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { shouldRescoreCompletedTruncated } = require('../../scripts/lib/review-filter.js');

const short = 'word '.repeat(400);  // ~2,000 chars
const full = 'word '.repeat(1100); // ~5,500 chars

test('truncated + scored + much longer text -> rescore', () => {
  assert.equal(shouldRescoreCompletedTruncated({ tierBefore: 'truncated', hasScore: true, textBefore: short, textAfter: full }), true);
});

test('no rescore when not truncated before, unscored, or barely longer', () => {
  assert.equal(shouldRescoreCompletedTruncated({ tierBefore: 'complete', hasScore: true, textBefore: short, textAfter: full }), false);
  assert.equal(shouldRescoreCompletedTruncated({ tierBefore: 'truncated', hasScore: false, textBefore: short, textAfter: full }), false);
  assert.equal(shouldRescoreCompletedTruncated({ tierBefore: 'truncated', hasScore: true, textBefore: short, textAfter: short + 'more words here.' }), false);
  assert.equal(shouldRescoreCompletedTruncated({ tierBefore: 'truncated', hasScore: true, textBefore: '', textAfter: full }), false);
});

test('excerpt, stub and needs-rescrape count as partial too; no tier or invalid do not (BRO-5261)', () => {
  for (const tierBefore of ['excerpt', 'stub', 'needs-rescrape']) {
    assert.equal(shouldRescoreCompletedTruncated({ tierBefore, hasScore: true, textBefore: short, textAfter: full }), true, tierBefore);
  }
  for (const tierBefore of [undefined, null, 'invalid', 'complete']) {
    assert.equal(shouldRescoreCompletedTruncated({ tierBefore, hasScore: true, textBefore: short, textAfter: full }), false, String(tierBefore));
  }
});
