import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyWrongArticle, wrongArticleVerdictStands } = require('../../scripts/lib/wrong-article-parity.js');
const { isRejectedNonReview } = require('../../scripts/lib/review-guards.js');

const base = (cv, extra = {}) => ({ outletId: 'x', contentVerification: { wrongArticle: true, ...cv }, ...extra });

test('high-confidence wrongArticle stands and the canonical predicate agrees', () => {
  const d = base({ confidence: 'high' });
  assert.equal(wrongArticleVerdictStands(d), true);
  assert.equal(isRejectedNonReview(d), true);
  assert.equal(classifyWrongArticle(d).reason, 'agree');
});

test('medium/low confidence is not junk (canonical keeps it)', () => {
  for (const confidence of ['medium', 'low', undefined]) {
    const d = base({ confidence });
    assert.equal(wrongArticleVerdictStands(d), false);
    assert.equal(isRejectedNonReview(d), false);
  }
});

test('a human clear overrides a high-confidence verdict', () => {
  const d = base({ confidence: 'high' }, { wrongArticleManualClear: true });
  assert.equal(wrongArticleVerdictStands(d), isRejectedNonReview(d));
  assert.equal(wrongArticleVerdictStands(d), false);
});

test('no verdict means nothing to compare', () => {
  assert.equal(classifyWrongArticle({}), null);
  assert.equal(wrongArticleVerdictStands({ contentVerification: { wrongArticle: false } }), false);
});

test('gather-reviews uses the shared predicate, not a raw wrongArticle check, for existing-file junk', () => {
  const src = fs.readFileSync(new URL('../../scripts/gather-reviews.js', import.meta.url), 'utf8');
  assert.match(src, /wrongArticleVerdictStands\(existingData\)/);
  assert.doesNotMatch(src, /existingData\.contentVerification\.wrongArticle === true/);
});
