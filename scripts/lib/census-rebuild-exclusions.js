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
const { resolveReviewTextsDir } = require('./review-texts-dir');
const { outletVariants } = require('./review-census');

const PERMANENT_REASONS = new Set([
  'wrongProduction', 'wrongShow', 'nonReview', 'isRoundupArticle', 'roundupPageAsReview',
  'listingPageUrl', 'namedNonReviewUrl', 'knownSyndicationSecondary', 'isSyndicatedDuplicate',
  'crossOutletDuplicate', 'personalRepost', 'previewFirstLookPiece', 'combinedReviewOfOtherMemberOnly',
  'tourContaminationInText', 'filmTvContaminationInText',
]);

// Reasons that say "this file is a copy of another review": they hold whatever URL the census names.
// Content reasons (wrongProduction, nonReview, roundup...) only exclude the census entry when the
// dropped file IS that entry's URL; a different census URL may be the real, not-yet-gathered review.
const COPY_REASONS = new Set(['knownSyndicationSecondary', 'isSyndicatedDuplicate', 'crossOutletDuplicate', 'personalRepost']);

function normUrl(u) {
  return String(u || '').toLowerCase().replace(/^https?:\/\/(www\.)?/, '').replace(/[?#].*$/, '').replace(/\/+$/, '');
}

/**
 * @param {string} showId
 * @param {object} show  shows.json entry
 * @param {{dir?: string}} [opts] dir overrides the show's review-text directory (tests)
 * @returns {Map<string,{urls:Set<string>,copy:boolean}>} outletId -> the dropped files' normalized
 *   urls (and whether any was dropped as a copy) for outlets whose every file is permanently dropped
 */
function rebuildExcludedOutlets(showId, show, opts = {}) {
  const excluded = new Map();
  let dir = opts.dir;
  if (!dir) { try { dir = path.join(resolveReviewTextsDir(), showId); } catch { return excluded; } }
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { return excluded; }
  const live = new Set();
  const dropped = new Map();
  for (const f of files) {
    const p = path.join(dir, f);
    let data;
    try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { continue; }
    const outletId = data && (data.outletId || f.split('--')[0]);
    if (!outletId) continue;
    let reason;
    try { reason = explainExclusion(data, show, p); } catch { reason = 'error'; }
    if (reason !== null && PERMANENT_REASONS.has(reason)) {
      const d = dropped.get(outletId) || { urls: new Set(), copy: false };
      d.urls.add(normUrl(data.url));
      if (COPY_REASONS.has(reason)) d.copy = true;
      dropped.set(outletId, d);
    } else for (const v of outletVariants(outletId)) live.add(v);
  }
  for (const [id, d] of dropped) if (!outletVariants(id).some((v) => live.has(v))) excluded.set(id, d);
  return excluded;
}

/**
 * Census minus entries the rebuild will never satisfy. An entry goes when its outlet (or its
 * -london variant) is excluded AND (a copy reason, no census url, or the census url is a dropped file's).
 * If everything is dropped the original count is kept so the verdict reads complete, not no-census-yet.
 */
function filterCensus(census, excluded) {
  if (!census || !excluded || excluded.size === 0 || !Array.isArray(census.entries)) return census;
  const gone = (e) => {
    for (const v of outletVariants(e.outletId)) {
      const d = excluded.get(v);
      if (d && (d.copy || !e.url || d.urls.has(normUrl(e.url)))) return true;
    }
    return false;
  };
  const entries = census.entries.filter((e) => !gone(e));
  if (entries.length === census.entries.length) return census;
  return { ...census, entries, count: entries.length || census.count };
}

module.exports = { rebuildExcludedOutlets, filterCensus, PERMANENT_REASONS };
