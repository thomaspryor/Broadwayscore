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
 *     (skip the flag write, warn) but still EXCLUDE from scoring until a human
 *     corrects the date — never auto-include on this signal (a mis-attached
 *     current-run TR URL on a genuine prior-run review would otherwise ship
 *     into scores silently). validate-data.js CHECK 0 hard-errors unflagged
 *     reviews >180d early, so held misparses surface red in CI with an
 *     actionable message; recovery is just fixing publishDate (no 8-field
 *     manual-clear ceremony, because no flag was written).
 *     Scope: before_preview flags only — an after_close date is more likely a
 *     successor production mislinked back (which can share the TR month near
 *     closing) than a misparse.
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
    // Reject malformed months instead of letting Date.UTC normalize them
    // (/archive/2026/13/ would otherwise fabricate a January-2027 signal).
    if (mo >= 1 && mo <= 12) {
      // Month granularity vs the widest window the date guard ever allows
      // (UK 35d pre-preview grace + 7d post-close). All arithmetic in UTC —
      // ISO date strings parse as UTC midnight; setDate would drift by the
      // local timezone offset.
      const DAY = 86400000;
      const windowStart = Date.parse(earliestStr) - UK_DAYS_BEFORE_PREVIEW * DAY;
      const windowEnd = show.closingDate
        ? Date.parse(show.closingDate) + DAYS_AFTER_CLOSE * DAY
        : null;
      const monthStart = Date.UTC(y, mo - 1, 1);
      const monthEnd = Date.UTC(y, mo, 0, 23, 59, 59);
      // Malformed dates → no signal (conservative: fewer holds, guard flags as usual).
      const startOk = !Number.isNaN(windowStart);
      const endOk = windowEnd === null || !Number.isNaN(windowEnd);
      if (startOk && endOk && monthEnd >= windowStart && (windowEnd === null || monthStart <= windowEnd)) {
        signals.push(`theatre-record-month:${y}/${mo}`);
      }
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
