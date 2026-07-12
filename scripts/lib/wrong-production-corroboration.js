/**
 * Current-run corroboration check for date-based wrongProduction flags.
 *
 * A misparsed publishDate (stale meta tag, widget date, non-ISO parse) can make
 * the date guards auto-flag a CURRENT-run review as wrongProduction, silently
 * suppressing a legit T1 review. Incident 2026-07-11: care-west-end-2026 The
 * Stage review stamped 2023-10-12 (live page: 2026-05-20) — auto-flagged,
 * Data Validation red, T1 review suppressed (review-texts ed6f662bf6).
 *
 * Signals, calibrated on the 2026-07-12 live-page sweep of flagged files:
 *   - 'theatre-record-month' (STRONG): theatreRecordUrl /archive/YYYY/M/ places
 *     the review inside the show's run window — Theatre Record's own dating,
 *     independent of the scraped publishDate. Sweep: majority of TR-month
 *     contradictions were confirmed misparses. Callers should HOLD the flag
 *     (skip + warn, route to human review).
 *   - 'roundup-excerpt' (WEAK): the current production's aggregator roundup
 *     page cited this review (theatreReviewsExcerpt / theStageExcerpt /
 *     lboRoundupExcerpt). Venue-page ingestion can attach these to genuine
 *     prior-run reviews — sweep: ~75% of excerpt-only contradictions were
 *     still correct flags. Callers should flag as usual but WARN for human
 *     review; never auto-clear on this signal alone.
 *   - aggregatorStars is deliberately NOT a signal: it is scraped from the
 *     article page itself (aggregatorStarsSource: stage-star-svg etc.) and
 *     exists on prior-run reviews too (1789 stars-only false corroborations
 *     in the same sweep).
 */

const { earliestShowDate, DAYS_AFTER_CLOSE, UK_DAYS_BEFORE_PREVIEW } = require('./date-guard');

const ROUNDUP_EXCERPT_FIELDS = ['theatreReviewsExcerpt', 'theStageExcerpt', 'lboRoundupExcerpt'];

/**
 * Pure decision. Returns:
 *   { strength: 'strong' | 'weak' | null, signals: string[] }
 * strength 'strong' → hold the auto-flag (skip + warn);
 * strength 'weak'   → flag but warn for human review;
 * null              → no corroboration, flag as usual.
 */
function evaluateCurrentRunCorroboration({ review, show }) {
  const signals = [];

  // (a) theatreRecordUrl month inside run window. Only the /archive/YYYY/M/
  // URL shape carries a date; /archive/volume|issue/ URLs are skipped.
  const m = String((review && review.theatreRecordUrl) || '').match(/\/archive\/(\d{4})\/(\d{1,2})\//);
  const earliestStr = show ? earliestShowDate(show) : null;
  if (m && earliestStr) {
    const y = parseInt(m[1], 10);
    const mo = parseInt(m[2], 10);
    // Month granularity vs the widest window the date guard ever allows
    // (UK 35d pre-preview grace + 7d post-close).
    const windowStart = new Date(earliestStr);
    windowStart.setDate(windowStart.getDate() - UK_DAYS_BEFORE_PREVIEW);
    let windowEnd = null;
    if (show.closingDate) {
      windowEnd = new Date(show.closingDate);
      windowEnd.setDate(windowEnd.getDate() + DAYS_AFTER_CLOSE);
    }
    const monthStart = new Date(Date.UTC(y, mo - 1, 1));
    const monthEnd = new Date(Date.UTC(y, mo, 0, 23, 59, 59));
    if (monthEnd >= windowStart && (!windowEnd || monthStart <= windowEnd)) {
      signals.push(`theatre-record-month:${y}/${mo}`);
    }
  }

  // (b) current-run roundup excerpts.
  for (const f of ROUNDUP_EXCERPT_FIELDS) {
    if (review && review[f]) signals.push(`roundup-excerpt:${f}`);
  }

  const strength = signals.some(s => s.startsWith('theatre-record-month:'))
    ? 'strong'
    : (signals.length ? 'weak' : null);
  return { strength, signals };
}

module.exports = { evaluateCurrentRunCorroboration, ROUNDUP_EXCERPT_FIELDS };
