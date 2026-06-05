'use strict';

/**
 * Topic-level dedup for the feedback bug pipeline.
 *
 * The pipeline created a fresh `bug-diagnosis` issue (and sent a fresh owner
 * email) every time ANY user reported a bug — even when an identical bug was
 * already open and unresolved. Result: the same underlying issue (e.g. a Drama
 * Desk co-winner dropped at scrape) generated a new issue + email every single
 * day it was re-reported. See #356/#358 (same Caissie Levy bug), #346/#352
 * (same Off-Broadway listings bug), #270/#279 (same scores-fluctuate bug).
 *
 * `findDuplicateOpenBug` decides whether a newly-diagnosed bug matches an
 * already-open bug-diagnosis issue, so the caller can comment on the existing
 * issue instead of creating a new one + re-pinging the owner.
 *
 * Pure function — no I/O. The workflow extracts existing-issue diagnoses from
 * the embedded DIAGNOSIS_JSON and passes them in. Tested in
 * scripts/test-feedback-dedup.mjs.
 */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'is', 'are', 'was', 'were', 'be',
  'been', 'being', 'to', 'of', 'in', 'on', 'at', 'for', 'with', 'as', 'by',
  'that', 'this', 'it', 'its', 'user', 'reports', 'report', 'reported',
  'reporting', 'submission', 'submitted', 'flags', 'flagged', 'says', 'said',
  'show', 'shows', 'site', 'page', 'appears', 'appear', 'incorrectly',
  'missing', 'wrong', 'should', 'would', 'could', 'from', 'has', 'have',
  'about', 'also', 'not', 'no', 'their', 'they', 'there', 'which', 'who',
  'whom', 'what', 'when', 'where', 'anonymous', 'independently',
]);

/**
 * Normalize free text into a Set of significant tokens for fuzzy matching.
 */
function tokenize(text) {
  if (!text || typeof text !== 'string') return new Set();
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return new Set(tokens);
}

/**
 * Count shared tokens between two sets.
 */
function intersectionSize(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter;
}

/**
 * Jaccard similarity between two token sets (|A∩B| / |A∪B|).
 */
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  const inter = intersectionSize(a, b);
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Overlap coefficient (|A∩B| / min(|A|,|B|)). More forgiving than Jaccard when
 * one description is much more verbose than the other — the common case for
 * the same bug reported tersely once and at length another time.
 */
function overlap(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  return intersectionSize(a, b) / Math.min(a.size, b.size);
}

/**
 * Build a comparable text blob from a diagnosis-like object.
 * Falls back across the fields the pipeline actually populates.
 */
function diagnosisText(diag) {
  if (!diag) return '';
  return [
    diag.summary,
    diag.whatsHappening,
    diag.submitterShow,
    diag.originalMessage,
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * Returns the first existing open bug that the new diagnosis duplicates, or
 * null if none.
 *
 * Match rules (first that fires wins):
 *  1. Same resolved showId (non-null) AND topic similarity ≥ showMatchThreshold
 *     — a lower bar, because the show is already pinned.
 *  2. No usable showId on either side, but topic similarity ≥ topicThreshold
 *     — for show-agnostic bugs (e.g. "scores fluctuate daily", "OB listings
 *     missing").
 *
 * @param {object} newDiag         New diagnosis ({summary, whatsHappening, showId, submitterShow, originalMessage})
 * @param {Array<{number:number, diagnosis:object}>} openBugs  Existing open bug-diagnosis issues
 * @param {object} [opts]
 * @param {number} [opts.showMatchThreshold=0.25]  Jaccard bar when showId matches
 * @param {number} [opts.topicThreshold=0.5]       Overlap-coefficient bar when no showId
 * @returns {{number:number, diagnosis:object, similarity:number, reason:string}|null}
 */
function findDuplicateOpenBug(newDiag, openBugs, opts = {}) {
  const showMatchThreshold = opts.showMatchThreshold ?? 0.25;
  const topicThreshold = opts.topicThreshold ?? 0.5;

  if (!newDiag || !Array.isArray(openBugs) || openBugs.length === 0) return null;

  const newTokens = tokenize(diagnosisText(newDiag));
  const newShow = newDiag.showId || null;

  let best = null;

  for (const entry of openBugs) {
    const existing = entry.diagnosis;
    if (!existing) continue;

    const existTokens = tokenize(diagnosisText(existing));
    const jac = jaccard(newTokens, existTokens);
    const existShow = existing.showId || null;

    let isDup = false;
    let reason = '';
    let sim = jac;

    if (newShow && existShow && newShow === existShow && jac >= showMatchThreshold) {
      // Show already pinned — a modest topic overlap is enough.
      isDup = true;
      reason = `same showId "${newShow}" + topic similarity ${jac.toFixed(2)}`;
    } else if (!newShow && !existShow) {
      // Show-agnostic bug — use overlap coefficient so a terse report and a
      // verbose report of the same issue still match.
      const ov = overlap(newTokens, existTokens);
      if (ov >= topicThreshold) {
        isDup = true;
        sim = ov;
        reason = `show-agnostic topic overlap ${ov.toFixed(2)}`;
      }
    }

    if (isDup && (!best || sim > best.similarity)) {
      best = { number: entry.number, diagnosis: existing, similarity: sim, reason };
    }
  }

  return best;
}

module.exports = { findDuplicateOpenBug, tokenize, jaccard, diagnosisText };
