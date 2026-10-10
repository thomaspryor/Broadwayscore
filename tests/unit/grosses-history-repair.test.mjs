// Unit tests for scripts/lib/grosses-history-repair.js (BRO-4985).
//
// Expected values are Playbill's own published figures
// (https://playbill.com/grosses?week=...), checked 2026-10-10.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  isSundayKey,
  weekKeyFor,
  nonSundayWeekKeys,
  deriveSeatsOffered,
  derivePreviewPerformances,
  repairGrossesHistory,
} = require('../../scripts/lib/grosses-history-repair.js');

test('weekKeyFor snaps a date to its week-ending Sunday', () => {
  assert.equal(weekKeyFor('2026-06-21'), '2026-06-21');
  assert.equal(weekKeyFor('2026-06-22'), '2026-06-21'); // Monday → Sunday before
  assert.equal(weekKeyFor('2026-07-06'), '2026-07-05');
  assert.equal(weekKeyFor('2026-06-24'), '2026-06-21'); // Wednesday
  assert.equal(weekKeyFor('2026-06-25'), '2026-06-28'); // Thursday → Sunday after
  assert.equal(weekKeyFor('2026-06-27'), '2026-06-28');
  assert.ok(isSundayKey('2026-10-04'));
  assert.ok(!isSundayKey('2026-10-05'));
  assert.ok(!isSundayKey('not-a-date'));
});

test('deriveSeatsOffered matches Playbill (Wicked 2026-08-09, 2023-07-16)', () => {
  assert.equal(deriveSeatsOffered({ attendance: 13428, capacity: 92.89, performances: 8 }), 14456);
  assert.equal(deriveSeatsOffered({ attendance: 13831, capacity: 95.68, performances: 8 }), 14456);
  // Sold out at exactly 100% (Wicked 2025-07-13: 1,926 seats x 8).
  assert.equal(deriveSeatsOffered({ attendance: 15408, capacity: 100, performances: 8 }), 15408);
  // Over 100% (Sweeney Todd 2023-07-16: 1,498 x 7 = 10,486 offered, 10,561 sold).
  assert.equal(deriveSeatsOffered({ attendance: 10561, capacity: 100.72, performances: 7 }), 10486);
  assert.equal(deriveSeatsOffered({ attendance: null, capacity: 90, performances: 8 }), null);
  assert.equal(deriveSeatsOffered({ attendance: 5000, capacity: 0, performances: 8 }), null);
});

test('derivePreviewPerformances needs two agreeing regular weeks', () => {
  // Swept Away 2024-11-17: 0 perfs + 8 previews, 1,018 seats.
  const week = { gross: 500000, attendance: 6515, capacity: 80.0, performances: 0 };
  const regular = { attendance: 7000, capacity: 85.95, performances: 8 }; // 8,144 offered
  assert.equal(derivePreviewPerformances(week, [regular, regular]), 8);
  // A neighbour the old backfill also undercounted (8 played, stored 4) disagrees.
  const undercounted = { attendance: 7000, capacity: 85.95, performances: 4 };
  assert.equal(derivePreviewPerformances(week, [undercounted, regular]), null);
  // One regular week alone is not enough.
  assert.equal(derivePreviewPerformances(week, [regular]), null);
});

test('repairGrossesHistory moves off-Sunday keys, fills seatsOffered and preview performances', () => {
  const regular = (att, cap) => ({ gross: 900000, capacity: cap, atp: 100, attendance: att, performances: 8 });
  const history = {
    _meta: {},
    weeks: {
      '2026-06-14': { wicked: regular(12969, 89.71) },
      '2026-06-22': { wicked: regular(13000, 89.93), chicago: regular(5000, 80) },
      '2026-06-21': { chicago: { ...regular(5100, 81), seatsOffered: 6296 } },
      '2026-06-28': { wicked: regular(13100, 90.62) },
      '2026-07-05': { wicked: { gross: 800000, capacity: 90.0, atp: 100, attendance: 13010, performances: 0 } },
    },
  };
  const stats = repairGrossesHistory(history);
  assert.deepEqual(stats.renamedKeys, [['2026-06-22', '2026-06-21']]);
  assert.deepEqual(nonSundayWeekKeys(history), []);
  assert.deepEqual(Object.keys(history.weeks), ['2026-06-14', '2026-06-21', '2026-06-28', '2026-07-05']);
  // The Sunday entry already there wins on a shared slug; the Monday-only slug moves over.
  assert.equal(history.weeks['2026-06-21'].chicago.attendance, 5100);
  assert.equal(history.weeks['2026-06-21'].wicked.attendance, 13000);
  assert.equal(history.weeks['2026-06-14'].wicked.seatsOffered, 14456);
  assert.equal(history.weeks['2026-07-05'].wicked.performances, 8);
  assert.equal(history.weeks['2026-07-05'].wicked.seatsOffered, 14456);
  // Idempotent.
  const again = repairGrossesHistory(history);
  assert.deepEqual(again, { renamedKeys: [], seatsOfferedFilled: 0, performancesFilled: 0 });
});

test('repairGrossesHistory leaves an unprovable preview week alone', () => {
  const history = {
    weeks: {
      '2023-03-05': { sweeney: { gross: 1526254, capacity: 100, attendance: 10486, performances: 0 } },
      '2023-03-12': { sweeney: { gross: 1805510, capacity: 100, attendance: 10486, performances: 0 } },
    },
  };
  const stats = repairGrossesHistory(history);
  assert.equal(stats.performancesFilled, 0);
  assert.equal(history.weeks['2023-03-12'].sweeney.performances, 0);
  assert.equal(history.weeks['2023-03-12'].sweeney.seatsOffered, undefined);
});
