'use strict';

/**
 * monotone-stretch.js — pure, monotone, piecewise-linear score stretch (BRO-4335).
 *
 * Wired (BRO-4335) via applyTailStretch() in scripts/llm-scoring/ensemble.ts,
 * llm-v6 reviews only. Default-OFF: stretchScore() is the identity
 * unless the caller passes { enabled: true } or ENSEMBLE_TAIL_STRETCH=1.
 * The owner-approved candidate is tail-only (identity to 88, 95 -> 99): CV MAE
 * 6.5, 0% bucket change. A full-range stretch fails CLAUDE.md section 13.
 */

// [input, output] knots, sorted by input, outputs non-decreasing, spanning 0..100.
const TAIL_ONLY_KNOTS = Object.freeze([[0, 0], [88, 88], [95, 99], [100, 100]]);

function validateKnots(knots) {
  if (!Array.isArray(knots) || knots.length < 2) throw new Error('need >= 2 knots');
  for (let i = 0; i < knots.length; i++) {
    const [x, y] = knots[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('non-finite knot');
    if (i > 0 && (x <= knots[i - 1][0] || y < knots[i - 1][1])) {
      throw new Error('knots must have increasing x and non-decreasing y');
    }
  }
  if (knots[0][0] !== 0 || knots[knots.length - 1][0] !== 100) throw new Error('knots must span 0..100');
  return knots;
}

function isEnabled(opts) {
  if (opts && typeof opts.enabled === 'boolean') return opts.enabled;
  return process.env.ENSEMBLE_TAIL_STRETCH === '1';
}

/**
 * @param {number} score 0-100
 * @param {{enabled?: boolean, knots?: number[][]}} [opts]
 * @returns {number} stretched score (rounded), identity when disabled or non-finite
 */
function stretchScore(score, opts) {
  if (!Number.isFinite(score)) return score;
  if (!isEnabled(opts)) return score;
  const knots = validateKnots((opts && opts.knots) || TAIL_ONLY_KNOTS);
  const s = Math.min(100, Math.max(0, score));
  for (let i = 1; i < knots.length; i++) {
    const [x0, y0] = knots[i - 1];
    const [x1, y1] = knots[i];
    if (s <= x1) return Math.round(y0 + ((s - x0) / (x1 - x0)) * (y1 - y0));
  }
  return Math.round(knots[knots.length - 1][1]);
}

module.exports = { stretchScore, validateKnots, isEnabled, TAIL_ONLY_KNOTS };
