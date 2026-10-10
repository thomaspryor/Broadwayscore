/**
 * closing-date-guard.js
 *
 * Centralized write-guard for `closingDate` on shows.json entries. Any script
 * that programmatically updates a show's closingDate MUST call
 * `writeClosingDate(show, newDate, source)` instead of mutating the field
 * directly. The guard skips the write when `humanCorrectedClosingDate === true`
 * is set on the show.
 *
 * Pattern mirrors review-text protection (humanReviewedWrongProduction,
 * humanReviewScore, wrongProductionManualClear) — see
 * memory/feedback_protected_fields_every_write.md for the original rule.
 *
 * Why this exists:
 *   closingDate has 8+ writers (update-show-status, audit-closing-dates,
 *   enrich-ob-dates, enrich-wikipedia-runtimes, fix-show-statuses,
 *   discover-new-shows, discover-historical-shows, ibdb-dates). When a human
 *   manually corrects a closingDate via the private repo (as we did for
 *   Death Becomes Her and Beaches on 2026-05-23), any of the auto-writers
 *   can overwrite it on the next run. This guard is the single chokepoint.
 *
 * Bypass: pass `{ force: true }` as the third arg. Reserved for explicitly-
 * manual scripts like fix-show-statuses.js where the operator IS the human
 * correcting the field.
 */

/**
 * Returns true if it is safe to programmatically write closingDate on this
 * show. False means a human-correction guard is set and the auto-write
 * should be skipped (callers should log + continue).
 */
function canWriteClosingDate(show) {
  if (!show) return false;
  return show.humanCorrectedClosingDate !== true;
}

/**
 * Write a new closingDate, respecting the human-correction guard.
 *
 * @param {object} show - shows.json entry (mutated in place if write occurs)
 * @param {string|null} newDate - 'YYYY-MM-DD' or null to clear
 * @param {string} source - audit trail string (e.g. 'broadway.com schedule (audit 2026-05-24)')
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] - bypass the human-correction guard. ONLY for explicitly-manual scripts.
 * @param {(msg: string) => void} [opts.log=console.log] - log function
 * @param {string} [opts.todayStr] - YYYY-MM-DD for closingDateUpdatedAt; defaults to today
 * @returns {boolean} - true if the write occurred, false if blocked by guard
 */
function writeClosingDate(show, newDate, source, opts = {}) {
  const log = opts.log || console.log;
  if (!show) return false;
  if (!opts.force && !canWriteClosingDate(show)) {
    log(`[closing-date-guard] skipping write to ${show.id || '(unknown)'}: humanCorrectedClosingDate=true (preserving ${show.closingDate})`);
    return false;
  }
  show.closingDate = newDate;
  if (source) show.closingDateSource = source;
  show.closingDateUpdatedAt = opts.todayStr || new Date().toISOString().slice(0, 10);
  return true;
}

module.exports = {
  canWriteClosingDate,
  writeClosingDate,
};
