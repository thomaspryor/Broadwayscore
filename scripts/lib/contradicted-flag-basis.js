/**
 * Detects a GENUINELY STALE exclusion flag: one whose own stated basis is
 * contradicted by the record's current evidence.
 *
 * WHY THIS EXISTS (2026-08-14). The previous standing sweep for stale flags,
 * scripts/audit-stale-flag-after-url-correction.js (#483), keyed on
 * "`_urlChangedClear` breadcrumb present AND no fullText". That signature was
 * measured against the live corpus and is wrong in BOTH directions:
 *
 *   PRECISION 0/120 — every one of its 120 current matches is a CORRECT flag.
 *     Two independent hand adjudications (20/20 and 8/8) plus a third sampling
 *     agree. The reason is structural: a URL "correction" frequently swaps a
 *     correct URL for a DIFFERENT production's, after which the guards re-flag
 *     the record; the flag is then a fresh, correct verdict about the NEW url,
 *     not a leftover. On the matches inspected, `wrongProductionDetectedAt` is
 *     LATER than `_urlChangedClear.at` — the flag post-dates the breadcrumb.
 *
 *   RECALL 0/9 — of the 9 genuinely stale flags in the corpus (this module's
 *     matches, all hand-verified), ZERO carry a `_urlChangedClear` breadcrumb.
 *     The two populations do not intersect at all.
 *
 * So the July #483 class is not detectable from the breadcrumb, and the real
 * stale class needs POSITIVE evidence of contradiction. That is what this
 * module requires, and only that:
 *
 *   1. An exclusion flag is live (wrongProduction and/or wrongShow).
 *   2. EVERY basis string attached to a live flag is a pure date-guard claim.
 *      If any basis mentions content, an LLM verdict, cross-market, a
 *      duplicate/collision, or a dateless-revival judgement, the flag rests on
 *      something a date cannot contradict, and this module says nothing.
 *   3. That basis cites a specific date, and the record's CURRENT publishDate
 *      is a different date — the cited date is gone.
 *   4. The record's current publishDate falls INSIDE the show's own run window
 *      (earliest preview/opening .. closing + DAYS_AFTER_CLOSE). The claim
 *      "this review belongs to a different production" is then contradicted by
 *      the record's own date.
 *
 * Every one of the 9 corpus matches was read by hand: e.g. carousel-2018
 * carries a Vulture review at vulture.com/2018/04/... dated 2018-04-12, inside
 * the 2018-02-28..2018-09-16 run, flagged because a date guard once read
 * 2019-04-24; miss-saigon-2017 carries the Deadline 2017 Broadway revival
 * review dated 2017-03-23, flagged on a cited date of 1974-04-08.
 *
 * This module is DETECTION ONLY and deliberately has no remediation half. The
 * remedy for a match is a hand-adjudicated flag clear with the full
 * PROTECTED_FIELDS set (memory/feedback_manual_review_protection_fields.md),
 * never a bulk drain — the deleted #483 `--fix` is the cautionary tale.
 *
 * Pure module: no fs, no process, no side effects.
 */

'use strict';

const { normalizeDate } = require('./date-utils');
const { earliestShowDate, DAYS_AFTER_CLOSE } = require('./date-guard');

/**
 * Basis prefixes written by the two purely date-derived flag writers:
 * scripts/flag-wrong-production-by-date.js ("Date guard: ...") and the
 * rebuild pre-opening guard ("Pre-opening guard: ..."). Deliberately NOT a
 * general note-prefix taxonomy — this list exists to say "a DATE is the whole
 * of this flag's stated basis", which is the only claim a date can refute.
 * An operator-authored basis is never on this list: a human verdict is not
 * refuted by a re-derived date.
 */
const DATE_ONLY_BASIS_PREFIXES = [
  /^Date guard:/i,
  /^Pre-opening guard:/i,
];

/**
 * Any of these appearing in a basis string means the flag ALSO rests on
 * something other than a date (content, an LLM verdict, market routing, a
 * duplicate/collision, or the ABSENCE of a date), so a date mismatch proves
 * nothing about it. Checked in addition to the prefix test because writers
 * concatenate a second reason onto a date-guard note.
 */
const NON_DATE_BASIS = /Collector LLM|CV-promoted|not a review|Cross-market|duplicate|collision|Dateless revival|not mentioned|roundup|venue|Same URL/i;

