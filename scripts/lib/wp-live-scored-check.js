'use strict';

/**
 * wp-live-scored-check.js — ground-truth gate for the B (false-positive
 * wrongProduction) detector in audit-review-contamination.js (BRO-2614).
 *
 * B asks "was this review wrongly EXCLUDED by a guard". The static fields it
 * reads (wrongProduction, contentVerification, date proximity) cannot answer
 * that: rebuild-all-reviews.js can still score a file whose wrongProduction is
 * true (auto-clear, manual clear, transfer handling), so those hits are stale
 * noise. data/reviews.json is the rebuild's own output; a file that has a live
 * entry there is NOT excluded and B has nothing to report. Same idea as
 * c2-live-scored-check.js (BRO-74).
 *
 * A live entry matches the corpus file when, for the same show + canonical
 * outlet, either the normalized URL is equal, or both carry the same named
 * critic. An unnamed ("Unknown"/empty) critic never matches on name alone.
 * Normalizers are injected so the logic is testable with synthetic fixtures.
 */

function buildWpLiveIndex(reviews, { normalizeOutlet, normalizeUrl, normalizeCritic }) {
  const byUrl = new Set();
  const byCritic = new Set();
  for (const r of reviews || []) {
    if (!r || !r.showId) continue;
    const outlet = canon(() => normalizeOutlet(r.outletId || r.outlet), r.outletId || r.outlet);
    if (r.url) byUrl.add(`${r.showId}|||${outlet}|||${canon(() => normalizeUrl(r.url), r.url)}`);
    const critic = canon(() => normalizeCritic(r.criticName), 'unknown');
    if (critic !== 'unknown') byCritic.add(`${r.showId}|||${outlet}|||${critic}`);
  }
  return { byUrl, byCritic };
}

/**
 * @returns {boolean} true when reviews.json carries a live entry for this
 *   corpus file, i.e. the file is being scored despite wrongProduction=true.
 */
function isLiveScored(index, { showId, outletId, url, criticName }, { normalizeOutlet, normalizeUrl, normalizeCritic }) {
  const outlet = canon(() => normalizeOutlet(outletId), outletId);
  if (url && index.byUrl.has(`${showId}|||${outlet}|||${canon(() => normalizeUrl(url), url)}`)) return true;
  const critic = canon(() => normalizeCritic(criticName), 'unknown');
  return critic !== 'unknown' && index.byCritic.has(`${showId}|||${outlet}|||${critic}`);
}

function canon(fn, fallback) {
  try { return fn() || fallback; } catch { return fallback; }
}

module.exports = { buildWpLiveIndex, isLiveScored };
