/**
 * JS mirror of src/config/scoring.ts::shouldHideReviews.
 *
 * Used by generate-mobile-data.js + generate-mobile-show-details.js + anything
 * else on the JS side that decides whether a show's score should display.
 *
 * Drift hazard: if the TS source changes (year cutoff, curated allow-list,
 * status carve-outs), this needs the same update. Three call sites prior to
 * 2026-05-16 (TS, JS-mobile-data, no protection on JS-mobile-show-details)
 * had silent drift — added this lib + parity test to lock them together.
 */

'use strict';

const path = require('path');

const SCORE_DISPLAY_YEAR_CUTOFF = 2005;

let _curatedHistoricalIds = null;
function _loadCurated() {
  if (_curatedHistoricalIds) return _curatedHistoricalIds;
  try {
    const data = require(path.join(__dirname, '..', '..', 'data', 'curated-historical-shows.json'));
    _curatedHistoricalIds = new Set(Array.isArray(data) ? data : []);
  } catch {
    _curatedHistoricalIds = new Set();
  }
  return _curatedHistoricalIds;
}

/**
 * @param {{ id?: string|null, openingDate?: string|null, status?: string, category?: string }} show
 * @returns {boolean} true if reviews/scores should be HIDDEN on the public site
 */
function shouldHideReviews(show) {
  if (!show || !show.openingDate) return false;
  const openingYear = new Date(show.openingDate).getFullYear();
  if (openingYear >= SCORE_DISPLAY_YEAR_CUTOFF) return false;
  if (show.status === 'open' || show.status === 'previews') return false;
  const curated = _loadCurated();
  if (show.id && curated.has(show.id)) return false;
  return true;
}

module.exports = { shouldHideReviews, SCORE_DISPLAY_YEAR_CUTOFF };
