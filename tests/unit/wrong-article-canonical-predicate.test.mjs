import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyWrongArticle } = require('../../scripts/lib/wrong-article-parity.js');
const { isRejectedNonReview } = require('../../scripts/lib/review-guards.js');

const base = (cv, extra = {}) => ({ outletId: 'x', contentVerification: { wrongArticle: true, ...cv }, ...extra });

test('high-confidence wrongArticle: canonical predicate agrees with the raw check', () => {
  const d = base({ confidence: 'high' });
  assert.equal(isRejectedNonReview(d), true);
  assert.equal(classifyWrongArticle(d).reason, 'agree');
});

test('medium/low confidence: raw check says junk, canonical keeps the file', () => {
  for (const confidence of ['medium', 'low']) {
    const d = base({ confidence });
    assert.equal(isRejectedNonReview(d), false);
    assert.equal(classifyWrongArticle(d).reason, `confidence-${confidence}`);
  }
});

test('a human clear is reported as manual-clear', () => {
  const d = base({ confidence: 'high' }, { wrongArticleManualClear: true });
  assert.equal(isRejectedNonReview(d), false);
  assert.equal(classifyWrongArticle(d).reason, 'manual-clear');
});

test('no verdict means nothing to compare', () => {
  assert.equal(classifyWrongArticle({}), null);
  assert.equal(classifyWrongArticle({ contentVerification: { wrongArticle: false } }), null);
});
