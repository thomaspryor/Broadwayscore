/**
 * BRO-5568: a recoupment date we estimated (isEstimate.recoupedDate: Chicago
 * "March 1997", The Lion King 1999, ...) is never presented as reported. It
 * prints "~" and never anchors a week count on /biz. The rule itself is covered
 * with fixtures in commercial-metrics.test.ts (resolveRecoupWeeks) and
 * commercial-display.test.mjs (headline); these check the live data path wires
 * the flag through, whichever records carry it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getRecentRecoupments,
  getSeasonsWithCommercialData,
  getShowCommercial,
  getShowsBySeasonWithCommercial,
} from '../../src/lib/data-commercial';
import { getRecoupmentAttribution } from '../../src/lib/commercial-display';

test('every table row with an estimated recoupment date has no week count and a ~ headline', () => {
  for (const season of getSeasonsWithCommercialData()) {
    for (const row of getShowsBySeasonWithCommercial(season)) {
      const record = getShowCommercial(row.slug);
      if (!record || record.isEstimate?.recoupedDate !== true) continue;
      assert.equal(row.recoupedWeeks, null, `${row.slug}: week count from an estimated date`);
      if (record.recouped === true && record.recoupedDate) {
        assert.match(getRecoupmentAttribution(record).headline, /^Recouped, ~/, `${row.slug}: estimated date printed as reported`);
      }
    }
  }
});

test('recent recoupments carry the flag and count no weeks from an estimated date', () => {
  for (const show of getRecentRecoupments(12 * 50)) {
    const flagged = getShowCommercial(show.slug)?.isEstimate?.recoupedDate === true;
    assert.equal(show.recoupDateIsEstimate, flagged, show.slug);
    if (flagged) assert.equal(show.weeksToRecoup, null, `${show.slug}: weeks from an estimated date`);
  }
});
