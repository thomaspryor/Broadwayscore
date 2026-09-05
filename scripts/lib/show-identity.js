/**
 * show-identity.js — resolve a show's real (showId, showTitle) pair for the
 * content-quality gates.
 *
 * WHY THIS EXISTS
 *
 * `assessTextQuality(text, showId, showTitle)` takes the id and the title as
 * SEPARATE arguments. Several callers used to collapse them into one derived
 * string and pass it positionally:
 *
 *     const showTitle = showId.replace(/-\d{4}$/, '').replace(/-/g, ' ');
 *     assessTextQuality(text, showTitle);          // <- slug lands in showId
 *
 * That is wrong twice over:
 *
 *   1. `validateShowMentioned` receives "holy fool off west end" — the id with
 *      its CATEGORY SUFFIX still attached and hyphens flattened to spaces. No
 *      review contains that string, so the expected show reads as "not
 *      mentioned", which is exactly the condition that lets a multi-show
 *      detection harden into garbage/high.
 *   2. `detectMultiShowContent` splits its showId argument on "-" to build the
 *      expected-show exclusion; a space-flattened slug collapses to a single
 *      token, so the show under review is never excluded from its own count.
 *
 * Broadway ids ("hamilton-2015" -> "hamilton") survived this by accident.
 * Every West End / Off-West-End / Off-Broadway / regional id carries a
 * category suffix, so London shows failed the mention check AS A CLASS — two
 * real Holy Fool reviews (The Reviews Hub, Theatre Vibe) were classified
 * garbage_content on every fetch and never reached the scoring corpus.
 *
 * The helper lives here rather than inline in any one script because the same
 * mistake was independently present in `collect-review-texts.js` (which stops
 * text being saved) and `fix-garbage-reviews.js` (which DELETES already-saved
 * fullText). One shared, tested resolver is the only way both stay correct.
 *
 * The shows.json read is __dirname-relative on purpose: a cwd-relative read
 * silently degrades to the slug fallback when a script runs from anywhere but
 * the repo root, which reintroduces the bug with no error.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { pickShowTitleForHeuristic } = require('./review-guards');

let _showsCache = null;

/** @returns {Array<Object>} shows.json entries, or [] if unreadable. */
function loadShows() {
  if (_showsCache) return _showsCache;
  try {
    const p = path.join(__dirname, '..', '..', 'data', 'shows.json');
    const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
    _showsCache = raw.shows || raw;
  } catch (e) {
    _showsCache = [];
  }
  return _showsCache;
}

/**
 * Resolve the canonical title for a show id.
 *
 * Falls back to the slug-derived title when shows.json is unreadable or the id
 * is unknown — same fallback `pickShowTitleForHeuristic` already applies. That
 * fallback is degraded but not broken: the showId argument is still correct,
 * so the mention check keeps working off the id's own words.
 *
 * @param {string} showId - e.g. 'holy-fool-off-west-end-2026'
 * @returns {{ showId: string, showTitle: string }}
 */
function resolveShowIdentity(showId) {
  const id = showId || '';
  const showMeta = loadShows().find(s => s && s.id === id) || null;
  return { showId: id, showTitle: pickShowTitleForHeuristic(id, showMeta) };
}

/** Test seam: drop the memoised shows.json. */
function _resetCache() {
  _showsCache = null;
}

module.exports = { resolveShowIdentity, _resetCache };
