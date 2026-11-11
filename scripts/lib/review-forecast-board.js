/**
 * review-forecast-board.js (BRO-7348): pure shaping for the owner-only /admin/forecasts page.
 * Turns pilot ledger rows + grade rows into one entry per show plus a top-line scoreboard.
 * No fs, no network, no clock (callers pass `today`). Forecasts stay private: this runs only on the
 * server behind the admin cookie, never at build time.
 */
'use strict';

const P = require('./review-forecast-pilot');

const SOON_DAYS = 45; // opening within this many days (or already open, waiting on its grade) reads as "Opening soon"
const MIN_N_FOR_RESULT = 5; // below this many graded shows the UI labels averages as early

/**
 * Confidence in a forecast, from what it was built on (not yet measured against results; the pilot has no grades).
 * Points: prior run of the show +1, preview audience grade (100+ votes +2, any votes +1), preview grosses +1,
 * two or more people with a track record +1. 4+ High, 2-3 Medium, else Low. `basis` lists what is missing.
 */
function confidenceOf(row) {
  const inp = (row && row.inputs) || {};
  const votes = row && row.audience && typeof row.audience.totalCount === 'number' ? row.audience.totalCount : 0;
  const people = Array.isArray(inp.peopleWithHistory) ? inp.peopleWithHistory.length : 0;
  const pts = (inp.priorRun ? 1 : 0) + (votes >= 100 ? 2 : votes > 0 ? 1 : 0) + (inp.previewGrosses ? 1 : 0) + (people >= 2 ? 1 : 0);
  const missing = [];
  if (!inp.priorRun) missing.push('no prior run');
  if (votes === 0) missing.push('no audience grade yet');
  if (!inp.previewGrosses) missing.push('no preview grosses');
  return { level: pts >= 4 ? 'High' : pts >= 2 ? 'Medium' : 'Low', basis: missing.length ? missing.join(', ') : 'all inputs present' };
}

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
    // BRO-7357 v2 shadow forecast, read tolerantly: older rows and grades carry none of it.
    const v2 = src && src.v2 && typeof src.v2.forecast === 'number' ? src.v2 : null;
    const v2Forecast = grade && typeof grade.forecastV2 === 'number' ? grade.forecastV2 : v2 ? v2.forecast : null;
    const group = state === 'graded' ? 'graded' : P.addDays(today, SOON_DAYS) >= openingDate ? 'soon' : 'later';
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
      group,
      confidence: src ? confidenceOf(src).level : null,
      confidenceBasis: src ? confidenceOf(src).basis : null,
      forecastV2: v2Forecast,
      lo80V2: v2 && typeof v2.lo80 === 'number' ? v2.lo80 : null,
      hi80V2: v2 && typeof v2.hi80 === 'number' ? v2.hi80 : null,
      v2UsedShowScore: grade ? !!grade.v2UsedShowScore : v2 ? Array.isArray(v2.inputsPresent) && v2.inputsPresent.includes('showScore') : false,
      missForecastV2: grade && typeof grade.missForecastV2 === 'number' ? grade.missForecastV2 : null,
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

module.exports = { buildBoard, confidenceOf, MIN_N_FOR_RESULT, SOON_DAYS };
