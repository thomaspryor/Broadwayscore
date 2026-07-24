/**
 * Star-vs-Score Mismatch Detector
 *
 * Flags reviews whose EXPLICIT published rating (star / letter grade / fraction)
 * contradicts the site's independent reads — the LLM ensemble score and/or the
 * final assignedScore — by more than a threshold.
 *
 * WHY THIS EXISTS (Birthright, 2026-07-24 user feedback, card #396):
 * Theater Life's David Sheward publishes COMBINED multi-show roundup columns.
 * The wp-api-title extractor grabbed the WordPress post's single rating metadata
 * (2/5 — belonging to a DIFFERENT show in the same column) and attached it to
 * Birthright, whose own footer star was "Birthright *****" (5/5) and whose LLM
 * read was 93 (Rave). Score-routing's `originalScore-priority0` then made the
 * wrong 2/5 star OVERRIDE the correct LLM 93 → the site showed 40 on a 5-star rave.
 *
 * THE DETECTION SIGNAL: compare the normalized explicit rating against the LLM's
 * INDEPENDENT read (llmScore.score), NOT just assignedScore. When star-priority
 * wins, assignedScore EQUALS the (bad) star, so an assignedScore-vs-rating check
 * sees zero gap and misses the bug entirely. The star-vs-LLM gap is the true tell.
 * (The existing rebuild-helpers `originalScore-llm-conflict` flagger is gated on
 * `llmConf !== 'low'`; Birthright's llmScore.confidence was 'low', so that guard
 * never fired. This detector is confidence-agnostic on purpose.)
 *
 * This is a DETECTION guard (audit + daily health-check alert), not a scoring-logic
 * change — it never mutates scores, so it carries no scoring-delta obligation.
 */

const fs = require('fs');
const path = require('path');
const { parseRating } = require('./score-conversion-rules');
const { listShowDirs } = require('./list-show-dirs');

// A gap this large between an explicit critic rating and the site's independent
// read almost always means the rating was mis-extracted (wrong show in a combined
// column, wrong DOM element) or the review is misattributed. 30 points ≈ 1.5 stars.
const DEFAULT_THRESHOLD = 30;

// Exclusion flags: reviews already suppressed from scoring shouldn't alert.
function isExcludedReview(r) {
  return !!(
    r.wrongProduction ||
    r.wrongShow ||
    r.isNonReview ||
    r.duplicateOf ||
    r.duplicateTextOf ||
    r.isRoundupArticle ||
    r.rejectionReason === 'not_a_review'
  );
}

/**
 * Evaluate a single review for a star-vs-score contradiction.
 *
 * @param {object} review        - review-text record or reviews.json entry
 * @param {object} [opts]
 * @param {number} [opts.threshold=30]
 * @returns {null|object} null when not applicable/consistent, else a finding:
 *   { originalRating, expected, ratingType, llm, assigned, gapLLM, gapAssigned, worstGap, scoreSource }
 */
function evaluateReview(review, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;
  if (!review || typeof review !== 'object') return null;
  if (isExcludedReview(review)) return null;

  const originalRating = review.originalScore != null ? review.originalScore
    : (review.originalRating != null ? review.originalRating : null);
  if (originalRating === null || originalRating === undefined || originalRating === '') return null;

  const parsed = parseRating(originalRating);
  if (parsed.expected === null || parsed.unparseable || parsed.isDesignation) return null;
  // Bare integers ("5") are ambiguous — could be 5/100 or 5 stars. parseRating
  // reads them as x/100, which produces false contradictions. Only act on
  // UNAMBIGUOUS explicit ratings (stars/letters/fractions/sentiment/thumb).
  if (parsed.type === 'numeric') return null;

  const expected = parsed.expected;
  const llm = review.llmScore && typeof review.llmScore.score === 'number' ? review.llmScore.score : null;
  const assigned = typeof review.assignedScore === 'number' ? review.assignedScore : null;
  if (llm === null && assigned === null) return null;

  const gapLLM = llm !== null ? Math.abs(expected - llm) : null;
  const gapAssigned = assigned !== null ? Math.abs(expected - assigned) : null;
  const worstGap = Math.max(gapLLM == null ? 0 : gapLLM, gapAssigned == null ? 0 : gapAssigned);

  if (worstGap <= threshold) return null;

  return {
    originalRating,
    expected,
    ratingType: parsed.type,
    llm,
    assigned,
    gapLLM,
    gapAssigned,
    worstGap,
    scoreSource: review.scoreSource || review.originalScoreSource || '',
    // A gap that shows up against the LLM but NOT against assignedScore means the
    // (likely wrong) star WON routing and is hiding in the final score — the
    // Birthright shape. Surface it so triage prioritizes these.
    starWonHidingContradiction: gapLLM != null && gapLLM > threshold && (gapAssigned == null || gapAssigned <= 10),
  };
}

