'use strict';

// Which preview weeks the recoupment model must estimate (BRO-5002, BRO-4989).
//
// Broadway weekly grosses start at the first preview, so a show whose weekly
// history begins before opening already has real rows for its previews. The
// live Tier 1 schedule (recoupment-model.js buildWeeklySchedule) still put
// `previewWeeks` estimated preview weeks in front of those rows, counting the
// previews twice. This decides how many are already covered.
//
// Weekly keys are week-ending dates (Sundays). A week ending before opening
// night is all previews; the week containing opening counts as a regular week,
// the same line the live schedule draws. Rows dated before the first preview
// belong to an earlier production (cabaret-2024 has a 2015 row) and are never
// counted; the week-ending date of the first preview week is on or after it.

const day = (d) => String(d || '').slice(0, 10);

/**
 * @param {string[]} weekDates - week-ending dates (YYYY-MM-DD) with gross rows, any order
 * @param {string|null} openingDate - YYYY-MM-DD
 * @param {number} previewWeeks - preview weeks the model assumes (already capped at 8)
 * @param {string|null} [previewsStartDate] - YYYY-MM-DD; rows before it are not this run's previews
 * @returns {{ covered: number, toEstimate: number, previewRowDates: Set<string> }}
 *   covered: preview weeks that have a real row; toEstimate: previewWeeks - covered;
 *   previewRowDates: the covered rows (the pre-opening rows nearest opening).
 */
function previewWeeksFromWeekly(weekDates, openingDate, previewWeeks, previewsStartDate) {
  const n = Math.max(0, Math.floor(previewWeeks || 0));
  const opening = day(openingDate);
  if (!n || !/^\d{4}-\d{2}-\d{2}$/.test(opening)) {
    return { covered: 0, toEstimate: n, previewRowDates: new Set() };
  }
  const first = day(previewsStartDate);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(first) ? first : '';
  const before = (weekDates || []).map(day).filter((d) => d < opening && d >= from).sort();
  const rows = before.slice(-n);
  return { covered: rows.length, toEstimate: n - rows.length, previewRowDates: new Set(rows) };
}

module.exports = { previewWeeksFromWeekly };
