/**
 * related-shows-ab.js: pure decisions for the related-shows-position A/B (BRO-5989).
 * The component (src/components/RelatedShowsCompactAB.tsx) and the show page both
 * call these, and tests/unit/related-shows-ab-test.test.mjs requires the real thing.
 */

const RELATED_SHOWS_FLAG = 'related-shows-position';
const VARIANT_COMPACT = 'compact-after-reviews';
const COMPACT_MAX = 5;

/**
 * Pick the compact row's shows: dedupe by id, drop the page's own show, and keep
 * only pages the site indexes (a noindex page must never be linked from the test row).
 * `candidates` come pre-ordered (open recs first, then closed).
 */
function pickCompactRelated(candidates, ownShowId, isIndexable, max = COMPACT_MAX) {
  const seen = new Set([ownShowId]);
  const out = [];
  for (const s of candidates) {
    if (out.length >= max) break;
    if (!s || seen.has(s.id)) continue;
    seen.add(s.id);
    if (!isIndexable(s)) continue;
    out.push(s);
  }
  return out;
}

function normalCdf(z) {
  // Abramowitz-Stegun 7.1.26 via erf; accurate to ~1e-7, plenty for a sample size.
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

function normalQuantile(p) {
  // Bisection on normalCdf: no dependency, deterministic.
  let lo = -10, hi = 10;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (normalCdf(mid) < p) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Per-arm n for a two-sided two-proportion z-test (unpooled-variance power formula). */
function sampleSizePerArm({ p1, p2, alpha = 0.05, power = 0.8 }) {
  if (!(p1 > 0 && p1 < 1 && p2 > 0 && p2 < 1) || p1 === p2) throw new Error('p1 and p2 must differ and lie in (0,1)');
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  const pbar = (p1 + p2) / 2;
  const num = za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2));
  return Math.ceil((num * num) / ((p2 - p1) * (p2 - p1)));
}

/** Days for both arms to reach n at `perDay` eligible landers/day split 50/50. */
function daysToReach(nPerArm, perDay) {
  return Math.ceil((nPerArm * 2) / perDay);
}

module.exports = { RELATED_SHOWS_FLAG, VARIANT_COMPACT, COMPACT_MAX, pickCompactRelated, sampleSizePerArm, daysToReach };