/**
 * Fields by which a human (or an operator-run remediation) asserted the flag.
 * A re-derived date must never overturn one of these.
 */
function _hasHumanAssertedFlag(review) {
  if (review.humanReviewedWrongProduction === true) return true;
  if (review.wrongProductionProvenance === 'manual') return true;
  if (review.humanReviewScore != null) return true;
  return false;
}

function _basisStringsForLiveFlags(review) {
  const out = [];
  if (review.wrongProduction === true) {
    out.push(review.wrongProductionNote, review.wrongProductionReason, review.wrongProductionDetail);
  }
  if (review.wrongShow === true) {
    out.push(review.wrongShowReason, review.wrongShowNote, review.wrongShowDetail);
  }
  return out.filter((s) => typeof s === 'string' && s.trim());
}

/**
 * Pull the date a date-guard basis string cites. The three shapes in the
 * corpus, all emitted by the two writers above:
 *   "Date guard: review 2019-04-24 is 213d after ..."
 *   "Date guard: review March 19th, 2025 is 307d before ..."
 *   "Pre-opening guard: review dated 2024-05-29 is 60+ days before ..."
 * Returns a YYYY-MM-DD string or null.
 */
function citedBasisDate(basis) {
  if (typeof basis !== 'string') return null;
  // `.+?` rather than a comma-excluding class: the long-form dates these
  // writers emit contain a comma ("review March 19th, 2025 is 307d before").
  // Lazy, and anchored on the writers' fixed " is <N>d before/after" tail, so
  // it still stops at the first date rather than swallowing the sentence.
  const m = basis.match(/review dated (.+?) is \d/i)
    || basis.match(/review (.+?) is \d+\+? ?d(?:ays)? (?:before|after)/i);
  if (!m) return null;
  return normalizeDate(m[1].trim());
}

function _addDays(ymd, days) {
  const d = new Date(ymd + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {object} args
 * @param {object} args.review - parsed review-text record
 * @param {object} args.show - the show record this review is filed under
 * @returns {{
 *   contradicted: boolean,
 *   flags: string[],
 *   citedDates: string[],
 *   currentDate: string|null,
 *   windowStart: string|null,
 *   windowEnd: string|null
 * }}
 */
function detectContradictedFlagBasis({ review, show } = {}) {
  const none = {
    contradicted: false, flags: [], citedDates: [], currentDate: null,
    windowStart: null, windowEnd: null,
  };
  if (!review || typeof review !== 'object') return none;
  if (!show || typeof show !== 'object') return none;

  const flags = [];
  if (review.wrongProduction === true) flags.push('wrongProduction');
  if (review.wrongShow === true) flags.push('wrongShow');
  if (!flags.length) return none;

  if (_hasHumanAssertedFlag(review)) return none;

  const basisStrings = _basisStringsForLiveFlags(review);
  if (!basisStrings.length) return none;
  const dateOnly = basisStrings.every(
    (b) => DATE_ONLY_BASIS_PREFIXES.some((re) => re.test(b.trim())) && !NON_DATE_BASIS.test(b)
  );
  if (!dateOnly) return none;

  const citedDates = [...new Set(basisStrings.map(citedBasisDate).filter(Boolean))];
  if (!citedDates.length) return none;

  // An LLM-guessed date is not evidence of anything — same carve-out as
  // scripts/lib/date-plausibility.js, for the same reason (a hallucinated year
  // must never move a flag in either direction).
  if (review.dateSource === 'llm-scoring') return none;

  const currentDate = normalizeDate(review.publishDate);
  if (!currentDate) return none;
  if (citedDates.includes(currentDate)) return none; // basis still describes this record

  const windowStart = earliestShowDate(show);
  if (!windowStart) return none;
  const windowEnd = show.closingDate
    ? _addDays(String(show.closingDate).slice(0, 10), DAYS_AFTER_CLOSE)
    : null;
  if (currentDate < windowStart) return none;
  if (windowEnd && currentDate > windowEnd) return none;

  return { contradicted: true, flags, citedDates, currentDate, windowStart, windowEnd };
}

module.exports = {
  detectContradictedFlagBasis,
  citedBasisDate,
  DATE_ONLY_BASIS_PREFIXES,
  NON_DATE_BASIS,
};
