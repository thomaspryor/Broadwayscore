/**
 * Corpus determinism metrics (task #653).
 *
 * The published review corpus flapped ±150 reviews many times a day: a rebuild
 * entry point published a reviews.json derived from review-texts state that the
 * push-review-texts PROTECTED_FIELDS restore then undid, so the next rebuild
 * anywhere reverted it. On the deploy-watermark history that shows up as a
 * transient excursion — baseline → spike → baseline within minutes — not as
 * steady growth.
 *
 * Pure functions only (no fs, no git) so the audit CLI and its tests share one
 * implementation. Callers supply the watermark samples.
 */

/** Default size (in reviews) below which a swing is treated as ordinary churn. */
const DEFAULT_MIN_DELTA = 40;

/** Default tolerance for "came back to where it started". */
const DEFAULT_TOLERANCE = 10;

/**
 * @param {Array<{t:number, rc:number, sha?:string, subj?:string}>} samples
 *   Watermark samples in ASCENDING time order.
 */
function computeTransitions(samples) {
  const out = [];
  for (let i = 1; i < samples.length; i++) {
    const delta = samples[i].rc - samples[i - 1].rc;
    if (delta === 0) continue;
    out.push({
      t: samples[i].t,
      from: samples[i - 1].rc,
      to: samples[i].rc,
      delta,
      sha: samples[i].sha,
      subj: samples[i].subj,
    });
  }
  return out;
}

/**
 * A transient excursion: sample i differs from both neighbours by >= minDelta in
 * the same direction, and the neighbours land within `tolerance` of each other.
 * That is the published-then-reverted signature; a real corpus change moves the
 * baseline and its neighbours do NOT match.
 *
 * `exact` marks the strict a → b → a case the card's acceptance criteria names.
 */
function findTransientExcursions(samples, { minDelta = DEFAULT_MIN_DELTA, tolerance = DEFAULT_TOLERANCE } = {}) {
  const out = [];
  for (let i = 1; i < samples.length - 1; i++) {
    const prev = samples[i - 1];
    const mid = samples[i];
    const next = samples[i + 1];
    const up = mid.rc - prev.rc;
    const down = mid.rc - next.rc;
    // Same-direction excursion: both diffs share a sign and both clear minDelta.
    if (Math.sign(up) !== Math.sign(down)) continue;
    if (Math.abs(up) < minDelta || Math.abs(down) < minDelta) continue;
    if (Math.abs(next.rc - prev.rc) > tolerance) continue;
    out.push({
      t: mid.t,
      before: prev.rc,
      spike: mid.rc,
      after: next.rc,
      delta: up,
      exact: prev.rc === next.rc,
      sha: mid.sha,
      subj: mid.subj,
    });
  }
  return out;
}

/**
 * Full report for a window of samples.
 *
 * Two decrease counts are reported deliberately. `decreases` is every downward
 * transition including ±1 dedup churn (the corpus legitimately loses single
 * reviews all day). `materialDecreases` counts only drops >= minDelta — that is
 * the flap the card is about, and the number the gate keys on. Reporting the raw
 * count too keeps the gate honest about what it is NOT looking at.
 */
function buildReport(samples, opts = {}) {
  const { minDelta = DEFAULT_MIN_DELTA, tolerance = DEFAULT_TOLERANCE } = opts;
  const transitions = computeTransitions(samples);
  const decreases = transitions.filter(t => t.delta < 0);
  const materialDecreases = decreases.filter(t => Math.abs(t.delta) >= minDelta);
  const excursions = findTransientExcursions(samples, { minDelta, tolerance });
  const counts = samples.map(s => s.rc);
  return {
    samples: samples.length,
    transitions: transitions.length,
    decreases: decreases.length,
    materialDecreases: materialDecreases.length,
    increases: transitions.length - decreases.length,
    minReviewCount: counts.length ? Math.min(...counts) : null,
    maxReviewCount: counts.length ? Math.max(...counts) : null,
    worstDrop: decreases.length ? Math.min(...decreases.map(d => d.delta)) : 0,
    transientExcursions: excursions.length,
    exactReverts: excursions.filter(e => e.exact).length,
    excursionDetail: excursions,
    materialDecreaseDetail: materialDecreases,
    minDelta,
    tolerance,
  };
}

/**
 * Acceptance gate for task #653. Fails when the corpus is still ping-ponging.
 */
function evaluateGate(report, { maxMaterialDecreases = 10, maxExcursions = 0 } = {}) {
  const failures = [];
  if (report.materialDecreases > maxMaterialDecreases) {
    failures.push(
      `${report.materialDecreases} decreases >= ${report.minDelta} reviews (limit ${maxMaterialDecreases})`,
    );
  }
  if (report.transientExcursions > maxExcursions) {
    failures.push(
      `${report.transientExcursions} transient excursion(s) — published-then-reverted corpus (limit ${maxExcursions})`,
    );
  }
  return { pass: failures.length === 0, failures };
}

