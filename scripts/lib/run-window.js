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

  let darkWeeks = 0;
  if (runStart && runStart < COVID_DARK_END && (!closingDate || closingDate > COVID_DARK_START)) {
    const darkStart = runStart < COVID_DARK_START ? COVID_DARK_START : runStart;
    const darkEnd = (!closingDate || closingDate > COVID_DARK_END) ? COVID_DARK_END : closingDate;
    darkWeeks = Math.round((darkEnd - darkStart) / WEEK_MS);
    totalRunWeeks -= darkWeeks;
  }

  return { previewWeeks, totalRunWeeks, darkWeeks };
}

module.exports = { runWindow, COVID_DARK_START, COVID_DARK_END };
