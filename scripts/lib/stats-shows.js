/**
 * Pure projection behind public/data/stats-shows.json — the slim show catalog
 * the web Stats view (src/components/my-shows/stats) reads instead of the
 * 2.2MB app catalog, public/data/mobile-shows.json (BRO-6170).
 *
 * WHY A PROJECTION OF mobile-shows.json, not a second scorer: every number
 * here is copied from the app feed, whose `cs` / `cr.rc` come from
 * buildMobileCriticScore -> scripts/lib/compute-critic-score.js (the one
 * canonical critic-score formula, CLAUDE.md §3) and whose audience grade and
 * effective status are computed in scripts/generate-mobile-data.js. Copying
 * them keeps web Stats and iOS Stats on identical numbers by construction; a
 * re-derivation would be one more place for the formula to drift.
 *
 * Format (v1):
 *   {
 *     _v: 1,
 *     shows: { "<id>": [score|null, reviewCount|null, grade|null, status?] },
 *     meta:  { "<id>": [title, slug, venue, category, isMusical(1|0), poster|null] }
 *   }
 *  - `shows` holds a row for every app-feed show that has a critic score, an
 *    audience grade, or a non-closed status. Trailing nulls are trimmed and
 *    `status` is omitted when it is "closed" (the client's default).
 *  - `meta` carries display fields ONLY for shows the web My Shows lookup
 *    (scripts/generate-show-lookup.js) leaves out: closed shows with no
 *    closing date. Everything else already has title/venue/poster on the
 *    client from /data/show-lookup.json.
 *
 * Decoded by src/lib/stats-ui/bundle.ts::decodeStatsShows. Tested by
 * tests/unit/stats-shows-projection.test.mjs.
 */

'use strict';

const SCHEMA_VERSION = 1;

/** Mirror of show-lookup's inclusion rule, on the app-feed row's fields. */
function omittedFromShowLookup(row) {
  return (row.st || 'closed') === 'closed' && !row.cd;
}

function trimTrailingNulls(arr) {
  let end = arr.length;
  while (end > 0 && arr[end - 1] == null) end--;
  return arr.slice(0, end);
}

/**
 * @param {Array<Record<string, any>>} mobileShows  rows of mobile-shows.json `.shows`
 * @returns {{ _v: number, shows: Record<string, any[]>, meta: Record<string, any[]> }}
 */
function projectStatsShows(mobileShows) {
  const shows = {};
  const meta = {};
  for (const row of mobileShows || []) {
    if (!row || typeof row.id !== 'string' || !row.id) continue;
    const score = typeof row.cs === 'number' ? row.cs : null;
    const reviewCount = typeof row.cr?.rc === 'number' ? row.cr.rc : null;
    const grade = typeof row.ag?.g === 'string' ? row.ag.g : null;
    const status = row.st && row.st !== 'closed' ? row.st : null;
    const needsMeta = omittedFromShowLookup(row);
    if (score == null && grade == null && status == null && !needsMeta) continue;
    shows[row.id] = trimTrailingNulls([score, reviewCount, grade, status]);
    if (needsMeta) {
      meta[row.id] = [
        row.t || row.id,
        row.s || row.id,
        row.v || '',
        row.cat || 'broadway',
        row.ty === 'musical' ? 1 : 0,
        row.img?.po || row.img?.th || null,
      ];
    }
  }
  return { _v: SCHEMA_VERSION, shows, meta };
}

module.exports = { SCHEMA_VERSION, projectStatsShows, omittedFromShowLookup };
