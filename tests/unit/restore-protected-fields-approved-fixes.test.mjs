// BRO-7131: an owner-approved fix erased by a stale CI writer's -X theirs rebase comes back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reconcileProtectedFields } = require('../../scripts/lib/restore-protected-fields.js');

const fix = (field, newValue, at) => ({ fixId: 'f1', field, at, newValue });

test('stale writer that dropped an approved fix gets it re-applied', () => {
  const remote = { url: 'u', fetchDiscoveryAbandoned: true, isNonReviewReason: 'manual (not a review): x', isNonReview: true,
    approvedFixes: [fix('isNonReviewReason', 'manual (not a review): x', '2026-11-08T19:36:31.392Z'), fix('isNonReview', true, '2026-11-08T19:36:31.543Z')] };
  const local = { url: 'u', fetchDiscoveryAbandoned: true, incompleteDetail: '81 timeout attempts' };
  const r = reconcileProtectedFields(local, remote, null);
  assert.equal(r.modified, true);
  assert.equal(local.isNonReview, true);
  assert.equal(local.isNonReviewReason, 'manual (not a review): x');
  assert.equal(local.approvedFixes.length, 2);
  assert.equal(local.incompleteDetail, '81 timeout attempts');
});

test('a local that already has the stamp is left alone (later change wins)', () => {
  const stamp = fix('isNonReview', true, '2026-11-08T19:36:31Z');
  const remote = { isNonReview: true, approvedFixes: [stamp] };
  const local = { isNonReview: false, approvedFixes: [stamp] };
  reconcileProtectedFields(local, remote, null);
  assert.equal(local.isNonReview, false);
});

test('a newer local approved fix on the same field is not overridden', () => {
  const remote = { isNonReview: true, approvedFixes: [fix('isNonReview', true, '2026-11-01T00:00:00Z')] };
  const local = { approvedFixes: [{ fixId: 'f2', field: 'isNonReview', at: '2026-11-05T00:00:00Z', newValue: null }] };
  reconcileProtectedFields(local, remote, null);
  assert.equal(local.isNonReview, undefined);
  assert.equal(local.approvedFixes.length, 2);
});

test('no approvedFixes anywhere: no change', () => {
  const local = { a: 1 };
  const r = reconcileProtectedFields(local, { a: 1 }, null);
  assert.equal(local.approvedFixes, undefined);
  assert.equal(r.notes.some((n) => /approved/.test(n)), false);
});

test('a fix the source later cleared (URL change) is not re-applied, only its stamp', () => {
  const stamp = { fixId: 'f1', field: 'isNonReview', at: '2026-11-01T00:00:00Z', newValue: true, boundTo: { url: 'old', contentHash: 'x' } };
  const remote = { url: 'new', isNonReview: false, _urlChangedClear: { isNonReview: true }, approvedFixes: [stamp] };
  const local = { url: 'new', _urlChangedClear: { isNonReview: true } };
  reconcileProtectedFields(local, remote, null);
  assert.notEqual(local.isNonReview, true);
  assert.equal(local.approvedFixes.length, 1);
});

test('a field with side effects (wrongShow) gets its stamp back but not its value', () => {
  const remote = { wrongShow: false, contentTier: 'full', approvedFixes: [{ fixId: 'f1', field: 'wrongShow', at: '2026-11-01T00:00:00Z', newValue: false }] };
  const local = { wrongShow: true, contentTier: 'invalid' };
  reconcileProtectedFields(local, remote, null);
  assert.equal(local.wrongShow, true);
  assert.equal(local.approvedFixes.length, 1);
});

test('a true flag no longer bound to the body is not re-applied', () => {
  const remote = { url: 'u', fullText: 'new body', isNonReview: true, approvedFixes: [{ fixId: 'f1', field: 'isNonReview', at: '2026-11-01T00:00:00Z', newValue: true, boundTo: { url: 'u', contentHash: 'deadbeefdeadbeef' } }] };
  const local = { url: 'u', fullText: 'new body' };
  reconcileProtectedFields(local, remote, null);
  assert.notEqual(local.isNonReview, true);
});
