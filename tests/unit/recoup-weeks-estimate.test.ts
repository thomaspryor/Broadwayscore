/**
 * BRO-5782 (owner decision 2026-10-20): Purpose, whose recoupment was reported
 * after it closed, shows ~24 weeks (opening night to closing) marked as our
 * estimate. Nothing else gets a number it was not measured for: Kimberly
 * Akimbo (tour money paid the remainder) keeps "Reported after closing".
 * Contract checks over live data, so they hold whichever shows are flagged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAllOpenShowsWithCommercial,
  getRecentRecoupments,
  getSeasonsWithCommercialData,
  getShowsBySeasonWithCommercial,
} from '../../src/lib/data-commercial';
import { RECOUPED_DURING_RUN_ESTIMATE } from '../../src/config/commercial';

const recent = () => getRecentRecoupments(12 * 50);
const tableRows = () => [
  ...getAllOpenShowsWithCommercial(),
  ...getSeasonsWithCommercialData().flatMap((season) => getShowsBySeasonWithCommercial(season)),
];

test('only shows on the owner list carry an estimated week count', () => {
  for (const show of recent()) {
    if (show.weeksIsEstimate) {
      assert.ok((show.slug in RECOUPED_DURING_RUN_ESTIMATE), `${show.slug}: estimate without an owner decision`);
      assert.ok(show.reportedAfterClosing, `${show.slug}: estimate on a show whose recoupment was not reported after closing`);
      assert.ok(show.weeksToRecoup !== null && show.weeksToRecoup > 0, `${show.slug}: estimate with no weeks`);
    }
  }
  for (const row of tableRows()) {
    if (row.recoupedWeeksIsEstimate) {
      assert.ok((row.slug in RECOUPED_DURING_RUN_ESTIMATE), `${row.slug}: table estimate without an owner decision`);
      assert.ok(row.recoupReportedAfterClosing, `${row.slug}: table estimate on a show not reported after closing`);
    }
  }
});

test('a recoupment reported after closing and not on the owner list gets no week count', () => {
  for (const show of recent()) {
    if (show.reportedAfterClosing && !(show.slug in RECOUPED_DURING_RUN_ESTIMATE)) {
      assert.equal(show.weeksToRecoup, null, `${show.slug}: week count on an unlisted after-closing recoupment`);
      assert.equal(show.weeksIsEstimate, false, show.slug);
    }
  }
  for (const row of tableRows()) {
    if (row.recoupReportedAfterClosing && !(row.slug in RECOUPED_DURING_RUN_ESTIMATE)) {
      assert.equal(row.recoupedWeeks, null, `${row.slug}: table week count on an unlisted after-closing recoupment`);
      assert.equal(row.recoupedWeeksIsEstimate, false, row.slug);
    }
  }
});

test('Purpose reads ~24 weeks, marked as an estimate, in both tables; Kimberly Akimbo stays blank', () => {
  const purpose = recent().find((s) => s.slug === 'purpose-2025');
  assert.ok(purpose, 'purpose-2025 missing from recent recoupments');
  assert.equal(purpose!.weeksToRecoup, 24);
  assert.equal(purpose!.weeksIsEstimate, true);
  assert.match(purpose!.weeksEstimateNote ?? '', /^Our estimate, not a reported figure/);
  const row = tableRows().find((r) => r.slug === 'purpose-2025');
  assert.ok(row, 'purpose-2025 missing from the season tables');
  assert.equal(row!.recoupedWeeks, 24);
  assert.equal(row!.recoupedWeeksIsEstimate, true);
  const kimberly = recent().find((s) => s.slug === 'kimberly-akimbo-2022');
  assert.ok(kimberly, 'kimberly-akimbo-2022 missing from recent recoupments');
  assert.equal(kimberly!.weeksToRecoup, null);
  assert.equal(kimberly!.reportedAfterClosing, true);
  assert.equal(kimberly!.weeksEstimateNote, null);
});
