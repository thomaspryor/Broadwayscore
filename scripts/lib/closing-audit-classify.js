/**
 * closing-audit-classify.js
 *
 * Pure decision functions for audit-closing-dates.js, extracted so the
 * possibly-closed routing is testable (CLAUDE.md §15).
 *
 * Why this exists: broadway.com REMOVES a show's page shortly after it
 * closes. The removed page stops matching the show's title, so the audit
 * filed it under `errors: broadway_com_title_mismatch` — a bucket nobody
 * reviews — instead of the POSSIBLY_CLOSED review path that the
 * empty-calendar case already had. Celebrity Autobiography closed
 * 2026-06-21 but sat stored open-through-9/6 for 3+ weeks while the audit
 * "succeeded" daily (same silent-error class as Burnout Paradise). A page
 * that vanished is at least as strong a closed signal as an empty calendar,
 * so both routes go through this one classifier.
 */

/**
 * Classify a show whose broadway.com schedule gave us no usable future
 * dates — either the page no longer matches the show's title
 * (kind='title_mismatch': removed page, or a slug collision) or it matched
 * but lists zero future performances (kind='empty_schedule').
 *
 * @param {object} opts
 * @param {string|null} opts.closingDate - stored YYYY-MM-DD close, or null
 * @param {string} opts.todayStr - YYYY-MM-DD
 * @param {number} opts.minDays - POSSIBLY_CLOSED_MIN_DAYS threshold
 * @param {boolean} opts.allowlisted - human-verified false positive
 * @param {'title_mismatch'|'empty_schedule'} opts.kind
 * @returns {{action: 'POSSIBLY_CLOSED_NEEDS_REVIEW'|'ERROR', daysUntilStored: number|null, reason: string}}
 */
function classifyMissingSchedule({ closingDate, todayStr, minDays, allowlisted, kind }) {
  const daysUntilStored = closingDate
    ? Math.round((new Date(closingDate) - new Date(todayStr)) / 86400000)
    : null;
  if (closingDate && daysUntilStored >= minDays && !allowlisted) {
    return { action: 'POSSIBLY_CLOSED_NEEDS_REVIEW', daysUntilStored, reason: kind };
  }
  return {
    action: 'ERROR',
    daysUntilStored,
    reason: kind === 'title_mismatch' ? 'broadway_com_title_mismatch' : 'no_future_dates_on_schedule',
  };
}

/**
 * Triple-signal agreement rule for POSSIBLY_CLOSED shows. Unlike the
 * schedule-retraction case there is no broadway.com date to corroborate
 * against — the missing/empty page IS the corroborating signal. The press
 * cluster (which closing-date-discovery.js only returns when ≥2 credible
 * sources agree, or 1 names an explicit final performance) must announce a
 * date EARLIER than stored: that confirms the possibly-closed hypothesis.
 * A press date at/after stored contradicts it (page removal was probably a
 * broadway.com quirk or slug change) → human review instead.
 *
 * @param {string} stored - stored YYYY-MM-DD closingDate
 * @param {string} pressDate - discovered YYYY-MM-DD announced close
 * @returns {boolean} true when it is safe to auto-apply pressDate
 */
function possiblyClosedPressAgreement(stored, pressDate) {
  if (!stored || !pressDate) return false;
  const s = new Date(stored);
  const p = new Date(pressDate);
  if (isNaN(s.getTime()) || isNaN(p.getTime())) return false;
  return p < s;
}

module.exports = { classifyMissingSchedule, possiblyClosedPressAgreement };
