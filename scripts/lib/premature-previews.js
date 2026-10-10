'use strict';

/**
 * A show marked status=previews before its first performance.
 *
 * "previews" means performances have begun. Two writers set it without that
 * evidence (BRO-4377, 2026-09-29: 8 shows, all months from their first
 * performance, rendered "In Previews" on the site):
 *   - venue-page adds store the venue calendar's run start as openingDate
 *     (SoHo Playhouse "KEVIN!!!!! | December 5 - January 3" landed as
 *     openingDate 2026-12-05, status previews, in September).
 *   - discover-new-shows' ShowScore branch read "Opens Oct 03" as press night
 *     and set previews; for PHYL that date was the first preview (opening
 *     night is Oct 22).
 *
 * Returns 'upcoming' when the show has not started:
 *   - previewsStartDate is set and still in the future (any source), or
 *   - there is no previewsStartDate and openingDate is in the future and came
 *     from a listing source whose date is a run start rather than a
 *     confirmed press night (venue-page*, showscore).
 * update-show-status.js Check 2b then moves it on once the date arrives.
 */

const RUN_START_SOURCES = [/^venue-page/, /^showscore$/];
const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {object} show - shows.json entry
 * @param {string} todayStr - YYYY-MM-DD
 * @returns {{to: 'upcoming', reason: string}|null}
 */
function decidePrematurePreviews(show, todayStr) {
  if (!show || show.status !== 'previews') return null;
  const prev = show.previewsStartDate;
  if (prev && ISO.test(prev)) {
    return prev > todayStr
      ? { to: 'upcoming', reason: `previewsStartDate ${prev} has not arrived` }
      : null;
  }
  const open = show.openingDate;
  if (!open || !ISO.test(open) || open <= todayStr) return null;
  const src = show.openingDateSource || '';
  if (!RUN_START_SOURCES.some(re => re.test(src))) return null;
  return {
    to: 'upcoming',
    reason: `no previewsStartDate and ${src} date ${open} (a run start, not a confirmed press night) has not arrived`,
  };
}

module.exports = { decidePrematurePreviews };
