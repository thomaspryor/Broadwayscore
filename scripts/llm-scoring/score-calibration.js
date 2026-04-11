/**
 * LLM Score Calibration (Phase A — temporary)
 *
 * Maps the raw LLM ensemble score to a calibrated score that compensates for
 * the systematic compression-toward-the-middle bias measured against ground-truth
 * star ratings.
 *
 * THE BIAS (measured 2026-04-11 against 1,030 high-reliability star+LLM paired
 * observations on the same reviews in data/reviews.json):
 *
 *   Critic gave (star)  | n   | LLM mean | Gap
 *   --------------------|-----|----------|------
 *   100 (5/5)           | 157 | 88.7     | -11.3
 *   90  (4.5/5)         |  69 | 84.0     |  -6.0
 *   80  (4/5)           | 395 | 78.8     |  -1.2
 *   70  (3.5/5)         |  15 | 67.9     |  +2.1
 *   60  (3/5)           | 302 | 66.3     |  +6.3
 *   40  (2/5)           |  87 | 45.2     |  +5.2
 *
 * Pattern: LLM ensemble compresses scores toward the middle in BOTH directions.
 * Raves get pulled down (5/5 → ~89 instead of 100). Pans get pushed up (2/5 → ~45
 * instead of 40). Neutral zone (~75-80) is accurate.
 *
 * THIS IS A TEMPORARY BAND-AID. The root cause lives in the scoring rubric at
 * scripts/llm-scoring/config.ts (FEW_SHOT_EXAMPLES anchors a 5/5 review at 87,
 * Score Distribution rule biases default Rave to 83-87, no example >95 in the
 * prompt). Phase B will rewrite the rubric and rescore. When Phase B ships,
 * delete this module and remove the 5 call sites in scripts/lib/rebuild-helpers.js.
 *
 * Why read-time (rebuild) instead of write-time (ensemble-scorer):
 *   - Phase B will replace LLM scoring entirely, so write-time would mean
 *     stamping calibrated values into 35k review-text files for a band-aid
 *     that gets thrown away in 1-2 weeks.
 *   - Read-time is reversible: env flag LLM_CALIBRATION_V1=0 disables, single
 *     rebuild reverts. The data files remain "raw observations."
 *
 * Application rules (enforced by callers in rebuild-helpers.js):
 *   - Apply ONLY to llmScore-sourced returns (5 branches in _getBestScoreCore).
 *   - NEVER apply to: humanReviewScore, originalScore, letter-grade, star,
 *     aggregator, ShowScore, bucket, thumb, bwwScore, adjudicatedScore.
 *   - The 25-point bucket-jump guard at rebuild-helpers.js:431 must compare
 *     RAW LLM to RAW star (calibration is the very last step before return).
 */

'use strict';

const CALIBRATION_VERSION = 'v1';

/**
 * PHASE_B_REMOVE_CALIBRATION
 *
 * Search this string when Phase B (prompt rewrite + rescore) ships. All call
 * sites of `maybeCalibrate()` should be removed and this entire module should
 * be deleted. As of 2026-04-11 the call sites are:
 *
 *   - scripts/lib/rebuild-helpers.js (5 sites: L451, L477, L520, L550, L552)
 *   - scripts/llm-scoring/calibration-impact-report.js (the simulator)
 *   - tests/unit/score-calibration.test.mjs (delete entire file)
 *
 * Notion card tracking the lifecycle:
 *   https://www.notion.so/Scoring-accuracy-LLM-top-end-compression-DoaS-33f637c5416f81a99b38dcb81339a364
 */
const FIXME_PHASE_B_REMOVE_CALIBRATION = true; // grep this constant when Phase B lands

/**
 * Empirical control points (raw LLM input → calibrated output).
 *
 * Built from the 1,030-pair high-reliability dataset, with smoothing toward
 * the bucket boundaries to avoid cliffs. Linear interpolation between points.
 *
 * Top-end design:
 *   - Raw 92+ → 100 (collapses the 92-98 band onto 100). The LLM almost never
 *     produces >95 anyway (only 60 of 12,335 live LLM scores reach 95+, max 98).
 *     Anything the LLM scored 92+ corresponds to a critic-rated 5/5 in the
 *     paired data (mean star = 98.6 at LLM=92).
 *   - Raw 89→95, 86→91 lifts the dense cluster of "anchored Raves" up toward
 *     where Phase B will eventually put them.
 *
 * Bottom-end design:
 *   - Raw 45 → 40 corrects the "Negative bucket too generous" pattern (LLM 45
 *     paired with star 40, gap +5.2).
 *   - Below ~30 we have very few observations; nudge gently down.
 *
 * Neutral zone (65-78): nearly identity. Star=80 → LLM 78.8 (gap -1.2),
 * star=70 → LLM 67.9 (gap +2.1). The LLM is approximately accurate here.
 */
const CALIBRATION_CONTROL_POINTS = [
  [0,   0],
  [15,  10],
  [25,  18],
  [30,  25],
  [35,  30],
  [45,  40],
  [50,  47],
  [55,  53],
  [60,  58],
  [65,  64],
  [70,  70],
  [75,  76],
  [78,  80],
  [80,  82],
  [83,  86],
  [86,  91],
  [89,  95],
  [92,  100],
  [95,  100],
  [98,  100],
  [100, 100],
];

/**
 * Apply the calibration curve to a raw LLM ensemble score.
 *
 * @param {number} rawLlmScore - integer 0-100
 * @returns {number} calibrated integer 0-100
 */
function calibrate(rawLlmScore) {
  if (typeof rawLlmScore !== 'number' || !Number.isFinite(rawLlmScore)) {
    return rawLlmScore;
  }
  // Clamp to [0,100] before interpolating (defensive — caller should not pass out-of-range)
  const x = Math.max(0, Math.min(100, rawLlmScore));

  // Find the bracketing control points
  for (let i = 0; i < CALIBRATION_CONTROL_POINTS.length - 1; i++) {
    const [x0, y0] = CALIBRATION_CONTROL_POINTS[i];
    const [x1, y1] = CALIBRATION_CONTROL_POINTS[i + 1];
    if (x >= x0 && x <= x1) {
      if (x1 === x0) return Math.round(y0);
      const t = (x - x0) / (x1 - x0);
      const y = y0 + t * (y1 - y0);
      return Math.round(y);
    }
  }

  // Should be unreachable given the [0..100] clamp and control points covering 0..100
  return Math.round(x);
}

/**
 * Whether calibration is enabled in the current process.
 * Default OFF (Phase A first commit). Set LLM_CALIBRATION_V1=1 to enable.
 *
 * Phase A second commit will flip the default to ON after the impact report
 * is approved. Until then, the curve is dormant in production and only fires
 * when explicitly enabled (impact-report runs, manual rebuilds, etc).
 */
function isEnabled() {
  return process.env.LLM_CALIBRATION_V1 === '1';
}

/**
 * Convenience: calibrate only if enabled, otherwise return raw.
 *
 * @param {number} rawLlmScore
 * @returns {number}
 */
function maybeCalibrate(rawLlmScore) {
  return isEnabled() ? calibrate(rawLlmScore) : rawLlmScore;
}

module.exports = {
  calibrate,
  maybeCalibrate,
  isEnabled,
  CALIBRATION_CONTROL_POINTS,
  CALIBRATION_VERSION,
};
