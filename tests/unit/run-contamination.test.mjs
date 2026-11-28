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

const dg = require('../../scripts/lib/date-guard.js');

test('textDateline reads a full printed date only', () => {
  assert.equal(dg.textDateline('By Nicole Acquah Tuesday, August 7 2018, 13:35 - Reviews'), '2018-08-07');
  assert.equal(dg.textDateline('The Wolf at the Door  Oct 25, 2024 Theater Review'), '2024-10-25');
  assert.equal(dg.textDateline('on 11 August 2019 we saw'), '2019-08-11');
  assert.equal(dg.textDateline('through December 31. Adapted from a 2006 novel'), null);
  assert.equal(dg.textDateline('until 6 September, then on tour'), null);
});

test('guardPublishDate prefers a printed dateline over the fetch-date stand-in', () => {
  const show = { openingDate: '2026-07-30', previewsStartDate: '2026-07-20' };
  const base = { dateSource: 'llm-scoring', publishDate: '2018-08-07', textFetchedAt: '2026-08-01T00:00:00Z' };
  const dated = dg.guardPublishDate({ ...base, fullText: 'By N. A. Tuesday, August 7 2018, 13:35 - Reviews Looking for' }, show);
  assert.equal(dated.publishDate, '2018-08-07');
  assert.equal(dated.substituted, false);
  const undated = dg.guardPublishDate({ ...base, fullText: 'Looking for a family afternoon out' }, show);
  assert.equal(undated.publishDate, '2026-08-01');
  assert.equal(undated.substituted, true);
});

test('legacy Override with no setBy yields to a later plan flag (The Car Man, Daily Echo); a lone ManualClear does not', () => {
  const carMan = {
    wrongProduction: true, wrongProductionOverride: true,
    approvedFixes: [{ field: 'wrongProduction', at: '2026-09-30T04:40:53.479Z' }],
  };
  assert.equal(rc.humanFlagOutranksScriptClear(carMan), true);
  const dino = { wrongProduction: true, wrongProductionManualClear: true, approvedFixes: [{ field: 'wrongProduction', at: '2026-09-30T00:00:00Z' }] };
  assert.equal(rc.humanFlagOutranksScriptClear(dino), false);
});

test('batch-script setBy labels without .js count as script clears; owner does not (BRO-5239)', () => {
  for (const by of ['clear-own-venue-tour-fps-2026-10', 'reverify-era-venue-wrongprod', 'clear-we-longrunner-fps-2026-04-24', 'x.js']) {
    assert.equal(guard.isScriptWrongProductionClear({ wrongProductionManualClear: true, wrongProductionOverrideSetBy: by }), true, by);
  }
  assert.equal(guard.isScriptWrongProductionClear({ wrongProductionManualClear: true, wrongProductionOverrideSetBy: 'owner' }), false);
});

// BRO-5261 retro-review of BRO-5239: audit class 5 and class 3 decisions.
const audit = require('../../scripts/audit-run-contamination.js');

test('class 5: a same-date copy on a later, unlinked run is a suspect, not a shared article', () => {
  const shows = [
    { id: 'play-2020', previewsStartDate: '2020-01-25', openingDate: '2020-02-12', closingDate: '2020-03-14' },
    { id: 'play-2021', previewsStartDate: '2021-08-07', openingDate: '2021-08-07', closingDate: '2021-10-30' },
    { id: 'double-a', previewsStartDate: '2024-03-01', openingDate: '2024-03-10' },
    { id: 'double-b', previewsStartDate: '2024-03-02', openingDate: '2024-03-10' },
  ];
  const rows = [
    { showId: 'play-2020', url: 'https://x.com/play-review', publishDate: '2020-02-13' },
    { showId: 'play-2021', url: 'https://x.com/play-review', publishDate: null },
    { showId: 'double-a', url: 'https://x.com/double-bill', publishDate: '2024-03-11' },
    { showId: 'double-b', url: 'https://x.com/double-bill', publishDate: '2024-03-11' },
  ];
  const r = audit.class5({ shows, rows });
  assert.equal(r.sameUrlTwoShows, 1);
  assert.equal(r.sharedArticles, 1);
  assert.match(r.sameUrlSample[0], /play-review/);
});

test('class 5: a month-only second row does not erase the day-level date', () => {
  const shows = [
    { id: 'a', previewsStartDate: '2019-03-01', openingDate: '2019-03-20', closingDate: '2019-06-01' },
    { id: 'b', previewsStartDate: '2023-03-01', openingDate: '2023-03-20', closingDate: '2023-06-01' },
  ];
  const rows = [
    { showId: 'a', url: 'https://x.com/r', publishDate: '2019-03-21' },
    { showId: 'b', url: 'https://x.com/r', publishDate: '2023-03-21' },
    { showId: 'b', url: 'https://x.com/r', publishDate: '2023-03' },
  ];
  assert.equal(audit.class5({ shows, rows }).sameUrlTwoShows, 1);
});

