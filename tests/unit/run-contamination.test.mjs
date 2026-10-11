// BRO-5000/BRO-4998: republished-page detection, script-clear retraction, human-flag-vs-clear.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const rc = require('../../scripts/lib/run-contamination.js');
const guard = require('../../scripts/lib/review-write-guard.js');
const { applyReviewFieldEdit } = require('../../scripts/lib/review-field-edit.js');

const show = { previewsStartDate: '2026-09-10', openingDate: '2026-09-20' };

test('republish banner naming an earlier year excludes', () => {
  const r = rc.evaluateRepublishedReview({ fullText: 'Intro\n\nThis review is from 2025\n\nBody', show, publishDate: '2026-09-22' });
  assert.equal(r.exclude, true);
  assert.equal(r.markerYear, 2025);
});

test('play history is not a republish marker', () => {
  const r = rc.evaluateRepublishedReview({ fullText: 'The play was first published in Italy in 1957 and revived since.', show });
  assert.equal(r.exclude, false);
  assert.equal(rc.republishMarker('The novel was originally published in 1962.'), null);
});

test('year typo that matches the publish date stays counted (Beautiful, Theater Life)', () => {
  const r = rc.evaluateRepublishedReview({
    fullText: 'Originally Published on January 13, 2013 in ArtsinNY.com',
    show: { previewsStartDate: '2013-11-21', openingDate: '2014-01-12' },
    publishDate: '2014-01-15',
  });
  assert.equal(r.exclude, false);
  assert.equal(r.reason, 'year-typo-matches-publish-date');
});

test('declared prior run covering the stated year keeps the review', () => {
  const s = { ...show, priorRuns: [{ openingDate: '2025-02-01', closingDate: '2025-04-30' }] };
  const r = rc.evaluateRepublishedReview({ fullText: 'This review is from 2025', show: s, publishDate: '2026-09-22' });
  assert.equal(r.exclude, false);
  assert.equal(r.reason, 'covered-by-declared-run');
});

test('month-aware: December 2025 banner on a January 2026 show is not excluded', () => {
  const r = rc.evaluateRepublishedReview({
    fullText: 'This review is from December 2025', show: { previewsStartDate: '2026-01-10' }, publishDate: '2026-01-20',
  });
  assert.equal(r.exclude, false);
});

test('a plan flag after a script clear is a conflict; a plan clear is not a flag', () => {
  const base = {
    wrongProduction: true, wrongProductionManualClear: true, wrongProductionOverride: true,
    wrongProductionOverrideSetBy: 'clear-stale-wrong-production-flags.js', wrongProductionOverrideSetAt: '2026-10-10T00:00:00Z',
  };
  assert.equal(rc.wrongProductionFlagVsClear({ ...base, approvedFixes: [{ field: 'wrongProduction', at: '2026-10-11T00:00:00Z', newValue: true }] }).flagLater, true);
  assert.equal(rc.wrongProductionFlagVsClear({ ...base, approvedFixes: [{ field: 'wrongProduction', at: '2026-10-11T00:00:00Z', newValue: false }] }).flagLater, false);
});

test('script clear is retracted with an audit trail and a breadcrumb the write guard honours', () => {
  const d = {
    wrongProduction: true, wrongProductionManualClear: true, wrongProductionOverride: true,
    wrongProductionOverrideReason: 'clear-stale: real review', wrongProductionOverrideSetAt: '2026-10-10T00:00:00Z',
    wrongProductionOverrideSetBy: 'clear-stale-wrong-production-flags.js', wrongProductionClearedNote: 'n',
  };
  const out = guard.retractScriptWrongProductionClear(d);
  assert.equal(out.blockedByHumanClear, false);
  assert.ok(out.retracted.includes('wrongProductionManualClear'));
  assert.equal(d.wrongProductionManualClear, undefined);
  assert.equal(d._previousWrongProductionClear.by, 'clear-stale-wrong-production-flags.js');
  for (const k of out.retracted) if (guard.CLEAR_BREADCRUMBS[k]) assert.equal(guard.CLEAR_BREADCRUMBS[k](d), true, k);
});

test('a human clear is not retracted silently', () => {
  const d = { wrongProduction: true, wrongProductionManualClear: true, wrongProductionOverrideSetBy: 'owner' };
  assert.equal(guard.retractScriptWrongProductionClear(d).blockedByHumanClear, true);
  assert.equal(d.wrongProductionManualClear, true);
});

test('review-field-edit flag on a script-cleared record takes effect and stamps newValue', () => {
  const record = {
    wrongProduction: false, wrongProductionManualClear: true, wrongProductionOverride: true,
    wrongProductionOverrideSetBy: 'clear-stale-wrong-production-flags.js',
  };
  const r = applyReviewFieldEdit(record, { field: 'wrongProduction', oldValue: false, newValue: true }, { fixId: 'bro-x', at: '2026-10-11T00:00:00Z' });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.record.wrongProductionManualClear, undefined);
  assert.equal(r.record.wrongProductionOverride, undefined);
  assert.equal(r.record.approvedFixes[0].newValue, true);
});

test('review-field-edit refuses to overrule a human clear', () => {
  const record = { wrongProduction: false, wrongProductionManualClear: true, wrongProductionOverrideSetBy: 'owner' };
  const r = applyReviewFieldEdit(record, { field: 'wrongProduction', oldValue: false, newValue: true }, { fixId: 'bro-x', at: '2026-10-11T00:00:00Z' });
  assert.equal(r.ok, false);
});

const { priorRunsValueProblem, FEEDBACK_EDITABLE_FIELDS } = require('../../scripts/lib/feedback-pipeline-fields.js');

test('priorRuns data-edit may only flip inheritReviews', () => {
  const old = [{ id: 'a', venue: 'V', openingDate: '2026-07-07', closingDate: '2026-09-05' }];
  assert.ok(FEEDBACK_EDITABLE_FIELDS['shows.json'].includes('priorRuns'));
  assert.equal(priorRunsValueProblem([{ ...old[0], inheritReviews: false }], old), null);
  assert.match(priorRunsValueProblem([{ ...old[0], closingDate: '2026-12-01' }], old), /only inheritReviews/);
  assert.match(priorRunsValueProblem([], old), /add or remove/);
  assert.match(priorRunsValueProblem([{ ...old[0], inheritReviews: 'no' }], old), /boolean/);
});
