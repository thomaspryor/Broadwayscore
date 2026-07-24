/**
 * significance.js — experiment-agnostic hypothesis tests + the pure A/B
 * report-decision function for analyze-ab-test.js (CLAUDE.md §15 pattern:
 * decision logic lives here, main() only prints — mirrors finance-stats.js /
 * gate-cold-start-rules.js).
 *
 * Why this file exists (2026-07-24): the previous inline zTest() in
 * analyze-ab-test.js was called with (clicks, users) — click counts in the
 * conversion-count slots. clicks > users made the pooled "proportion" > 1,
 * pooled*(1-pooled) negative, Math.sqrt(negative) = NaN, and the analyzer
 * printed "p-value: NaN … ❌ Not yet significant" on every run once the
 * sample crossed the minN=100 guard. Design rules that prevent the class:
 *   - Object args ({conv, n}) — the positional slot-swap that caused the bug
 *     is structurally impossible at the call site.
 *   - Degenerate inputs return a { degenerate: reason } sentinel (matching
 *     the repo's return-null/return-1 idiom), NEVER NaN and never a throw —
 *     and the printer must surface the reason, never render it as a p-value.
 *   - The test-selection / labeling / suppression branching is itself pure
 *     and unit-tested (computeAbSignificance), not inline in the analyzer.
 *
 * Colocated test: significance.test.mjs (runs in the scripts/lib/*.test.mjs
 * CI glob; reference p-values computed independently with python3 math.erf —
 * provenance comments in the test file).
 */

/**
 * Standard normal CDF via the Abramowitz & Stegun 7.1.26 erf approximation
 * (max abs error 1.5e-7 — far below any decision threshold used here).
 */
function normalCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-Math.abs(x) * Math.abs(x));
  // y ≈ erf(|x|); Φ(x) = 0.5 * (1 + erf(x / √2)) — we fold the √2 into the caller.
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Φ for a z-score (i.e. normalCdf of x/√2 folded correctly). */
function phi(z) {
  return normalCdf(z / Math.SQRT2);
}

/**
 * Two-proportion z-test, TWO-TAILED.
 *
 * Two-tailed deliberately: a one-tailed test whose direction is chosen after
 * looking at the data (which is what an analyzer that labels "b vs a" from
 * alphabetical variant order would do) inflates false positives. Two-tailed
 * is direction-agnostic and conservative.
 *
 * @param {{conv: number, n: number}} a  group A: successes / trials
 * @param {{conv: number, n: number}} b  group B: successes / trials
 * @returns {{p: number, z: number, note?: string} | {degenerate: string}}
 *   Never NaN. Degenerate inputs return a reason sentinel the caller must
 *   render as "n/a (<reason>)", never as a p-value.
 */
function twoProportionZTest(a, b) {
  for (const [label, g] of [['a', a], ['b', b]]) {
    if (!g || !Number.isFinite(g.conv) || !Number.isFinite(g.n)) {
      return { degenerate: `group ${label} missing conv/n` };
    }
    if (g.n <= 0) return { degenerate: `group ${label} has n=${g.n} (no trials)` };
    if (g.conv < 0) return { degenerate: `group ${label} has negative conv` };
    if (g.conv > g.n) {
      // The exact shape of the original NaN bug (clicks passed as conv).
      return { degenerate: `group ${label} has conv (${g.conv}) > n (${g.n}) — inputs are not a proportion` };
    }
  }
  const pooled = (a.conv + b.conv) / (a.n + b.n);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / a.n + 1 / b.n));
  if (se === 0) {
    // Both groups at 0% or both at 100% — no variance, no evidence of difference.
    return { degenerate: `no variance (pooled rate ${pooled === 0 ? '0%' : '100%'} in both groups)` };
  }
  const z = (b.conv / b.n - a.conv / a.n) / se;
  const p = 2 * (1 - phi(Math.abs(z)));
  const result = { p: Math.min(1, Math.max(0, p)), z };
  // Normal-approximation validity: expected successes AND failures ≥5 per group.
  const cells = [a.conv, a.n - a.conv, b.conv, b.n - b.conv];
  if (Math.min(...cells) < 5) {
    result.note = 'normal approximation marginal (a success/failure cell < 5) — treat p as rough';
  }
  return result;
}

