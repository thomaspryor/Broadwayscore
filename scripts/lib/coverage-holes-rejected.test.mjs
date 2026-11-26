// BRO-8381: class B ("rejected as not-a-review, verification says review") kept filing one owner card per show for
// rejections that were right: a recorded manual verdict, and a real review of another production (wrongProduction).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rejectedYetVerified } = require('./coverage-holes.js');
process.on('exit', require('./shows-json-fixture.js').useShowsFixture([]));
const { approvedFixBinding } = require('./approved-fix-flag.js');

const show = { id: 'example-show-2026', title: 'Example Show', category: 'broadway' };
const cv = { articleType: 'review', articleTypeConfidence: 'high', isValid: true, wrongArticle: false };
const base = { outletId: 'example', url: 'https://example.com/example-show-review', isNonReview: true, contentVerification: cv, fullText: 'x' };
const f = 'data/review-texts/example-show-2026/example--a.json';

test('a plain CV-promoted rejection against a review verdict is still a B row', () => {
  const r = rejectedYetVerified({ ...base, isNonReviewReason: 'CV-promoted (not a review): preview' }, show, f);
  assert.ok(r && r.how === 'isNonReview');
});

const stamp = (d) => ({ ...d, approvedFixes: [{ fixId: 'f1', field: 'isNonReview', at: '2026-11-16T00:00:00Z', newValue: true, boundTo: approvedFixBinding(d) }] });

test('a manual verdict is only trusted when an approved plan stamped it (reason string alone stays B)', () => {
  const manual = { ...base, isNonReviewReason: 'manual (not a review): forum thread post' };
  assert.ok(rejectedYetVerified(manual, show, f));
});

test('a stamped manual verdict is a decision, not a B row', () => {
  const stamped = stamp({ ...base, isNonReviewReason: 'manual (not a review): forum thread post' });
  assert.equal(rejectedYetVerified(stamped, show, f), null);
});

test('wrongProduction is skipped only when the verification also reports it', () => {
  assert.equal(rejectedYetVerified({ ...base, wrongProduction: true, contentVerification: { ...cv, wrongProduction: true } }, show, f), null);
  assert.ok(rejectedYetVerified({ ...base, wrongProduction: true }, show, f)); // unbacked flag: a person looks
  assert.ok(rejectedYetVerified({ ...base, contentVerification: { ...cv, wrongProduction: true } }, show, f));
});

test('a stamp stops binding once the body changes (a refetched real review surfaces again)', () => {
  const stamped = stamp({ ...base, isNonReviewReason: 'manual (not a review): forum thread post' });
  assert.ok(rejectedYetVerified({ ...stamped, fullText: 'a different, refetched body' }, show, f));
});

test('a cleared rejection is not a B row', () => {
  assert.equal(rejectedYetVerified({ ...base, nonReviewManualClear: true }, show, f), null);
});
