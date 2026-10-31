'use strict';

// Preview weeks and run length for the recoupment model (BRO-5003, BRO-4989).
// Moved out of recoupment-model.js calculateRecoupment unchanged, plus one
// shadow option.
//
// Live counts a running show's weeks up to its closing date when one is
// announced, so weeks that have not been played yet are gap-filled at the
// average gross and inflate the modelled return. `playedOnly` stops the
// count at `now` instead (the same end a running show with no closing date
// already uses).

/** COVID shutdown: all Broadway dark from March 12, 2020 to September 14, 2021 */
const COVID_DARK_START = new Date('2020-03-12');
const COVID_DARK_END = new Date('2021-09-14');
const WEEK_MS = 7 * 86400000;

/**
 * @param {{ previewsStartDate?: string, openingDate?: string, closingDate?: string }} show
 * @param {{ now?: Date, playedOnly?: boolean }} [opts]
 * @returns {{ previewWeeks: number, totalRunWeeks: number, darkWeeks: number }}
 */
function runWindow(show, opts = {}) {
  const now = opts.now || new Date();
  const openingDate = show.openingDate ? new Date(show.openingDate) : null;
  let closingDate = show.closingDate ? new Date(show.closingDate) : null;
  const previewsStart = show.previewsStartDate ? new Date(show.previewsStartDate) : null;
  if (opts.playedOnly && closingDate && closingDate > now) closingDate = now;

  // Preview weeks (cap at 8 — anything longer is COVID gap or data error)
  let previewWeeks = 0;
  if (previewsStart && openingDate) {
    let rawPreviewWeeks = Math.round((openingDate - previewsStart) / WEEK_MS);
    // If preview period spans COVID shutdown, subtract dark weeks
    if (previewsStart < COVID_DARK_END && openingDate > COVID_DARK_START) {
      const darkStart = previewsStart < COVID_DARK_START ? COVID_DARK_START : previewsStart;
      const darkEnd = openingDate > COVID_DARK_END ? COVID_DARK_END : openingDate;
      rawPreviewWeeks -= Math.max(0, Math.round((darkEnd - darkStart) / WEEK_MS));
    }
    previewWeeks = Math.min(Math.max(rawPreviewWeeks, 0), 8);
  }

  // Total run weeks (from previews start or opening), excluding COVID dark period
  const runStart = previewsStart || openingDate;
  const runEnd = closingDate || now;
  let totalRunWeeks = runStart ? Math.round((runEnd - runStart) / WEEK_MS) : 0;

  // The dark weeks inside the counted window only: an open show counted as of
  // a date before the shutdown (the timing backtest's as-of runs) has none.
  let darkWeeks = 0;
  if (runStart && runStart < COVID_DARK_END && runEnd > COVID_DARK_START) {
    const darkStart = runStart < COVID_DARK_START ? COVID_DARK_START : runStart;
    const darkEnd = runEnd > COVID_DARK_END ? COVID_DARK_END : runEnd;
    darkWeeks = Math.round((darkEnd - darkStart) / WEEK_MS);
    totalRunWeeks -= darkWeeks;
  }

  return { previewWeeks, totalRunWeeks, darkWeeks };
}

// The grosses key a show resolves to can hold an earlier production's weeks
// too (cabaret-2024 resolves to cabaret-2014, which holds every Cabaret week
// since 2001). A week ending on or after the first preview and no later than
// a week past the closing date is this production's; a 7-day margin absorbs
// a date that is off by a few days. With no previews or opening date the
// rows are kept as they are.
const DAY_MS = 86400000;
const ISO = (t) => new Date(t).toISOString().slice(0, 10);

/**
 * @param {Record<string, object>} weekly - { 'YYYY-MM-DD' week ending: row }
 * @param {{ previewsStartDate?: string, openingDate?: string, closingDate?: string }} show
 * @returns {{ weekly: Record<string, object>, dropped: string[] }}
 */
function weeksInOwnRun(weekly, show) {
  const start = show.previewsStartDate || show.openingDate;
  const rows = Object.entries(weekly || {});
  if (!start || Number.isNaN(new Date(start).getTime())) return { weekly: weekly || {}, dropped: [] };
  const from = ISO(new Date(start).getTime() - 7 * DAY_MS);
  const to = show.closingDate && !Number.isNaN(new Date(show.closingDate).getTime())
    ? ISO(new Date(show.closingDate).getTime() + 7 * DAY_MS) : '9999-12-31';
  const keep = rows.filter(([d]) => d >= from && d <= to);
  return { weekly: Object.fromEntries(keep), dropped: rows.filter(([d]) => d < from || d > to).map(([d]) => d).sort() };
}

module.exports = { runWindow, weeksInOwnRun, COVID_DARK_START, COVID_DARK_END };