/**
 * Stable key for a finding — used to baseline/acknowledge known mismatches so
 * the daily health check alerts only on genuinely NEW ones (not the historical
 * backlog every day). Same posture as scrapingbee-ack / SEO post-fix grace.
 */
function keyOf(finding) {
  return `${finding.showId}/${finding.file}`;
}

/**
 * Best-effort "when did this review enter the corpus" for the --since window.
 */
function reviewTimestamp(r) {
  const cands = [r.scoreRecoveredAt, r.firstSeenAt, r.publishDate, r.collectedAt, r.scoredAt];
  for (const c of cands) {
    if (!c) continue;
    const t = Date.parse(c);
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

/**
 * Scan a review-texts root directory for star-vs-score mismatches.
 * Shared by the CLI (scripts/audit-star-score-mismatch.js) and the daily
 * health check so both apply identical logic.
 *
 * @param {string} rootDir - path to data/review-texts
 * @param {object} [opts]
 * @param {number} [opts.threshold=30]
 * @param {number|null} [opts.sinceDays=null] - null/0 = whole corpus; else only
 *        reviews whose timestamp is within the window (undated reviews excluded)
 * @param {number} [opts.now=Date.now()] - reference time for the window
 * @param {string[]} [opts.shows] - restrict to these show dirs (default: all)
 * @param {Set<string>|string[]} [opts.baselineKeys] - keys (showId/file) to exclude
 *        as already-known/triaged. New (non-baselined) findings are what alerts.
 * @returns {{ scanned:number, findings:object[], baselinedCount:number }}
 */
function scanReviewTexts(rootDir, opts = {}) {
  const threshold = typeof opts.threshold === 'number' ? opts.threshold : DEFAULT_THRESHOLD;
  const sinceDays = opts.sinceDays == null ? null : opts.sinceDays;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const cutoff = sinceDays ? now - sinceDays * 24 * 3600 * 1000 : null;
  const baseline = opts.baselineKeys
    ? (opts.baselineKeys instanceof Set ? opts.baselineKeys : new Set(opts.baselineKeys))
    : null;

  const shows = opts.shows || listShowDirs(rootDir);
  const findings = [];
  let scanned = 0;
  let baselinedCount = 0;

  for (const showId of shows) {
    const dir = path.join(rootDir, showId);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let r;
      try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { continue; }
      scanned++;
      const finding = evaluateReview(r, { threshold });
      if (!finding) continue;
      if (cutoff !== null) {
        const ts = reviewTimestamp(r);
        if (ts === null || ts < cutoff) continue;
      }
      const full = { showId, file: f, outlet: r.outlet || '', url: r.url || '', ...finding };
      if (baseline && baseline.has(keyOf(full))) { baselinedCount++; continue; }
      findings.push(full);
    }
  }
  findings.sort((a, b) => b.worstGap - a.worstGap);
  return { scanned, findings, baselinedCount };
}

module.exports = {
  DEFAULT_THRESHOLD,
  isExcludedReview,
  evaluateReview,
  reviewTimestamp,
  keyOf,
  scanReviewTexts,
};
