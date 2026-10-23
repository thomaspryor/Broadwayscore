'use strict';
/**
 * BRO-6072: census outlets whose review file the rebuild will never include
 * (wrongProduction / wrongShow / nonReview / roundup page / syndicated copy)
 * can never become "live", so audit-opening-night-coverage must not count them
 * as missing gaps or re-dispatch gathers for them. Same class as BRO-6070
 * (press-night record).
 *
 * An outlet is excluded only when it has at least one review file for the show
 * and EVERY file is dropped by explainExclusion for a PERMANENT editorial reason.
 * Transient reasons (no text yet, preview placeholder, no score) never exclude:
 * a better gather could still recover those.
 */
const fs = require('fs');
const path = require('path');
const { explainExclusion } = require('./review-guards');

const PERMANENT_REASONS = new Set([
  'wrongProduction', 'wrongShow', 'nonReview', 'isRoundupArticle', 'roundupPageAsReview',
  'listingPageUrl', 'namedNonReviewUrl', 'knownSyndicationSecondary', 'isSyndicatedDuplicate',
  'crossOutletDuplicate', 'personalRepost', 'previewFirstLookPiece', 'combinedReviewOfOtherMemberOnly',
  'tourContaminationInText', 'filmTvContaminationInText',
]);

function reviewTextsRoot() {
  return process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', '..', 'data', 'review-texts');
}

/**
 * @param {string} showId
 * @param {object} show  shows.json entry
 * @param {{dir?: string}} [opts] dir overrides the show's review-text directory (tests)
 * @returns {Set<string>} outletIds permanently excluded for this show
 */
function rebuildExcludedOutlets(showId, show, opts = {}) {
  const dir = opts.dir || path.join(reviewTextsRoot(), showId);
  const excluded = new Set();
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { return excluded; }
  const live = new Set();
  const dropped = new Set();
  for (const f of files) {
    const p = path.join(dir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const outletId = data && (data.outletId || f.split('--')[0]);
    if (!outletId) continue;
    let reason;
    try { reason = explainExclusion(data, show, p); } catch { reason = 'error'; }
    if (reason !== null && PERMANENT_REASONS.has(reason)) dropped.add(outletId);
    else live.add(outletId);
  }
  for (const id of dropped) if (!live.has(id)) excluded.add(id);
  return excluded;
}

/** Census minus entries whose outlet is in `excluded`; count follows entries. */
function filterCensus(census, excluded) {
  if (!census || !excluded || excluded.size === 0 || !Array.isArray(census.entries)) return census;
  const entries = census.entries.filter((e) => !excluded.has(e.outletId));
  return { ...census, entries, count: entries.length };
}

module.exports = { rebuildExcludedOutlets, filterCensus, PERMANENT_REASONS };
