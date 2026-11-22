'use strict';
// The score the site shows for a review-text file (BRO-8060 cousin).
// Review-text files keep the raw assignedScore; reviews.json carries the score
// after the rebuild's star-band clamp and overrides. Anything that tells an LLM
// a review's verdict (Critics' Take, pull quotes) must use the site score, or a
// file saying 59 for a 4/5-star review (site 80) reads as "mixed".
const fs = require('fs');
const path = require('path');
const { applyLiveScores } = require('./critic-consensus-inputs');
const { canonicalizeUrlForDedup } = require('./review-guards');
const { normalizeOutlet } = require('./review-normalization');

function buildLiveScoreLookup(liveRows) {
  const byShow = new Map();
  for (const r of Array.isArray(liveRows) ? liveRows : []) {
    if (!r || !r.showId) continue;
    if (!byShow.has(r.showId)) byShow.set(r.showId, []);
    byShow.get(r.showId).push(r);
  }
  /** Site score for this file, or the file's own assignedScore when there is no unambiguous live twin. */
  return function liveScoreFor(showId, data) {
    const own = typeof data.assignedScore === 'number' ? data.assignedScore : null;
    const rows = byShow.get(showId);
    if (!rows) return own;
    const row = { url: data.url || null, outletId: data.outletId || null, outlet: data.outlet || null, critic: data.criticName || null, score: own };
    applyLiveScores([row], showId, rows, { normalizeOutlet, canonicalizeUrl: canonicalizeUrlForDedup });
    return typeof row.score === 'number' ? row.score : own;
  };
}

/** Reads data/reviews.json; returns null (callers keep file scores) when it is missing or unreadable. */
function loadLiveScoreLookup(reviewsPath = path.join(__dirname, '../../data/reviews.json')) {
  try {
    const j = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
    const rows = Array.isArray(j) ? j : j && j.reviews;
    return Array.isArray(rows) && rows.length ? buildLiveScoreLookup(rows) : null;
  } catch { return null; }
}

/** Verdict direction a prompt tells the LLM (extract-pull-quotes describeVerdict: >=70 positive, 40-69 mixed, <40 negative). */
function verdictBand(score) {
  if (typeof score !== 'number' || Number.isNaN(score)) return 'unknown';
  return score >= 70 ? 'positive' : score >= 40 ? 'mixed' : 'negative';
}

module.exports = { buildLiveScoreLookup, loadLiveScoreLookup, verdictBand };
