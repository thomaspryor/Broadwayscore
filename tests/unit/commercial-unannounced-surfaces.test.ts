/**
 * BRO-4623: a recoupment that was never announced (Appropriate, Sweeney Todd,
 * Into the Woods) reads "Not publicly announced" on the show page. The /biz
 * table showed the same shows as a plain "Recouped", and the recent
 * recoupments list would have dated one like news. Every /biz surface built
 * from data-commercial must carry the same isUnannouncedRecoupment() answer.
 * Contract checks over live data, so they hold whichever shows are flagged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAllOpenShowsWithCommercial,
  getRecentRecoupments,
  getSeasonsWithCommercialData,
  getShowCommercial,
  getShowsBySeasonWithCommercial,
} from '../../src/lib/data-commercial';
import { isUnannouncedRecoupment } from '../../src/lib/commercial-display';

test('/biz table rows carry the record\'s unannounced-recoupment flag', () => {
  const rows = [
    ...getAllOpenShowsWithCommercial(),
    ...getSeasonsWithCommercialData().flatMap((season) => getShowsBySeasonWithCommercial(season)),
  ];
  assert.ok(rows.length > 0, 'no table rows built from live data');
  for (const row of rows) {
    const record = getShowCommercial(row.slug);
    assert.ok(record, `${row.slug}: row without a commercial record`);
    assert.equal(row.recoupmentNotAnnounced, isUnannouncedRecoupment(record!), `${row.slug}: table flag disagrees with the show page`);
  }
});

test('recent recoupments never list an unannounced recoupment', () => {
  for (const show of getRecentRecoupments(12 * 50)) {
    const record = getShowCommercial(show.slug);
    assert.equal(isUnannouncedRecoupment(record!), false, `${show.slug}: listed as a recent recoupment but never announced`);
  }
});
