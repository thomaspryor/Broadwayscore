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
 * @param {boolean} [opts.recordExtension=true] - set false when the write is a correction, not an extension (BRO-7252)
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
  if (!opts.force && opts.recordExtension !== false) {
    recordClosingExtension(show, newDate, source, opts.todayStr);
  }
  show.closingDate = newDate;
  if (source) show.closingDateSource = source;
  show.closingDateUpdatedAt = opts.todayStr || new Date().toISOString().slice(0, 10);
  return true;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const EXTENDABLE_STATUSES = new Set(['open', 'previews']);

/**
 * BRO-7252: a later closingDate on a running show is an EXTENSION, not an
 * overwrite. Append { announcedAt, from, to, source } to show.closingExtensions
 * so the site can say "Extended through <date> (Nth extension)" and Closing
 * Watch can tell a repeatedly extended run from a real announced closing.
 * Call BEFORE show.closingDate is overwritten (writeClosingDate does).
 * No event for: first-time dates (from is empty), same or earlier dates,
 * closed shows, malformed dates, or a repeat of the last recorded `to`.
 *
 * @returns {object|null} the appended event, or null
 */
function recordClosingExtension(show, newDate, source, todayStr) {
  if (!show || !EXTENDABLE_STATUSES.has(show.status)) return null;
  const from = show.closingDate;
  if (typeof from !== 'string' || typeof newDate !== 'string') return null;
  if (!ISO_DATE.test(from) || !ISO_DATE.test(newDate) || newDate <= from) return null;
  const list = Array.isArray(show.closingExtensions) ? show.closingExtensions : [];
  if (list.length && list[list.length - 1].to === newDate) return null;
  const event = {
    announcedAt: todayStr || new Date().toISOString().slice(0, 10),
    from,
    to: newDate,
    source: source || null,
  };
  show.closingExtensions = [...list, event];
  // The stored count is a press-stated floor for runs whose early extensions have no recorded dates; keep it ahead of the list.
  if (Number.isInteger(show.closingExtensionCount) && show.closingExtensionCount > 0) show.closingExtensionCount += 1;
  return event;
}

module.exports = {
  canWriteClosingDate,
  writeClosingDate,
  recordClosingExtension,
};
