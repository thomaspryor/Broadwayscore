/**
 * opening-date-guard.js
 *
 * BRO-4911: an openingDate a person corrected (through an approved data-edit
 * plan) kept openingDateSource 'ibdb', so the next IBDB/Wikipedia/Show Score
 * enrich run could put the wrong date back (into-the-woods-2022 -> 2022-07-10).
 *
 * The correction records the VALUE it set in `humanCorrectedOpeningDate`
 * (closing-date-guard.js uses a boolean; a value lets the shows.json write
 * chokepoint put it back after any writer, including the ones that assign
 * show.openingDate directly). restoreHumanCorrectedOpeningDates runs in
 * shows-write-guard's beforeWrite, so every saveShows() caller honours it.
 *
 * To change a corrected date, change or delete humanCorrectedOpeningDate in
 * the same edit (stampHumanCorrectedOpeningDate does both).
 */

/** Record a person's openingDate correction (execute-approved-fix data-edit). */
function stampHumanCorrectedOpeningDate(show, newDate) {
  if (!show) return;
  if (newDate) {
    show.humanCorrectedOpeningDate = newDate;
    show.openingDateSource = 'human-correction';
  } else {
    delete show.humanCorrectedOpeningDate;
    if (show.openingDateSource === 'human-correction') delete show.openingDateSource;
  }
}

/**
 * Put back every human-corrected openingDate a writer changed. Mutates shows.
 * @returns {Array<{id:string, from:any, to:string}>} the restores made
 */
function restoreHumanCorrectedOpeningDates(shows) {
  const restored = [];
  if (!Array.isArray(shows)) return restored;
  for (const show of shows) {
    const pinned = show && show.humanCorrectedOpeningDate;
    if (typeof pinned !== 'string' || !pinned) continue;
    if (show.openingDate === pinned) continue;
    restored.push({ id: show.id, from: show.openingDate, to: pinned });
    show.openingDate = pinned;
    show.openingDateSource = 'human-correction';
  }
  return restored;
}

module.exports = { stampHumanCorrectedOpeningDate, restoreHumanCorrectedOpeningDates };
