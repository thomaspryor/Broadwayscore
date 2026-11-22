'use strict';
// The score the site shows for a review-text file (BRO-8060 cousin).
// Review-text files keep the raw assignedScore; reviews.json carries the score
// after the rebuild's star-band clamp and overrides. Anything that tells an LLM
// a review's verdict (Critics' Take, pull quotes) must use the site score, or a
// file saying 59 for a 4/5-star review (site 80) reads as "mixed".
const crypto = require('crypto');
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

const quoteHash = (q) => crypto.createHash('sha256').update(String(q || '')).digest('hex').slice(0, 12);

/** llmPullQuoteVerdictBand value: the verdict direction a quote was picked for, bound to that exact quote. */
function quoteVerdictStamp(score, quote) {
  return `${verdictBand(score)}:${quoteHash(quote)}`;
}

/**
 * True when a stored pull quote was picked for another verdict direction than
 * the site score gives and the extractor may re-pick it. Never re-picks when
 * live scores are unavailable (no oscillation back to file scores), on a
 * human-curated or locked record, or when another writer changed the quote
 * after it was stamped (the stamp's hash no longer matches).
 */
function needsRetone(data, liveScore, { liveAvailable } = {}) {
  if (!liveAvailable || !data || !data.llmPullQuote) return false;
  if (data._locked === true || data.llmPullQuoteSource === 'human-override' || data.humanReviewScore != null) return false;
  // A quote set through a review-field-edit plan (human or opening-night lane) is recorded in approvedFixes.
  if (Array.isArray(data.approvedFixes) && data.approvedFixes.some(f => f && f.field === 'llmPullQuote')) return false;
  const stamp = data.llmPullQuoteVerdictBand;
  if (typeof stamp === 'string' && stamp) {
    const [band, hash] = stamp.split(':');
    // A stamp for another quote (merge or restore copied one field) says nothing: fall through to the file score.
    if (hash === quoteHash(data.llmPullQuote)) return band !== verdictBand(liveScore);
  }
  // Unstamped quotes were judged on the file's own score.
  return verdictBand(data.assignedScore) !== verdictBand(liveScore);
}

module.exports = { buildLiveScoreLookup, loadLiveScoreLookup, verdictBand, quoteVerdictStamp, needsRetone };
