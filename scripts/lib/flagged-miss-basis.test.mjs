/**
 * BRO-7660: a live exclusion flag a person stands behind settles a flagged-miss
 * row (humanExcluded, no re-verify). Run: node --test scripts/lib/flagged-miss-basis.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { hasHumanExclusionAssertion, classifyFlaggedMiss } = require('./flagged-miss-basis.js');
const { applyReviewFieldEdit } = require('./review-field-edit.js');

const stamp = { fixId: 'bro-7660', at: '2026-11-18T00:00:00.000Z' };
const body = 'A review of the earlier engagement at another theatre, several paragraphs long.';
const base = { url: 'https://example.com/review', fullText: body, outletId: 'example' };

function exclusionOf(rec) {
  return classifyFlaggedMiss([rec]).exclusion;
}

test('humanReviewedWrongShow on a live wrongShow is a human exclusion', () => {
  const rec = { ...base, wrongShow: true, wrongShowReason: 'CV-promoted: other show', humanReviewedWrongShow: true };
  assert.equal(hasHumanExclusionAssertion(rec), true);
  assert.equal(exclusionOf(rec), 'humanExcluded');
  // the flag alone, or the marker on a cleared flag, is not
  assert.equal(hasHumanExclusionAssertion({ ...rec, humanReviewedWrongShow: undefined }), false);
  assert.equal(hasHumanExclusionAssertion({ ...rec, wrongShow: false }), false);
});

test('a plan that re-asserts wrongProduction / wrongShow holds the row, through the real writer', () => {
  for (const field of ['wrongProduction', 'wrongShow']) {
    const rec = { ...base, [field]: true, [`${field}Reason`]: 'CV-promoted: different production' };
    assert.equal(hasHumanExclusionAssertion(rec), false, `${field}: automated flag alone`);
    const res = applyReviewFieldEdit(rec, { field, oldValue: true, newValue: true }, stamp);
    assert.equal(res.ok, true, res.reason);
    assert.equal(hasHumanExclusionAssertion(res.record), true, `${field}: plan-held`);
    assert.equal(exclusionOf(res.record), 'humanExcluded');
    // a refetched body unbinds the verdict: back to automated, re-verify again
    assert.equal(hasHumanExclusionAssertion({ ...res.record, fullText: 'A different, newly fetched review body.' }), false);
    // the flag since cleared: the stamp no longer asserts anything
    assert.equal(hasHumanExclusionAssertion({ ...res.record, [field]: false }), false);
  }
});

test('a plan-written manual non-review verdict holds the row; the CV promotion does not', () => {
  const cv = { ...base, isNonReview: true, isNonReviewReason: 'CV-promoted (not a review): an interview' };
  assert.equal(hasHumanExclusionAssertion(cv), false);
  const r1 = applyReviewFieldEdit(cv, { field: 'isNonReviewReason', oldValue: cv.isNonReviewReason,
    newValue: 'manual (not a review): interview piece, read 2026-11-18' }, stamp);
  assert.equal(r1.ok, true, r1.reason);
  assert.equal(hasHumanExclusionAssertion(r1.record), true);
  assert.equal(hasHumanExclusionAssertion({ ...r1.record, isNonReview: false }), false);
  // set fresh by a plan on a record that had no flag
  const fresh = { ...base, isNonReviewReason: 'manual (not a review): domain-for-sale page' };
  const r2 = applyReviewFieldEdit(fresh, { field: 'isNonReview', oldValue: null, newValue: true }, stamp);
  assert.equal(r2.ok, true, r2.reason);
  assert.equal(exclusionOf(r2.record), 'humanExcluded');
});

test('an approved stamp that CLEARED a flag is not an exclusion assertion', () => {
  const rec = { ...base, wrongProduction: true, wrongProductionReason: 'Date guard: review 2019-04-24 is 213d after' };
  const r1 = applyReviewFieldEdit(rec, { field: 'wrongProductionManualClear', oldValue: null, newValue: true }, stamp);
  const r2 = applyReviewFieldEdit(r1.record, { field: 'wrongProduction', oldValue: true, newValue: false }, stamp);
  assert.equal(r2.ok, true, r2.reason);
  assert.equal(hasHumanExclusionAssertion(r2.record), false);
});
