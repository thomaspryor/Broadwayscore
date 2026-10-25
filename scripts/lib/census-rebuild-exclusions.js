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

// An excluded file only closes the census entry that names ITS url: a different census url for
// the same outlet may be the real, not-yet-gathered review (ship-check BRO-6072).
function normUrl(u) {
  const m = String(u || '').trim().match(/^https?:\/\/(?:www\.)?([^/?#]+)([^?#]*)(\?[^#]*)?/i);
  if (!m) return String(u || '').trim();
  const q = (m[3] || '').slice(1).split('&').filter((kv) => kv && !/^utm_/i.test(kv)).sort().join('&');
  return m[1].toLowerCase() + m[2].replace(/\/+$/, '') + (q ? `?${q}` : '');
}

/**
 * @param {string} showId
 * @param {object} show  shows.json entry
 * @param {{dir?: string}} [opts] dir overrides the show's review-text directory (tests)
 * @returns {Map<string,{urls:Set<string>}>} outletId -> the dropped files' normalized
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
    const fileOutlet = f.split('--')[0];
    // Unreadable file = unknown eligibility: it keeps its outlet in the census.
    try { data = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { for (const v of outletVariants(fileOutlet)) live.add(v); continue; }
    const outletId = String((data && data.outletId) || fileOutlet);
    if (!outletId) continue;
    let reason;
    try { reason = explainExclusion(data, show, p); } catch { reason = 'error'; }
    if (reason !== null && PERMANENT_REASONS.has(reason)) {
      const d = dropped.get(outletId) || { urls: new Set() };
      d.urls.add(normUrl(data.url));
      dropped.set(outletId, d);
    } else for (const v of outletVariants(outletId)) live.add(v);
  }
  for (const [id, d] of dropped) if (!outletVariants(id).some((v) => live.has(v))) excluded.set(id, d);
  return excluded;
}

/**
 * Census minus entries the rebuild will never satisfy. An entry goes when its outlet (or its
 * -london variant) is excluded AND (it names no url or its url is a dropped file's).
 * If everything is dropped the original count is kept so the verdict reads complete, not no-census-yet.
 */
function filterCensus(census, excluded) {
  if (!census || !excluded || excluded.size === 0 || !Array.isArray(census.entries)) return census;
  const gone = (e) => {
    for (const v of outletVariants(String(e.outletId || ''))) {
      const d = excluded.get(v);
      if (d && (!e.url || d.urls.has(normUrl(e.url)))) return true;
    }
    return false;
  };
  const entries = census.entries.filter((e) => !gone(e));
  if (entries.length === census.entries.length) return census;
  return { ...census, entries, count: entries.length || census.count };
}

module.exports = { rebuildExcludedOutlets, filterCensus, PERMANENT_REASONS };
