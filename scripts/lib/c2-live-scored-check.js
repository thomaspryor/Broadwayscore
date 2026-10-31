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
 * Three things the naive "just diff reviews.json" version gets wrong (Codex
 * + /code-review adversarial review, BRO-74):
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
 *   3. Checking "2+ critics exist somewhere for this URL" is too coarse when
 *      3+ corpus files share one URL: if 2 are genuinely live and a 3rd is
 *      legitimately excluded via duplicateTextOf, a size>=2 check flags EVERY
 *      pair — including the one involving the excluded file — reintroducing a
 *      narrower version of the false positive this module exists to prevent.
 *      isGenuineDoubleCount therefore takes the SPECIFIC pair's two critic
 *      names and requires BOTH to be individually present in the live set
 *      (normalized via normalizeCritic, so alias spellings still match — the
 *      same reasoning as outletId above, applied to critic names).
 *
 * normalizeOutlet/normalizeUrl/normalizeCritic are injected (not required
 * internally) so this module's own decision logic can be unit-tested with
 * synthetic fixtures, independent of the real outlet-registry.json / corpus.
 */

/**
 * @param {Array<{showId?:string, outletId?:string, outlet?:string, url?:string, criticName?:string}>} reviews
 * @param {{normalizeOutlet: (s: string) => string, normalizeUrl: (s: string) => string, normalizeCritic: (s: string) => string}} normalizers
 * @returns {Map<string, Set<string>>} key `${showId}|||${canonicalOutletId}|||${normalizedUrl}` -> Set of normalized critic names
 */
function buildLiveScoredIndex(reviews, { normalizeOutlet, normalizeUrl, normalizeCritic }) {
  const map = new Map();
  for (const r of reviews || []) {
    if (!r || !r.showId || !r.url) continue;
    const critic = canonicalCritic(r.criticName, normalizeCritic);
    if (critic === 'unknown') continue; // unnamed — can't corroborate a second byline
    const key = `${r.showId}|||${canonicalOutlet(r.outletId || r.outlet, normalizeOutlet)}|||${safeNormalizeUrl(r.url, normalizeUrl)}`;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(critic);
  }
  return map;
}

/**
 * @param {Map<string, Set<string>>} index from buildLiveScoredIndex
 * @param {{showId: string, outletId: string, url: string, critic1: string, critic2: string}} candidate
 *   critic1/critic2 are the two SPECIFIC corpus filenames' criticName values being compared.
 * @param {{normalizeOutlet: (s: string) => string, normalizeUrl: (s: string) => string, normalizeCritic: (s: string) => string}} normalizers
 * @returns {boolean} true only when reviews.json carries BOTH of these two
 *   specific (normalized) critics as live, distinct entries for this exact
 *   show+outlet+URL right now — not merely "2+ critics exist somewhere".
 */
function isGenuineDoubleCount(index, { showId, outletId, url, critic1, critic2 }, { normalizeOutlet, normalizeUrl, normalizeCritic }) {
  const key = `${showId}|||${canonicalOutlet(outletId, normalizeOutlet)}|||${safeNormalizeUrl(url, normalizeUrl)}`;
  const critics = index.get(key);
  if (!critics) return false;
  const c1 = canonicalCritic(critic1, normalizeCritic);
  const c2 = canonicalCritic(critic2, normalizeCritic);
  if (c1 === 'unknown' || c2 === 'unknown' || c1 === c2) return false;
  return critics.has(c1) && critics.has(c2);
}

function canonicalOutlet(raw, normalizeOutlet) {
  try { return normalizeOutlet(raw) || raw; } catch { return raw; }
}
function canonicalCritic(raw, normalizeCritic) {
  try { return normalizeCritic(raw) || 'unknown'; } catch { return 'unknown'; }
}
// normalizeUrl already has its own internal try/catch (falls back to '' on
// error) — no need to double-wrap it. The `|| raw` fallback still matters for
// the empty-string case (falsy/unparseable input).
function safeNormalizeUrl(raw, normalizeUrl) {
  return normalizeUrl(raw) || raw;
}

module.exports = { buildLiveScoredIndex, isGenuineDoubleCount };
