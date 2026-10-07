/**
 * Production context for video-review verification (BRO-4328).
 *
 * The 2026-09-29 audit found ~10% of published video reviews filed under the
 * wrong production: West End runs, UK/US tours, out-of-town tryouts, a
 * community production and earlier revivals all landed on the Broadway id
 * with the same title. The classifier and the pre-share auditor were only
 * ever told the show TITLE, so they could not tell productions apart. These
 * helpers give them the venue, city and run dates, plus a deterministic
 * "posted before this production existed" rule.
 *
 * Pure so tests/unit/video-production-context.test.mjs can require() it.
 */

const MARKET_LABEL = {
  broadway: 'Broadway, New York City',
  'off-broadway': 'Off-Broadway, New York City',
  'west-end': 'West End, London',
  'off-west-end': 'Off-West End, London',
  regional: 'US regional theater',
  tour: 'touring production',
};

// A first-preview reaction can be posted the same night; a small grace also
// absorbs timezone and minor date-entry slop in shows.json.
const PREDATE_GRACE_DAYS = 7;

function parseYmd(s) {
  if (!s) return null;
  const str = String(s).trim();
  let m = str.match(/^(\d{4})(\d{2})(\d{2})$/) || str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  return Number.isNaN(t) ? null : t;
}

/** One line a model can use to tell this production apart from others with the same title. */
function describeProduction(show) {
  const where = MARKET_LABEL[show.category] || MARKET_LABEL[show.market] || show.category || show.market || 'unknown market';
  const parts = [`"${show.title}" (${where})`];
  if (show.venue) parts.push(`at ${show.venue}${show.theaterAddress ? ` (${show.theaterAddress})` : ''}`);
  const dates = [];
  if (show.previewsStartDate) dates.push(`previews from ${show.previewsStartDate}`);
  if (show.openingDate) dates.push(`opened ${show.openingDate}`);
  if (show.closingDate) dates.push(`closed/closing ${show.closingDate}`);
  if (dates.length) parts.push(dates.join(', '));
  if (show.isRevival === true) parts.push('a revival');
  return parts.join('; ');
}

/**
 * True when the video was posted clearly before this production's first
 * performance, so it cannot be a first-hand review of it (it reviews an
 * earlier run, a tryout, or another city's production).
 * Unknown dates (null, "NA") never count.
 */
function videoPredatesProduction(publishedAt, show, graceDays = PREDATE_GRACE_DAYS) {
  const posted = parseYmd(publishedAt);
  const start = parseYmd(show.previewsStartDate) ?? parseYmd(show.openingDate);
  if (posted === null || start === null) return false;
  return posted < start - graceDays * 86400000;
}

module.exports = { describeProduction, videoPredatesProduction, parseYmd, PREDATE_GRACE_DAYS };