test('class 3: a clear stamped with a known batch-script label is not a human verdict', () => {
  const republish = { exclude: true, markerYear: 2019, snippet: 'This review is from 2019' };
  const rows = [{ showId: 's', url: 'https://x.com/a', outletId: 'o', criticName: 'C' }];
  const file = (setBy) => new Map([['s', [{ file: 'o--c.json', url: 'https://x.com/a', outletId: 'o', criticName: 'C', republish, wrongProductionManualClear: true, overrideSetBy: setBy }]]]);
  assert.equal(audit.class3({ rows, files: file('clear-own-venue-tour-fps-2026-10') }).count, 1);
  assert.equal(audit.class3({ rows, files: file('fix-thing.js') }).count, 1);
  assert.equal(audit.class3({ rows, files: file('owner') }).count, 0);
  assert.equal(audit.class3({ rows, files: file(undefined) }).count, 0);
});

test('class 2: a prior run marked inheritReviews:false does not explain its reviews (BRO-5261)', () => {
  const prior = { openingDate: '2025-04-14', closingDate: '2025-08-03' };
  const mk = (inheritReviews) => [{ id: 'spies-2026', previewsStartDate: '2026-08-01', openingDate: '2026-08-06', priorRuns: [{ ...prior, ...(inheritReviews === undefined ? {} : { inheritReviews }) }] }];
  const rows = [{ showId: 'spies-2026', outletId: 'thestage', criticName: 'X', publishDate: '2025-05-14' }];
  const optOut = audit.class2({ shows: mk(false), rows, files: new Map() });
  assert.equal(optOut.rows[0].why, 'opt-out-prior-run');
  assert.equal(optOut.unexplained, 1);
  const carried = audit.class2({ shows: mk(undefined), rows, files: new Map() });
  assert.equal(carried.rows[0].why, 'declared-prior-run');
  assert.equal(carried.unexplained, 0);
});

// BRO-5687: a plan may append ONE bounded earlier run (Angel's Bone, Manchester premiere).
const { appendedPriorRunProblem } = require('../../scripts/lib/feedback-pipeline-fields.js');
test('priorRuns data-edit may append one bounded earlier run', () => {
  const show = { id: 'angels-bone-west-end-2026', previewsStartDate: '2026-10-16', openingDate: '2026-10-17' };
  const run = { openingDate: '2026-05-12', closingDate: '2026-05-16', venue: 'Aviva Studios, Manchester' };
  assert.equal(priorRunsValueProblem([run], null, show), null);
  assert.equal(priorRunsValueProblem([run], undefined, show), null);
  assert.equal(priorRunsValueProblem([run], [], show), null);
  assert.match(priorRunsValueProblem([run, { ...run, note: 'x' }], [], show), /add or remove/, 'two appended runs refused');
  assert.equal(priorRunsValueProblem([run, { ...run, openingDate: '2025-05-12', closingDate: '2025-05-16' }], [run], show), null, 'second run appended after an existing one');
  assert.match(priorRunsValueProblem([run], null), /bound the appended run/, 'no show given');
  assert.match(priorRunsValueProblem([{ ...run, id: 'other-show' }], null, show), /may only carry/);
  assert.match(priorRunsValueProblem([{ ...run, openingDate: '2026-5-12' }], null, show), /real YYYY-MM-DD/);
  assert.match(priorRunsValueProblem([{ ...run, openingDate: '2026-02-30' }], null, show), /real YYYY-MM-DD/);
  assert.match(priorRunsValueProblem([{ ...run, closingDate: '2026-05-01' }], null, show), /before its openingDate/);
  assert.match(priorRunsValueProblem([{ ...run, openingDate: '2024-01-01' }], null, show), /spans more than/);
  assert.match(priorRunsValueProblem([{ ...run, closingDate: undefined }], null, show), /real YYYY-MM-DD/);
  assert.match(priorRunsValueProblem([{ ...run, venue: 'TBD' }], null, show), /placeholder/);
  assert.match(priorRunsValueProblem([{ ...run, venue: '  ' }], null, show), /needs a venue/);
  assert.match(priorRunsValueProblem([{ ...run, inheritReviews: 'yes' }], null, show), /boolean/);
  assert.match(priorRunsValueProblem([{ ...run, note: 'x'.repeat(301) }], null, show), /300/);
  assert.match(priorRunsValueProblem([{ ...run, openingDate: '2026-10-01', closingDate: '2026-10-09' }], null, show), /more than 7 days before/);
  assert.equal(priorRunsValueProblem([{ ...run, openingDate: '2026-10-01', closingDate: '2026-10-08' }], null, show), null, 'closes exactly 8 days before previews: allowed');
  assert.match(priorRunsValueProblem([run], null, { id: 'x' }), /bound the appended run/);
  assert.match(priorRunsValueProblem([run, { ...run, openingDate: '2026-05-14', closingDate: '2026-05-20' }], [run], show), /overlaps/);
  assert.match(priorRunsValueProblem([{ ...run, venue: 'Changed' }, run], [run], show), /may not change in the same plan/);
  // An existing run with no openingDate still blocks an overlapping append (abigails-party shape).
  const noOpen = { openingDate: null, closingDate: '2026-05-14', venue: 'Richmond Theatre' };
  assert.match(priorRunsValueProblem([noOpen, run], [noOpen], show), /overlaps/);
  assert.equal(priorRunsValueProblem([noOpen, { ...run, openingDate: '2026-06-01', closingDate: '2026-06-05' }], [noOpen], show), null);
  assert.match(priorRunsValueProblem([], [run], show), /add or remove/);
  assert.match(priorRunsValueProblem([run, run, run], [], show), /add or remove/);
  assert.equal(typeof appendedPriorRunProblem, 'function');
});
