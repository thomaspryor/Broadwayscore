'use strict';

/**
 * c2-live-scored-check.js — ground-truth gate for the C2 (multi-critic
 * same-URL) detector in audit-review-contamination.js (BRO-74).
 *
 * A URL-collision pair in the review-texts corpus is only a REAL double-count
 * if the live rebuild output (data/reviews.json) actually carries 2+ distinct
 * named critics for that exact show+outlet+URL right now. Checking this from
 * the corpus alone (duplicateOf/duplicateTextOf fields) is unreliable —
 * rebuild-all-reviews.js's duplicateTextOf exclusion is CONDITIONAL (recovered
 * when the referenced sibling is stale/missing/circular/itself-excluded), and
 * review-guards.js's canonical `explainExclusion` predicate deliberately does
 * NOT treat bare duplicateTextOf as an exclusion signal for exactly that
 * reason. Reading the actual scored output sidesteps replicating that
 * conditional logic.
 *
 * Two things the naive "just diff reviews.json" version gets wrong (Codex
 * adversarial review, BRO-74):
 *   1. An unnamed ("Unknown"/empty) criticName entry must never count as a
 *      second distinct byline — reviews.json legitimately carries these for
 *      genuinely single-critic URLs, and counting one would manufacture a
 *      false double-count.
 *   2. outletId must be canonicalized on both sides — rebuild-all-reviews.js
 *      writes reviews.json with `normalizeOutlet(data.outletId || data.outlet)`
 *      (rebuild-all-reviews.js's `normalizeOutletCanonical`, the same function
 *      as `review-normalization.js`'s `normalizeOutlet`), but the review-texts
 *      corpus can carry an un-normalized alias — comparing raw strings would
 *      silently miss real double-counts under an outlet alias.
 *
 * normalizeOutlet/normalizeUrl are injected (not required internally) so this
 * module's own decision logic can be unit-tested with synthetic fixtures,
 * independent of the real outlet-registry.json / corpus.
 */

/**
 * @param {Array<{showId?:string, outletId?:string, outlet?:string, url?:string, criticName?:string}>} reviews
 * @param {{normalizeOutlet: (s: string) => string, normalizeUrl: (s: string) => string}} normalizers
 * @returns {Map<string, Set<string>>} key `${showId}|||${canonicalOutletId}|||${normalizedUrl}` -> Set of named critics
 */
function buildLiveScoredIndex(reviews, { normalizeOutlet, normalizeUrl }) {
  const map = new Map();
  for (const r of reviews || []) {
    if (!r || !r.showId || !r.url) continue;
    const critic = String(r.criticName || '').trim();
    if (!critic || critic.toLowerCase() === 'unknown') continue; // unnamed — can't corroborate a second byline
    const key = `${r.showId}|||${canonicalOutlet(r.outletId || r.outlet, normalizeOutlet)}|||${safeNormalizeUrl(r.url, normalizeUrl)}`;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(critic);
  }
  return map;
}

/**
 * @param {Map<string, Set<string>>} index from buildLiveScoredIndex
 * @param {{showId: string, outletId: string, url: string}} candidate
 * @param {{normalizeOutlet: (s: string) => string, normalizeUrl: (s: string) => string}} normalizers
 * @returns {boolean} true when reviews.json carries 2+ distinct named critics for this show+outlet+URL
 */
function isGenuineDoubleCount(index, { showId, outletId, url }, { normalizeOutlet, normalizeUrl }) {
  const key = `${showId}|||${canonicalOutlet(outletId, normalizeOutlet)}|||${safeNormalizeUrl(url, normalizeUrl)}`;
  const critics = index.get(key);
  return !!(critics && critics.size >= 2);
}

function canonicalOutlet(raw, normalizeOutlet) {
  try { return normalizeOutlet(raw) || raw; } catch { return raw; }
}
function safeNormalizeUrl(raw, normalizeUrl) {
  try { return normalizeUrl(raw) || raw; } catch { return raw; }
}

module.exports = { buildLiveScoredIndex, isGenuineDoubleCount };
