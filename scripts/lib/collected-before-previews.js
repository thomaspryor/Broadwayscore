'use strict';

/**
 * Collected-before-previews guard (BRO-4855).
 *
 * A review with no usable date (no parsed publishDate, no full YYYY-MM-DD in
 * its url) escapes every dated wrongProduction guard and defaults to
 * includable. The dateless-revival hold (date-guard.js
 * evaluateDatelessRevivalGuard) only covers titles with 2+ productions in
 * shows.json, so a single-production title is unguarded.
 *
 * firstSeenAt is the immutable "when did this review first reach us" clock
 * (review-file-writer.js stamps it at creation; backfill-first-seen.js derived
 * it from git history for older files). A review we already held BEFORE the
 * production's first preview cannot be a review of that production: critics
 * have not seen it yet. It is an aggregator listing of some other staging.
 * Case: Two Girls (off-Broadway 2026, previews 2026-10-07) carried four
 * dateless nyc-theatre excerpts of School Girls, firstSeenAt 2026-10-01.
 *
 * Abstains (never flags) when:
 *   - the review has a usable date: the dated guards own that decision;
 *   - the show declares priorRuns or tourLegs: an earlier staging may be one
 *     we count, and its reviews legitimately predate this run's previews;
 *   - previewsStartDate is AFTER openingDate: bad show data, no reliable anchor;
 *   - firstSeenAt or the anchor date is missing or unparseable.
 * With no previewsStartDate the anchor is openingDate minus
 * OPENING_ONLY_PREVIEW_ALLOWANCE_DAYS, so a review first seen during the
 * (undated) previews is not held.
 *
 * The hold is provisional: shouldAutoClearCollectedBeforePreviews
 * (wrong-production-autoclear.js) re-runs this evaluator and releases the
 * flag once it no longer fires (a date arrives, priorRuns are declared, the
 * preview date is corrected) or a human overrides.
 *
 * Pure module: no fs, no requires, no side effects.
 */

const COLLECTED_BEFORE_PREVIEWS_REASON = 'collected-before-previews';
const COLLECTED_BEFORE_PREVIEWS_NOTE_PREFIX = 'Collected-before-previews guard';
// Slack for timezone skew (firstSeenAt is UTC, show dates are local calendar
// dates) and a preview date that slipped by a day or two in shows.json.
const DEFAULT_MARGIN_DAYS = 3;
// No previewsStartDate: the real first preview is unknown but precedes
// openingDate, and a review first seen during previews may be genuine (an
// early/preview review). Anchor this many days before opening instead, about
// the longest usual preview period.
const OPENING_ONLY_PREVIEW_ALLOWANCE_DAYS = 35;
const DAY_MS = 86400000;

function parseYmd(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const t = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(t) ? null : t;
}

function parseInstant(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * @param {object} args
 * @param {boolean} args.hasUsableDate - true when the review has a usable date
 * @param {string|null|undefined} args.firstSeenAt - the review's firstSeenAt (ISO)
 * @param {{ previewsStartDate?: string, openingDate?: string, priorRuns?: any[], tourLegs?: any[] }|null} args.show
 * @param {number} [args.marginDays]
 * @returns {{ flag: boolean, reason: string|null, anchor?: string, firstSeen?: string }}
 */
function evaluateCollectedBeforePreviews({ hasUsableDate, firstSeenAt, show, marginDays = DEFAULT_MARGIN_DAYS } = {}) {
  if (hasUsableDate) return { flag: false, reason: null };
  if (!show) return { flag: false, reason: null };
  if ((Array.isArray(show.priorRuns) && show.priorRuns.length)
      || (Array.isArray(show.tourLegs) && show.tourLegs.length)) {
    return { flag: false, reason: 'prior_runs_declared' };
  }
  const previews = parseYmd(show.previewsStartDate);
  const opening = parseYmd(show.openingDate);
  if (previews != null && opening != null && previews > opening) {
    return { flag: false, reason: 'previews_after_opening' };
  }
  const anchor = previews != null
    ? previews
    : (opening != null ? opening - OPENING_ONLY_PREVIEW_ALLOWANCE_DAYS * DAY_MS : null);
  if (anchor == null) return { flag: false, reason: null };
  const seen = parseInstant(firstSeenAt);
  if (seen == null) return { flag: false, reason: null };
  const margin = Number.isFinite(marginDays) && marginDays >= 0 ? marginDays : DEFAULT_MARGIN_DAYS;
  if (seen >= anchor - margin * DAY_MS) return { flag: false, reason: null };
  return {
    flag: true,
    reason: COLLECTED_BEFORE_PREVIEWS_REASON,
    anchor: new Date(anchor).toISOString().slice(0, 10),
    firstSeen: new Date(seen).toISOString().slice(0, 10),
  };
}

/**
 * Flag-pass decision for one review record: evaluateCollectedBeforePreviews
 * plus the record-level gate. A human wrongProduction verdict
 * (humanReviewedWrongProduction === true) is already decided: never re-flag it
 * under this guard's reason (the auto-clear also never releases such a hold,
 * isWrongProductionHeld, BRO-3585).
 *
 * @param {object} review
 * @param {{ hasUsableDate: boolean, show: object|null }} ctx
 * @returns {{ flag: boolean, reason: string|null, anchor?: string, firstSeen?: string }}
 */
function shouldFlagCollectedBeforePreviews(review, { hasUsableDate, show } = {}) {
  if (!review) return { flag: false, reason: null };
  // Either human verdict (true: already flagged by a person; false: a person
  // rejected wrongProduction) is final for this heuristic.
  if (typeof review.humanReviewedWrongProduction === 'boolean') return { flag: false, reason: 'human_reviewed' };
  return evaluateCollectedBeforePreviews({ hasUsableDate, firstSeenAt: review.firstSeenAt, show });
}

/** True when the record carries this guard's own hold (reason or note prefix). */
function isCollectedBeforePreviewsHold(data) {
  if (!data || data.wrongProduction !== true) return false;
  if (data.wrongProductionReason === COLLECTED_BEFORE_PREVIEWS_REASON) return true;
  return typeof data.wrongProductionNote === 'string'
    && data.wrongProductionNote.startsWith(COLLECTED_BEFORE_PREVIEWS_NOTE_PREFIX);
}

module.exports = {
  COLLECTED_BEFORE_PREVIEWS_REASON,
  COLLECTED_BEFORE_PREVIEWS_NOTE_PREFIX,
  DEFAULT_MARGIN_DAYS,
  OPENING_ONLY_PREVIEW_ALLOWANCE_DAYS,
  evaluateCollectedBeforePreviews,
  shouldFlagCollectedBeforePreviews,
  isCollectedBeforePreviewsHold,
  // Exported so scoring-delta's moduleFingerprint sees helper-only edits.
  parseYmd,
  parseInstant,
};
