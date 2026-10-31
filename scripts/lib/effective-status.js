/**
 * The status the website shows for a show, from shows.json's status and
 * today's date in the show's market (ET for Broadway/OB, London for WE/OWE).
 *
 * shows.json lags the calendar: update-show-status.js runs daily and races
 * other CI writes, so on opening night a show can still say "previews". The
 * website corrects that at build time (src/lib/engine.ts), and the app feed
 * (scripts/generate-mobile-data.js) must apply the same correction or the app
 * shows "previews" and a TBD score while the site shows the score.
 *
 *   normalizeShowStatus  previews -> open once openingDate <= today;
 *                        open -> closed once closingDate < today.
 *                        engine.ts feeds this to assessConfidence/getReviewAgeYear.
 *   effectiveShowStatus  the above, then previews -> upcoming while the first
 *                        preview is still ahead. This is ComputedShow.status,
 *                        what the show page's TBD gate reads.
 */

const { getMarketDate } = require('./auto-close-expired');

/**
 * @template {string} S
 * @param {{ status: S, category?: string, openingDate?: string | null, closingDate?: string | null }} show
 * @param {string} [today] YYYY-MM-DD in the show's market; defaults to now
 * @returns {S | 'open' | 'closed'}
 */
function normalizeShowStatus(show, today = getMarketDate(show.category)) {
  if (show.status === 'previews' && show.openingDate && show.openingDate <= today) return 'open';
  if (show.status === 'open' && show.closingDate && show.closingDate < today) return 'closed';
  return show.status;
}

/**
 * @template {string} S
 * @param {{ status: S, category?: string, openingDate?: string | null, closingDate?: string | null, previewsStartDate?: string | null }} show
 * @param {string} [today] YYYY-MM-DD in the show's market; defaults to now
 * @returns {S | 'open' | 'closed' | 'upcoming'}
 */
function effectiveShowStatus(show, today = getMarketDate(show.category)) {
  const status = normalizeShowStatus(show, today);
  if (status === 'previews' && show.previewsStartDate && show.previewsStartDate > today) return 'upcoming';
  return status;
}

module.exports = { normalizeShowStatus, effectiveShowStatus, getMarketDate };
