// BRO-4838: a person's "this is a review" clear must stop the scorer from re-stamping a not_a_review rejection
// (From the Heart, Theatre News: restored, then re-rejected by the scorer the same evening).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { humanClearOverridingRejection } = require('../../scripts/lib/human-cleared-rejection.js');

test('nonReviewManualClear overrules a not_a_review rejection', () => {
  assert.equal(humanClearOverridingRejection({ nonReviewManualClear: true }, 'not_a_review'), 'non-review');
});

test('a wrongArticle clear does not overrule not_a_review (right article, not necessarily a review)', () => {
  assert.equal(humanClearOverridingRejection({ wrongArticleManualClear: true }, 'not_a_review'), null);
  assert.equal(humanClearOverridingRejection({ humanReviewedWrongArticle: false }, 'not_a_review'), null);
});

test('a non-review clear does not overrule wrong_show, wrong_production or garbage_text', () => {
  for (const r of ['wrong_show', 'wrong_production', 'garbage_text']) {
    assert.equal(humanClearOverridingRejection({ nonReviewManualClear: true }, r), null, r);
  }
});

test('production and show clears keep overruling wrong_production / wrong_show, and only those', () => {
  for (const f of ['wrongProductionManualClear', 'wrongProductionOverride', 'wrongShowManualClear', 'wrongShowOverride', 'isCombinedReview', 'wrongProductionCleared', 'wrongShowCleared']) {
    assert.equal(humanClearOverridingRejection({ [f]: true }, 'wrong_production'), 'production-or-show', f);
    assert.equal(humanClearOverridingRejection({ [f]: true }, 'wrong_show'), 'production-or-show', f);
    assert.equal(humanClearOverridingRejection({ [f]: true }, 'not_a_review'), null, f);
  }
  assert.equal(humanClearOverridingRejection({ humanReviewedWrongProduction: false }, 'wrong_show'), 'production-or-show');
});

test('no clear: the rejection stands', () => {
  assert.equal(humanClearOverridingRejection({}, 'not_a_review'), null);
  assert.equal(humanClearOverridingRejection({ nonReviewManualClear: false }, 'not_a_review'), null);
  assert.equal(humanClearOverridingRejection(null, 'not_a_review'), null);
});
