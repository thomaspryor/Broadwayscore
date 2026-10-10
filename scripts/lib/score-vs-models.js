/**
 * Score-vs-models detector (BRO-4596). Flags a review whose PUBLISHED score
 * (getBestScore, the same function the rebuild uses) sits far from what the
 * scoring models read, so a bad score is found by a standing check instead of
 * a reader. Detection only: never mutates a record.
 *
 * Found by one-off scans on 2026-10-04: 69 of 23,586 scored reviews sat 25+
 * points and a bucket from the model median. Seven were real bugs (Mincemeat /
 * Chicago Tribune, BRO-4499); the rest were genuine published stars or
 * deliberate human overrides, which this check excludes.
 */

'use strict';

const { getBestScore } = require('./rebuild-helpers');
const { isExcludedReview } = require('./star-score-mismatch');

const DEFAULT_GAP = 25;

const bucket = (x) => (x >= 70 ? 'positive' : x <= 40 ? 'negative' : 'mixed');

/** Median of the individual model scores on the record, or null when fewer than 2 models read it. */
function modelMedian(record) {
  const e = record && record.ensembleData;
  if (!e || e.singleModelEmergency) return null;
  const xs = [e.claudeScore, e.openaiScore, e.geminiScore].filter((v) => typeof v === 'number' && v > 0);
  if (xs.length < 2) return null;
  xs.sort((a, b) => a - b);
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}

/**
 * @param {object} record - review-text record
 * @param {{gap?: number}} [opts]
 * @returns {null|{score:number, source:string, median:number, gap:number}}
 */
function evaluateScoreVsModels(record, opts = {}) {
  const gap = typeof opts.gap === 'number' ? opts.gap : DEFAULT_GAP;
  if (!record || typeof record !== 'object' || isExcludedReview(record)) return null;
  const median = modelMedian(record);
  if (median === null) return null;
  let best;
  try { best = getBestScore(record, { stats: {} }); } catch { return null; }
  if (!best || typeof best.score !== 'number') return null;
  // A locked human override is the owner's word, not a defect (getBestScore P0).
  if (best.source === 'human-review') return null;
  const d = Math.abs(best.score - median);
  if (d < gap || bucket(best.score) === bucket(median)) return null;
  return { score: best.score, source: best.source, median, gap: Math.round(d * 10) / 10 };
}

/** Stable per-finding key: score and source are part of it so a changed score re-alerts. */
function keyOf(f) {
  return `${f.showId}/${f.file}#${f.source}:${f.score}`;
}

module.exports = { DEFAULT_GAP, modelMedian, evaluateScoreVsModels, keyOf };
