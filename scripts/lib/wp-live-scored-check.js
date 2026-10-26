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
 * outlet, the normalized URL is equal AND the critic agrees (see isLiveScored),
 * or the file has no URL and the named critic matches. B is report-only, and
 * reviews.json can lag one rebuild.
 * Normalizers are injected so the logic is testable with synthetic fixtures.
 */

function buildWpLiveIndex(reviews, { normalizeOutlet, normalizeUrl, normalizeCritic }) {
  const byUrl = new Map(); // show|outlet|url -> Set of named critics ('unknown' never stored)
  const byCritic = new Set();
  for (const r of reviews || []) {
    if (!r || !r.showId) continue;
    const outlet = canon(() => normalizeOutlet(r.outletId || r.outlet), r.outletId || r.outlet);
    const critic = canon(() => normalizeCritic(r.criticName), 'unknown');
    if (r.url) {
      const key = `${r.showId}|||${outlet}|||${canon(() => normalizeUrl(r.url), r.url)}`;
      if (!byUrl.has(key)) byUrl.set(key, new Set());
      if (critic !== 'unknown') byUrl.get(key).add(critic);
    }
    if (critic !== 'unknown') byCritic.add(`${r.showId}|||${outlet}|||${critic}`);
  }
  return { byUrl, byCritic };
}

/**
 * A URL match only counts when it is this file's own entry: the file's named
 * critic must be among the live critics at that URL (corpus often has sibling
 * files sharing a URL under other bylines, only one live). An unnamed file
 * matches a URL only when no named critic is live there. The critic-only
 * fallback applies solely to files without a URL.
 */
function isLiveScored(index, { showId, outletId, url, criticName }, { normalizeOutlet, normalizeUrl, normalizeCritic }) {
  const outlet = canon(() => normalizeOutlet(outletId), outletId);
  const critic = canon(() => normalizeCritic(criticName), 'unknown');
  if (url) {
    const critics = index.byUrl.get(`${showId}|||${outlet}|||${canon(() => normalizeUrl(url), url)}`);
    if (!critics) return false;
    return critic === 'unknown' ? critics.size === 0 : critics.has(critic);
  }
  return critic !== 'unknown' && index.byCritic.has(`${showId}|||${outlet}|||${critic}`);
}

function canon(fn, fallback) {
  try { return fn() || fallback; } catch { return fallback; }
}

module.exports = { buildWpLiveIndex, isLiveScored };
