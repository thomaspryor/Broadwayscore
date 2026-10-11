// Undo a held-row release (BRO-5041) for named slugs: each commercial.json
// record goes back to exactly what it was before the release commit, or is
// removed when the release created it. Pure, so the CLI and the test share it.
//
// Why a restore rather than field edits: the release merges the pending row
// onto any existing record, so only the pre-release snapshot says which
// fields were there before. execute-approved-fix.js data-edits need every
// current value up front and cannot remove a record.

function revertReleasedRecords(current, previous, slugs) {
  const shows = current.shows || (current.shows = {});
  const prevShows = (previous && previous.shows) || {};
  const restored = [];
  const removed = [];
  const unchanged = [];
  for (const slug of slugs) {
    const before = Object.prototype.hasOwnProperty.call(prevShows, slug) ? prevShows[slug] : undefined;
    const now = shows[slug];
    if (before === undefined) {
      if (now === undefined) { unchanged.push(slug); continue; }
      delete shows[slug];
      removed.push(slug);
    } else if (JSON.stringify(before) === JSON.stringify(now)) {
      unchanged.push(slug);
    } else {
      shows[slug] = JSON.parse(JSON.stringify(before));
      restored.push(slug);
    }
  }
  return { restored, removed, unchanged };
}

module.exports = { revertReleasedRecords };
