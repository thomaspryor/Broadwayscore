// Tests for opening-date-contradiction.js (BRO-5156): a stored openingDate
// later than the review cluster. Fixtures mirror the real shows the audit
// found: Hercules WE 2025, Mother Russia OB 2026 (collapsed previews date),
// Grey House 2023.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  reviewDay,
  countsAsRunReview,
  findOpeningDateContradiction,
  isAcked,
  addAck,
} = require('./opening-date-contradiction.js');

function review(outletId, publishDate, extra = {}) {
  return { outletId, publishDate, url: `https://${outletId}.example/r`, ...extra };
}

const OUTLETS = ['guardian', 'telegraph', 'variety', 'whatsonstage', 'broadwayworld', 'standard', 'times-uk'];

test('Hercules shape: stored date two weeks after the press cluster is flagged', () => {
  const show = { id: 'hercules-west-end-2025', openingDate: '2025-07-10', previewsStartDate: '2025-06-03', openingDateSource: 'theatremonkey' };
  const files = OUTLETS.map((o, i) => review(o, i < 5 ? '2025-06-24' : '2025-06-25'));
  const f = findOpeningDateContradiction(show, files);
  assert.equal(f.pressNight, '2025-06-24');
  assert.equal(f.outlets, 7);
  assert.equal(f.earlyOutlets, 7);
  assert.equal(f.openingDateSource, 'theatremonkey');
});

test('after the date is corrected the same reviews no longer flag', () => {
  const show = { id: 'h', openingDate: '2025-06-24', previewsStartDate: '2025-06-03' };
  const files = OUTLETS.map((o) => review(o, '2025-06-24'));
  assert.equal(findOpeningDateContradiction(show, files), null);
});

test('anticipatory-gate victims count; other wrongProduction flags do not', () => {
  const show = { id: 'h', openingDate: '2025-07-10', previewsStartDate: '2025-06-03' };
  const victims = OUTLETS.slice(0, 5).map((o) => review(o, '2025-06-24', { wrongProduction: true, wrongProductionReason: 'anticipatory_pre_opening_post' }));
  assert.ok(findOpeningDateContradiction(show, victims));
  const otherRun = OUTLETS.slice(0, 5).map((o) => review(o, '2025-06-24', { wrongProduction: true, wrongProductionReason: 'cross-production-audit' }));
  assert.equal(findOpeningDateContradiction(show, otherRun), null);
  assert.equal(countsAsRunReview({ ...victims[0], isNonReview: true }), false);
});

test('fewer than five distinct outlets is not enough; duplicate files of one outlet count once', () => {
  const show = { id: 'h', openingDate: '2025-07-10' };
  const four = OUTLETS.slice(0, 4).map((o) => review(o, '2025-06-24'));
  assert.equal(findOpeningDateContradiction(show, four), null);
  const dupes = [...four, review('guardian', '2025-06-24'), review('guardian', '2025-06-25')];
  assert.equal(findOpeningDateContradiction(show, dupes), null);
});

test('a prior production before previews, or inside a declared priorRun, is ignored', () => {
  const beforePreviews = { id: 'blue-room', openingDate: '1998-12-13', previewsStartDate: '1998-11-27' };
  const london = OUTLETS.map((o) => review(o, '1998-09-23'));
  assert.equal(findOpeningDateContradiction(beforePreviews, london), null);
  const tryout = { id: 't', openingDate: '2019-07-10', priorRuns: [{ openingDate: '2019-04-25', closingDate: '2019-05-18', venue: 'Rose Kingston' }] };
  assert.equal(findOpeningDateContradiction(tryout, OUTLETS.map((o) => review(o, '2019-04-26'))), null);
});

test('reviews more than 90 days from the stored date are another run', () => {
  const show = { id: 'h', openingDate: '2025-07-10' };
  assert.equal(findOpeningDateContradiction(show, OUTLETS.map((o) => review(o, '2025-03-01'))), null);
});

test('previewsStartDate collapsed onto the wrong opening does not hide the cluster (Mother Russia)', () => {
  const show = { id: 'mother-russia-off-broadway-2026', openingDate: '2026-03-03', previewsStartDate: '2026-03-03' };
  const f = findOpeningDateContradiction(show, OUTLETS.map((o) => review(o, '2026-02-23')));
  assert.equal(f.pressNight, '2026-02-23');
});

test('one day-early outlet beside an on-time press cluster is not a contradiction', () => {
  const show = { id: 'h', openingDate: '2026-05-10' };
  const files = [review('talkinbroadway', '2026-05-08'), ...OUTLETS.slice(0, 6).map((o) => review(o, '2026-05-11'))];
  assert.equal(findOpeningDateContradiction(show, files), null);
});

test('text and timestamp dates parse; month-only dates are dropped (Grey House formats)', () => {
  assert.equal(reviewDay('June 1, 2023'), '2023-06-01');
  assert.equal(reviewDay('December 13th, 2021'), '2021-12-13');
  assert.equal(reviewDay('2023-06-01T20:03:03-04:00'), '2023-06-01');
  assert.equal(reviewDay('2023-06'), null);
  assert.equal(reviewDay('March 2015'), null);
  assert.equal(reviewDay('Sept. 2015'), null);
  const show = { id: 'grey-house-2023', openingDate: '2023-06-06', previewsStartDate: '2023-04-29' };
  const files = OUTLETS.map((o) => review(o, 'June 1, 2023'));
  assert.equal(findOpeningDateContradiction(show, files).pressNight, '2023-06-01');
  assert.equal(findOpeningDateContradiction(show, OUTLETS.map((o) => review(o, '2023-06'))), null);
});

test('an ack covers one stored date only', () => {
  const finding = { id: 'bedlams-othello', openingDate: '2026-05-10' };
  const acks = addAck([], finding, 'checked', '2026-10-12T00:00:00Z');
  assert.equal(isAcked(finding, acks), true);
  assert.equal(isAcked({ ...finding, openingDate: '2026-05-12' }, acks), false);
});

test('the health row has its own this-week playbook route, ahead of the generic Quality one', () => {
  const { getPlaybookEntry } = require('../health-check.js');
  const entry = getPlaybookEntry('Quality: opening date vs review dates');
  assert.equal(entry.urgency, 'this-week');
  assert.match(entry.ownerText, /opening date/);
  assert.match(entry.workerInstruction, /opening date/);
});
