/**
 * review-forecast-board.js (BRO-7348): pure shaping for the owner-only /admin/forecasts page.
 * Turns pilot ledger rows + grade rows into one entry per show plus a top-line scoreboard.
 * No fs, no network, no clock (callers pass `today`). Forecasts stay private: this runs only on the
 * server behind the admin cookie, never at build time.
 */
'use strict';

const P = require('./review-forecast-pilot');

const MIN_N_FOR_RESULT = 5; // below this many graded shows the UI labels averages as early

/**
 * @param {{ledgerRows: object[], grades: object[], titleOf?: (id:string)=>string|null, today: string}} o
 * @returns {{summary: object, entries: object[]}}
 */
function buildBoard({ ledgerRows, grades, titleOf = () => null, today }) {
  const gradeById = new Map(grades.map((g) => [g.showId, g]));
  const ids = new Set([...ledgerRows.map((r) => r.showId), ...grades.map((g) => g.showId)]);
  const entries = [];
  for (const showId of ids) {
    const rows = ledgerRows.filter((r) => r.showId === showId);
    const newest = rows.reduce((b, r) => (!b || r.recordedAt > b.recordedAt ? r : b), null);
    const grade = gradeById.get(showId) || null;
    const openingDate = grade ? grade.openingDate : newest.openingDate;
    const opened = openingDate <= today;
    // Upcoming: newest row. Opened: the frozen row (last one dated before opening night).
    const row = opened ? (P.frozenForecastRow(rows, showId, openingDate) || newest) : newest;
    const state = grade ? 'graded' : opened ? 'awaiting-grade' : 'upcoming';
    const src = grade && !rows.length ? null : row;
    entries.push({
      showId,
      title: titleOf(showId) || showId,
      state,
      openingDate,
      forecast: grade ? grade.forecast : src ? src.forecast : null,
      lo80: src && typeof src.lo80 === 'number' ? src.lo80 : null,
      hi80: src && typeof src.hi80 === 'number' ? src.hi80 : null,
      categoryMean: grade ? grade.categoryMean : src ? src.categoryMean : null,
      previewAudience: grade ? grade.previewAudience : src && src.audience ? src.audience.combined : null,
      audienceCount: src && src.audience ? src.audience.totalCount : null,
      forecastRecordedAt: grade ? grade.frozenRecordedAt : src ? src.recordedAt : null,
      gradeDueOn: P.addDays(openingDate, P.GRADE_AFTER_DAYS),
      criticScore: grade ? grade.criticScore : null,
      missForecast: grade ? grade.missForecast : null,
      missCategoryMean: grade ? grade.missCategoryMean : null,
      inRange80: grade ? grade.inRange80 : null,
    });
  }
  const rank = { upcoming: 0, 'awaiting-grade': 1, graded: 2 };
  entries.sort((a, b) => rank[a.state] - rank[b.state]
    || (a.state === 'upcoming' ? a.openingDate.localeCompare(b.openingDate) : b.openingDate.localeCompare(a.openingDate)));
  const sb = P.scoreboard(grades);
  return {
    summary: {
      gradedShows: sb.shows,
      ourMiss: sb.forecast.mae,
      categoryMiss: sb.categoryMean.mae,
      rangeHitRate: sb.range80HitRate,
      upcomingShows: entries.filter((e) => e.state === 'upcoming').length,
      awaitingGrade: entries.filter((e) => e.state === 'awaiting-grade').length,
      early: sb.shows < MIN_N_FOR_RESULT,
    },
    entries,
  };
}

module.exports = { buildBoard, MIN_N_FOR_RESULT };
