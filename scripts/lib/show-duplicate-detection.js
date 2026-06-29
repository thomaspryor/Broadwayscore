/**
 * show-duplicate-detection.js — detect TITLE-FRAGMENT duplicate show entries.
 *
 * This is the gap left by scripts/audit-duplicate-shows.js: that audit groups
 * candidates by `normalizeTitle|year`, so it can only compare shows that already
 * share a normalized title. Title-fragment dupes have DIFFERENT normalized titles
 * — one entry's title is a fragment of another's — so they never land in the same
 * group and slip through. Examples that shipped (2026-06 audit, handoff #3):
 *   - "Godot's To-Do List" inside a "Krapp's Last Tape / Godot's To-Do List" entry
 *   - "Hito no Chikara" inside the full "Yamato — The Drummers of Japan…" entry
 *
 * Rule: two entries at the SAME canonical venue with OVERLAPPING run dates where
 * one title's significant words are a STRICT SUBSET of the other's (on RAW tokens,
 * not normalized).
 *
 * FALSE-POSITIVE GUARDS (verified 0 hits on the live catalog):
 *   - Revivals share a title but differ in year ⇒ non-overlapping dates ⇒ excluded.
 *   - Repertory trilogies / multi-programme seasons (The Norman Conquests = 3
 *     plays; Alvin Ailey "New Works" vs "Legacy") are SIBLINGS — neither raw title
 *     is a subset of the other ⇒ excluded by the strict-subset test. (We compare
 *     RAW tokens, not normalizeTitle, which strips the distinguishing subtitle and
 *     would collapse the siblings together.)
 */

'use strict';

function canonicalVenue(show) {
  return (show.venue || '')
    .toLowerCase()
    .replace(/\s*\(.*?\)\s*/g, ' ') // drop parentheticals e.g. "(Over 18s Only)"
    .replace(/\s+/g, ' ')
    .trim();
}

function runStart(show) {
  return show.previewsStartDate || show.openingDate || null;
}

function datesOverlap(a, b) {
  const as = runStart(a);
  const bs = runStart(b);
  if (!as || !bs) return false;
  const ae = a.closingDate || as;
  const be = b.closingDate || bs;
  return as <= be && bs <= ae;
}

function rawTitleTokens(show) {
  return new Set(
    (show.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2),
  );
}

// True when one show's significant raw-title tokens are a STRICT subset of the
// other's (fragment relationship), not merely overlapping (siblings).
function isStrictTitleSubset(a, b) {
  const ta = rawTitleTokens(a);
  const tb = rawTitleTokens(b);
  if (ta.size < 2 || tb.size < 2 || ta.size === tb.size) return false;
  const [smaller, larger] = ta.size < tb.size ? [ta, tb] : [tb, ta];
  for (const t of smaller) if (!larger.has(t)) return false;
  return true;
}

/**
 * @param {Array<object>} shows - shows.json entries.
 * @returns {Array<{a:string, b:string, venue:string, reason:string}>}
 */
function findTitleFragmentDupes(shows) {
  const dupes = [];
  if (!Array.isArray(shows)) return dupes;
  for (let i = 0; i < shows.length; i++) {
    for (let j = i + 1; j < shows.length; j++) {
      const a = shows[i];
      const b = shows[j];
      const v = canonicalVenue(a);
      if (!v || v === 'tba' || v !== canonicalVenue(b)) continue;
      if (!datesOverlap(a, b)) continue;
      if (isStrictTitleSubset(a, b)) {
        dupes.push({
          a: a.id,
          b: b.id,
          venue: v,
          reason: `"${a.id}" and "${b.id}" share a venue + overlapping dates and one title is a fragment of the other`,
        });
      }
    }
  }
  return dupes;
}

module.exports = {
  findTitleFragmentDupes,
  canonicalVenue,
  isStrictTitleSubset,
  datesOverlap,
};