/**
 * May this rebuild stamp the SHARED deploy watermark?
 *
 * data/audit/deploy-watermark.json is the regression baseline pre-deploy-check.js
 * compares every deploy against, and (task #653) the series the corpus-determinism
 * audit reads. Only a CI rebuild — which checks out canonical core-data and
 * review-texts — produces a count that corresponds to a published reviews.json.
 *
 * A local rebuild reads this machine's `data/review-texts` clone, which
 * memory/feedback_local_rebuild_stale_clone_hazard.md records as having drifted
 * 1430 commits behind canonical. On 2026-08-02T17:54Z a local session committed a
 * watermark of 19626 while every core-data reviews.json around it held 19368 — a
 * +258 baseline the corpus never had. Gate the write instead of trusting the
 * "never rebuild locally" rule to hold.
 */
function shouldWriteDeployWatermark(env = process.env) {
  if (env.ALLOW_LOCAL_WATERMARK === '1') return { write: true, reason: 'ALLOW_LOCAL_WATERMARK=1' };
  // Compare against real values, not truthiness — some local tooling exports CI='false',
  // which a bare `if (env.CI)` would treat as CI and let the write through.
  if (env.CI === 'true' || env.CI === '1') return { write: true, reason: 'CI' };
  return {
    write: false,
    reason: 'local run — a non-canonical review-texts clone must not stamp the shared deploy baseline',
  };
}

// BRO-3581: a CI rebuild losing reviews still re-stamped the watermark with the
// REDUCED count, so pre-deploy-check.js then compared against an already-degraded
// baseline and a 20,000 -> 11,000 slide could pass in steps. The guard is the
// watermark itself, not this run's regression-guard verdict: run A can warn and
// write a lowered reviews.json, then run B sees "ok" against that lowered file
// and would stamp the degraded count anyway.
//
// Two tiers (CLAUDE.md §19, new blocking behaviour lands advisory first):
//  - drop > ENFORCE_PCT: refuse to lower the baseline (deploys keep comparing
//    against the last known-good count; pre-deploy-check blocks until someone
//    re-runs the rebuild with force_write). Historical routine cleanups
//    (-756, -731, -335 of ~20,668, memory/roadmap.md "Rebuild Guard") were all
//    under 4%, so this never fires on them and cannot recreate the 10-day stall
//    BRO-2276's guard history warns about.
//  - WARN_PCT < drop <= ENFORCE_PCT: write as before, but report it as advisory.
const WATERMARK_WARN_PCT = 2.0;
const WATERMARK_ENFORCE_PCT = 10.0;

/**
 * @param {object} p
 * @param {object} [p.env]
 * @param {boolean} [p.forceWrite] --force-write: an intentional reset always writes
 * @param {number} [p.existingWatermarkCount] reviewCount currently in deploy-watermark.json
 * @param {number} p.newCount review count about to be stamped
 * @returns {{write: boolean, reason: string, advisory?: string}}
 */
function evaluateWatermarkWrite({ env = process.env, forceWrite = false, existingWatermarkCount, newCount }) {
  const base = shouldWriteDeployWatermark(env);
  if (!base.write) return base;
  if (forceWrite) return { write: true, reason: `${base.reason}, --force-write` };
  if (!(existingWatermarkCount > 0) || !(newCount < existingWatermarkCount)) return base;
  const pct = ((existingWatermarkCount - newCount) / existingWatermarkCount) * 100;
  const shown = pct.toFixed(1);
  if (pct > WATERMARK_ENFORCE_PCT) {
    return {
      write: false,
      reason: `review count ${existingWatermarkCount} -> ${newCount} is a ${shown}% drop (>${WATERMARK_ENFORCE_PCT}%); keeping the last known-good baseline. Intentional? re-run the rebuild with force_write`,
    };
  }
  if (pct > WATERMARK_WARN_PCT) {
    return { ...base, advisory: `baseline lowered ${shown}% (${existingWatermarkCount} -> ${newCount}); refused above ${WATERMARK_ENFORCE_PCT}%` };
  }
  return base;
}

module.exports = {
  shouldWriteDeployWatermark,
  evaluateWatermarkWrite,
  WATERMARK_WARN_PCT,
  WATERMARK_ENFORCE_PCT,
  DEFAULT_MIN_DELTA,
  DEFAULT_TOLERANCE,
  computeTransitions,
  findTransientExcursions,
  buildReport,
  evaluateGate,
};
