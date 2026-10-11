// Undo a held-row release (BRO-5041) for named slugs: each commercial.json
// record goes back to exactly what it was before the release commit, or is
// removed when the release created it. Pure, so the CLI and the test share it.
//
// Why a restore rather than field edits: the release merges the pending row
// onto any existing record, so only the pre-release snapshot says which
// fields were there before. execute-approved-fix.js data-edits need every
// current value up front and cannot remove a record.
//
// `released` (commercial.json as of the release commit itself) is optional.
// When given, a slug the release did not change is skipped (wrong commit or
// wrong slug), and a record edited after the release is reported in
// `editedSince` so the caller can see what the restore throws away.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function revertReleasedRecords(current, previous, slugs, released) {
  const shows = current.shows || (current.shows = {});
  const prevShows = (previous && previous.shows) || {};
  const relShows = released && released.shows;
  const restored = [];
  const removed = [];
  const unchanged = [];
  const notInRelease = [];
  const editedSince = {};
  for (const slug of slugs) {
    const before = has(prevShows, slug) ? prevShows[slug] : undefined;
    const now = shows[slug];
    if (relShows) {
      const after = has(relShows, slug) ? relShows[slug] : undefined;
      if (same(before, after)) { notInRelease.push(slug); continue; }
      if (now === undefined && after !== undefined) {
        editedSince[slug] = ['(record deleted since)'];
      } else if (now !== undefined && after !== undefined && !same(now, after)) {
        const keys = new Set([...Object.keys(now), ...Object.keys(after)]);
        editedSince[slug] = [...keys].filter((k) => !same(now[k], after[k])).sort();
      }
    }
    if (before === undefined) {
      if (now === undefined) { unchanged.push(slug); continue; }
      delete shows[slug];
      removed.push(slug);
    } else if (same(before, now)) {
      unchanged.push(slug);
    } else {
      shows[slug] = JSON.parse(JSON.stringify(before));
      restored.push(slug);
    }
  }
  return { restored, removed, unchanged, notInRelease, editedSince };
}

module.exports = { revertReleasedRecords };
