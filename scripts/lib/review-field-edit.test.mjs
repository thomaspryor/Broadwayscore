/**
 * Tests for scripts/lib/review-field-edit.js (BRO-4216).
 * Run: node --test scripts/lib/review-field-edit.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { applyReviewFieldEdit, resolveReviewPath, REVIEW_TEXT_EDITABLE_FIELDS } = require('./review-field-edit.js');

const stamp = { fixId: 'bro-4202', at: '2026-09-28T00:00:00.000Z' };

test('sets a verdict flag when the old value matches, and stamps provenance', () => {
  // mass-west-end-2026 times-uk--dominic-maxwell (BRO-4202)
  const rec = { outletId: 'times-uk', criticName: 'Dominic Maxwell' };
  const res = applyReviewFieldEdit(rec, { field: 'wrongAttribution', oldValue: null, newValue: true }, stamp);
  assert.equal(res.ok, true);
  assert.equal(res.record.wrongAttribution, true);
  assert.deepEqual(res.record.approvedFixes, [{ fixId: 'bro-4202', field: 'wrongAttribution', at: stamp.at }]);
  assert.equal(rec.wrongAttribution, undefined, 'input record is not mutated');
});

test('clears a stale rejection (english-2025 NYT, BRO-4202)', () => {
  const rec = { rejectedAt: '2026-03-02T23:19:38.824Z', rejectedBy: 'ensemble-scoreability-check' };
  const res = applyReviewFieldEdit(rec, { field: 'rejectedAt', oldValue: '2026-03-02T23:19:38.824Z', newValue: null }, stamp);
  assert.equal(res.ok, true);
  assert.equal(res.record.rejectedAt, null);
});

test('refuses fields outside the allowlist (scores, text, lock)', () => {
  for (const field of ['assignedScore', 'humanReviewScore', 'fullText', '_locked', 'url', 'approvedFixes']) {
    assert.equal(REVIEW_TEXT_EDITABLE_FIELDS.includes(field), false, field);
    const res = applyReviewFieldEdit({}, { field, oldValue: null, newValue: 1 }, stamp);
    assert.equal(res.ok, false, field);
  }
});

test('compare-and-set: refuses when the value changed since the plan was written', () => {
  const res = applyReviewFieldEdit({ criticName: 'Jesse Green' }, { field: 'criticName', oldValue: 'Jesse Schulman', newValue: 'X' }, stamp);
  assert.equal(res.ok, false);
  assert.match(res.reason, /changed since plan/);
});

test('refuses _locked records and non-scalar values', () => {
  assert.equal(applyReviewFieldEdit({ _locked: true }, { field: 'criticName', oldValue: null, newValue: 'A' }, stamp).ok, false);
  assert.equal(applyReviewFieldEdit({}, { field: 'criticName', oldValue: null, newValue: { a: 1 } }, stamp).ok, false);
});

test('clearing duplicateOf requires a clear reason first', () => {
  const res = applyReviewFieldEdit({ duplicateOf: 'a.json' }, { field: 'duplicateOf', oldValue: 'a.json', newValue: null }, stamp);
  assert.equal(res.ok, false);
  const ok = applyReviewFieldEdit({ duplicateOf: 'a.json', duplicateClearReason: 'x' }, { field: 'duplicateOf', oldValue: 'a.json', newValue: null }, stamp);
  assert.equal(ok.ok, true);
});

test('resolveReviewPath keeps paths inside review-texts', () => {
  const root = '/tmp/rt';
  assert.equal(resolveReviewPath(root, 'english-2025/nytimes--jesse-green.json'), path.join(root, 'english-2025/nytimes--jesse-green.json'));
  for (const bad of ['../x/y.json', 'english-2025/../../etc.json', '/abs/x.json', 'english-2025/x.txt', 'a/b/c.json', 'x.json', null]) {
    assert.equal(resolveReviewPath(root, bad), null, String(bad));
  }
});

// Ship-check finding: the write guard can add side effects (auto-flag
// wrongProduction on a date edit, duplicateOf on a URL collision). Those must
// fail the action instead of reporting success.
test('unexpectedChanges: ignores the edited field and the stamp, reports anything else', () => {
  const { unexpectedChanges } = require('./review-field-edit.js');
  const before = { criticName: 'A', publishDate: '2024-01-01', wrongProduction: undefined };
  assert.deepEqual(unexpectedChanges(before, { ...before, publishDate: '2024-02-01', approvedFixes: [{}] }, 'publishDate'), []);
  assert.deepEqual(
    unexpectedChanges(before, { ...before, publishDate: '2024-02-01', wrongProduction: true, duplicateOf: 'x.json' }, 'publishDate'),
    ['duplicateOf', 'wrongProduction'],
  );
  assert.deepEqual(unexpectedChanges({ a: null }, {}, 'b'), [], 'null and missing are the same');
});
