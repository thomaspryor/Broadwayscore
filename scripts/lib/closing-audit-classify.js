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
  // No stored closingDate at all + title-confirmed page with ZERO future
  // performances (The Balusters class: limited run ended 2026-06-21, never
  // had a closingDate, sat stale-open in silent errors). Open-run musicals
  // never reach here — they're filtered by openRunSkip — so an empty
  // calendar on a no-close show is a strong closed signal. Scoped to
  // empty_schedule only: title_mismatch without a stored close is far more
  // likely a slug collision on a newly-added show (SLUG_OVERRIDE hint path).
  if (!closingDate && kind === 'empty_schedule' && !allowlisted) {
    return { action: 'POSSIBLY_CLOSED_NEEDS_REVIEW', daysUntilStored: null, reason: kind };
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
 * For kind='title_mismatch' the bar is higher: the page didn't confirm the
 * show at all, so it could be a slug collision on a RUNNING production
 * (e.g. a revival whose slug now resolves to another staging). A same-title
 * press cluster could then auto-retract a healthy show. Requiring the press
 * date to also be in the PAST (<= todayStr) restricts auto-apply to the
 * removed-page pattern — broadway.com only deletes the page after the final
 * performance, so a genuine hit always has a past close. Future-dated
 * announcements fall through to the Notion review card.
 *
 * @param {string} stored - stored YYYY-MM-DD closingDate
 * @param {string} pressDate - discovered YYYY-MM-DD announced close
 * @param {object} [opts]
 * @param {'title_mismatch'|'empty_schedule'} [opts.kind='empty_schedule']
 * @param {string} [opts.todayStr] - YYYY-MM-DD; required for title_mismatch
 * @returns {boolean} true when it is safe to auto-apply pressDate
 */
function possiblyClosedPressAgreement(stored, pressDate, opts = {}) {
  if (!pressDate) return false;
  const p = new Date(pressDate);
  if (isNaN(p.getTime())) return false;
  if (stored) {
    const s = new Date(stored);
    if (isNaN(s.getTime())) return false;
    if (!(p < s)) return false;
  }
  // Higher bar — press date must also already be in the PAST — whenever the
  // page didn't confirm the show (title_mismatch: could be a slug collision
  // on a running production) or there's no stored close to retract against
  // (no-closingDate shows: the empty page is the only other signal).
  if (opts.kind === 'title_mismatch' || !stored) {
    if (!opts.todayStr) return false;
    const t = new Date(opts.todayStr);
    if (isNaN(t.getTime())) return false;
    return p <= t;
  }
  return true;
}

module.exports = { classifyMissingSchedule, possiblyClosedPressAgreement };
