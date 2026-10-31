'use strict';

/**
 * wetArchiveProblem: may this WestEndTheatre roundup archive belong to `show`?
 * (BRO-6682, CLAUDE.md §15.) WET is a West End aggregator, so an archive on a
 * Broadway/off-Broadway row is always another production's: in-the-heights-
 * off-broadway-2026 (NYC City Center, Oct 2026) carried the 2015 London
 * roundup with matchConfidence "high". The scraper filters candidates to
 * London rows today; this guard is the write-time and audit-time backstop and
 * also rejects a post that predates the run by more than a revival gap.
 *
 * @returns {{code:string, detail:string}|null}
 */
const { isLondonMarket } = require('./venue-classification');

// A roundup is posted within days of press night. 120 days before the show's
// opening still allows long preview periods; anything older reviews a
// previous run.
const POST_BEFORE_OPENING_MAX_DAYS = 120;

function wetArchiveProblem(show, archive) {
  if (!show) return { code: 'unknown-show', detail: 'no show row for archive' };
  if (!isLondonMarket(show.category)) {
    return { code: 'non-london-show', detail: `${show.id} is category "${show.category || 'broadway'}"; WET only covers West End productions` };
  }
  const postDate = archive && (archive.postDate || archive.date);
  const opening = show.openingDate;
  if (postDate && opening) {
    const p = Date.parse(postDate);
    const o = Date.parse(opening);
    if (!isNaN(p) && !isNaN(o)) {
      const days = Math.round((o - p) / 86400000);
      if (days > POST_BEFORE_OPENING_MAX_DAYS) {
        return { code: 'post-predates-run', detail: `post ${String(postDate).slice(0, 10)} is ${days} days before opening ${opening}` };
      }
    }
  }
  return null;
}

/**
 * @param {Array} shows shows.json rows
 * @param {Array<{showId:string, archive:object}>} archives parsed WET archive files
 * @returns {Array<{showId:string, code:string, detail:string, postUrl:string|null}>}
 */
function auditWetArchives(shows, archives) {
  const byId = new Map((shows || []).map((s) => [s.id, s]));
  const out = [];
  for (const { showId, archive } of archives || []) {
    const problem = wetArchiveProblem(byId.get(showId), archive);
    if (problem) out.push({ showId, ...problem, postUrl: (archive && archive.postUrl) || null });
  }
  return out;
}

module.exports = { wetArchiveProblem, auditWetArchives, POST_BEFORE_OPENING_MAX_DAYS };
