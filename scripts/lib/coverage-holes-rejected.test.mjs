// BRO-8381: class B ("rejected as not-a-review, verification says review") kept filing one owner card per show for
// rejections that were right: a recorded manual verdict, and a real review of another production (wrongProduction).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rejectedYetVerified } = require('./coverage-holes.js');

const show = { id: 'example-show-2026', title: 'Example Show', category: 'broadway' };
const cv = { articleType: 'review', articleTypeConfidence: 'high', isValid: true, wrongArticle: false };
const base = { outletId: 'example', url: 'https://example.com/example-show-review', isNonReview: true, contentVerification: cv, fullText: 'x' };
const f = 'data/review-texts/example-show-2026/example--a.json';

test('a plain CV-promoted rejection against a review verdict is still a B row', () => {
  const r = rejectedYetVerified({ ...base, isNonReviewReason: 'CV-promoted (not a review): preview' }, show, f);
  assert.ok(r && r.how === 'isNonReview');
});

test('a recorded manual verdict is a decision, not a B row', () => {
  assert.equal(rejectedYetVerified({ ...base, isNonReviewReason: 'manual (not a review): forum thread post' }, show, f), null);
});

test('wrongProduction (flag or CV) is a URL problem, not a B row', () => {
  assert.equal(rejectedYetVerified({ ...base, wrongProduction: true }, show, f), null);
  assert.equal(rejectedYetVerified({ ...base, contentVerification: { ...cv, wrongProduction: true } }, show, f), null);
});

test('a manual verdict the owner cleared is judged normally again', () => {
  const r = rejectedYetVerified({ ...base, isNonReviewReason: 'manual (not a review): x', nonReviewManualClear: true }, show, f);
  assert.equal(r, null); // cleared: not rejected any more
});