// Sample-size advisory thresholds (clicks per variant) — carried over from the
// analyzer's original guidance: 100+ detects ~50% lift, 200+ ~30%, 400+ ~20%.
const UNDERPOWERED_MIN_CLICKS = 100;
// Join-quality gates for the conversion primary (pre-mortem guard): a
// clean-looking p computed on a partial subId1 join is worse than no p.
const JOIN_COVERAGE_FLOOR = 0.9;      // per-variant minimum
const JOIN_COVERAGE_MAX_DELTA = 0.1;  // max between-variant gap

/**
 * Pure decision function for the A/B analyzer's significance report.
 * Selects the test, applies join-quality suppression, and labels everything.
 * main() must only FORMAT what this returns.
 *
 * @param {Array<{name: string, clicks: number, users: number,
 *                convUsers: number, convCount: number,
 *                joinCoverage: number|null}>} variants
 *   joinCoverage: fraction of this variant's subId2-attributed conversions
 *   that also carry a usable subId1 (null when the variant has 0 conversions —
 *   nothing to join, treated as fully covered).
 * @returns {object} structured report — see shape below.
 */
function computeAbSignificance(variants) {
  if (!Array.isArray(variants) || variants.length !== 2) {
    return { degenerate: `need exactly 2 variants, got ${Array.isArray(variants) ? variants.length : typeof variants}` };
  }
  const [a, b] = variants;

  const report = {
    primary: {
      metric: 'conversion rate among clickers (unique converting users / unique clicking users)',
      test: 'two-proportion z-test (two-tailed)',
      perVariant: variants.map(v => ({
        name: v.name,
        convUsers: v.convUsers,
        users: v.users,
        rate: v.users > 0 ? v.convUsers / v.users : null,
      })),
      p: null,
      z: null,
      note: null,
      degenerate: null,
      suppressed: null,
      significant: null,
    },
    secondary: {
      metric: 'clicks per user (descriptive only — no significance test)',
      perVariant: variants.map(v => ({
        name: v.name,
        clicksPerUser: v.users > 0 ? v.clicks / v.users : null,
      })),
    },
    joinCoverage: variants.map(v => ({ name: v.name, coverage: v.joinCoverage })),
    underpowered: false,
    underpoweredNote: null,
  };

  // Underpowered advisory (never blocks reporting the p — labeling only).
  const minClicks = Math.min(a.clicks, b.clicks);
  if (minClicks < UNDERPOWERED_MIN_CLICKS) {
    report.underpowered = true;
    report.underpoweredNote =
      `min ${minClicks} clicks/variant — need 100+ for ~50% lift, 200+ for ~30%, 400+ for ~20%`;
  }

  // Join-quality gate: suppress the primary p rather than print a plausible
  // lie built on an incomplete subId1 join (per-variant coverage floor +
  // between-variant delta cap).
  const cov = v => (v.joinCoverage === null || v.joinCoverage === undefined) ? 1 : v.joinCoverage;
  const covA = cov(a); const covB = cov(b);
  if (covA < JOIN_COVERAGE_FLOOR || covB < JOIN_COVERAGE_FLOOR) {
    report.primary.suppressed =
      `subId1 join coverage below ${JOIN_COVERAGE_FLOOR * 100}% (${a.name}: ${(covA * 100).toFixed(0)}%, ${b.name}: ${(covB * 100).toFixed(0)}%) — converting-user counts are incomplete; p not computed`;
    return report;
  }
  if (Math.abs(covA - covB) > JOIN_COVERAGE_MAX_DELTA) {
    report.primary.suppressed =
      `subId1 join coverage differs between variants by ${(Math.abs(covA - covB) * 100).toFixed(0)}pts — an asymmetric join would bias the comparison; p not computed`;
    return report;
  }

  const t = twoProportionZTest(
    { conv: a.convUsers, n: a.users },
    { conv: b.convUsers, n: b.users },
  );
  if (t.degenerate) {
    report.primary.degenerate = t.degenerate;
    return report;
  }
  report.primary.p = t.p;
  report.primary.z = t.z;
  report.primary.note = t.note || null;
  report.primary.significant = t.p < 0.05;
  return report;
}

module.exports = {
  twoProportionZTest,
  computeAbSignificance,
  phi,
  UNDERPOWERED_MIN_CLICKS,
  JOIN_COVERAGE_FLOOR,
  JOIN_COVERAGE_MAX_DELTA,
};
