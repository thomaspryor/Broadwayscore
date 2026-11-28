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
const { standingMinReviews } = require('./score-gate-rule');

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

/** @param {string} showId @returns {boolean} show is in data/curated-historical-shows.json */
function isCuratedHistoricalShow(showId) {
  return !!showId && _loadCurated().has(showId);
}

let _gateFile = null;
function _loadGateFile() {
  if (_gateFile) return _gateFile;
  try {
    const data = require(path.join(__dirname, '..', '..', 'data', 'score-gate-overrides.json'));
    _gateFile = { shows: (data && data.shows) || {}, kept: (data && data.keptMarketMinimum) || {} };
  } catch {
    _gateFile = { shows: {}, kept: {} };
  }
  return _gateFile;
}

/**
 * The 4th argument for hasEnoughReviews / reviewsRemainingForScore (BRO-7750, BRO-8163). Pass the show object
 * ({ id, type, category, openingDate, closingDate }); a bare id works but cannot apply the standing rule.
 * Order: an owner-approved per-show minimum in data/score-gate-overrides.json, else a recorded keptMarketMinimum
 * (skips the rule), else 3 for a special or short Broadway / West End run (score-gate-rule.js), else whether the show
 * is curated historical. Mirrors scoreGateArg() in src/config/scoring.ts.
 * @param {string|{id?:string,type?:string,category?:string,openingDate?:string,closingDate?:string}} showOrId
 * @returns {boolean|number}
 */
function scoreGateArg(showOrId) {
  const show = showOrId && typeof showOrId === 'object' ? showOrId : null;
  const showId = show ? show.id : showOrId;
  const f = _loadGateFile();
  const o = showId ? f.shows[showId] : null;
  if (o && Number.isFinite(o.minReviews) && o.minReviews >= 1) return o.minReviews;
  const rule = show ? standingMinReviews(show, f.kept) : null;
  if (rule) return rule;
  return isCuratedHistoricalShow(showId);
}

module.exports = { shouldHideReviews, isCuratedHistoricalShow, scoreGateArg, SCORE_DISPLAY_YEAR_CUTOFF };
