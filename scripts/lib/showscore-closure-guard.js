/**
 * showscore-closure-guard.js — decide whether a ShowScore "Closed" reading may
 * close one of our open/previews shows.
 *
 * BRO-4617: slam-frank-off-broadway-2026 (opened 2026-10-04) was closed on its
 * opening night because data/show-score-urls.json pointed at the 2025 run's
 * ShowScore page (Closed) and the stored todaytixId was the old run's id, so
 * the TodayTix-active guard did not fire either. A just-opened or future-dated
 * production, or one that starts after the page's run ended, is never closed
 * by ShowScore alone.
 *
 * Used by update-show-status.js (ShowScore refresh) and
 * enrich-ob-dates-from-showscore.js.
 */

const RECENT_OPENING_DAYS = 30;

function daysBetween(fromStr, toStr) {
  return Math.round((Date.parse(toStr) - Date.parse(fromStr)) / 86400000);
}

/**
 * @param {object} show shows.json entry
 * @param {object} _ssData parsed ShowScore page (unused: a Closed page carries no run dates)
 * @param {string} todayStr YYYY-MM-DD
 * @returns {{trust: boolean, reason: string|null}}
 */
function shouldTrustShowScoreClosed(show, _ssData, todayStr) {
  const opening = show && show.openingDate;
  if (opening && /^\d{4}-\d{2}-\d{2}$/.test(opening)) {
    const age = daysBetween(opening, todayStr);
    if (age < RECENT_OPENING_DAYS) {
      return { trust: false, reason: `opened ${opening} (within ${RECENT_OPENING_DAYS}d or future), ShowScore page is likely a prior production` };
    }
  }
  const previews = show && show.previewsStartDate;
  if (previews && /^\d{4}-\d{2}-\d{2}$/.test(previews) && daysBetween(previews, todayStr) < RECENT_OPENING_DAYS) {
    return { trust: false, reason: `previews started ${previews} (within ${RECENT_OPENING_DAYS}d or future)` };
  }
  if (todayTixIdMismatch(show)) {
    return { trust: false, reason: `todaytixId ${show.todaytixId} disagrees with ticketLinks TodayTix id, so the TodayTix-active check is unreliable` };
  }
  return { trust: true, reason: null };
}

/** TodayTix id embedded in a show's ticketLinks, or null. */
function todayTixIdFromTicketLinks(show) {
  const links = (show && show.ticketLinks) || [];
  for (const l of Array.isArray(links) ? links : []) {
    const url = typeof l === 'string' ? l : l && l.url;
    const m = url && String(url).match(/todaytix\.com\/.*?shows?\/(\d+)/i);
    if (m) return m[1];
  }
  return null;
}

/** True when the stored todaytixId disagrees with the ticketLinks TodayTix id. */
function todayTixIdMismatch(show) {
  const linked = todayTixIdFromTicketLinks(show);
  return !!(linked && show.todaytixId != null && String(show.todaytixId) !== linked);
}

module.exports = { shouldTrustShowScoreClosed, todayTixIdFromTicketLinks, todayTixIdMismatch, RECENT_OPENING_DAYS };
