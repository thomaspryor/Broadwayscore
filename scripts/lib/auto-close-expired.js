/**
 * Pure decision logic for auto-close-expired-shows.js (BRO-5071).
 * Closing dates are calendar dates in the show's market timezone
 * (ET for Broadway/OB, London for WE/OWE); UTC comparison can close a day early.
 */
const { isUkRegionalVenue } = require('./market-label');

function getMarketDate(category, now = new Date()) {
  const tz = (category === 'west-end' || category === 'off-west-end')
    ? 'Europe/London'
    : 'America/New_York';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
}

// BRO-6725: UK regional rows seeded from a Guardian review/census have an opening date but
// almost never a closing date, so the closingDate rule below never fired and stale runs sat
// in "On Stage Now". With no closingDate, close once the run is older than this window.
// Most UK regional runs are 2-8 weeks and repertory seasons run longer, so 90 days; a sourced closingDate always wins over this guess.
const UK_REGIONAL_NO_CLOSE_DAYS = 90;

function isStaleUkRegionalRun(show, today) {
  if (show.category !== 'regional' || show.closingDate || !show.openingDate) return false;
  if (!isUkRegionalVenue(show.venue)) return false;
  const age = (Date.parse(today) - Date.parse(show.openingDate)) / 86400000;
  return age > UK_REGIONAL_NO_CLOSE_DAYS;
}

/** Returns [{id, closingDate, market}] for open (or previews, BRO-5489) shows past closingDate; mutates status only when apply=true. */
function closeExpiredShows(shows, { apply = false, now = new Date() } = {}) {
  const closedList = [];
  for (const show of Object.values(shows)) {
    const today = getMarketDate(show.category, now);
    const expired = show.closingDate && show.closingDate < today;
    // BRO-5489: a run that ends inside previews (a two-night engagement, a run
    // cancelled before press night) has no openingDate, so it never became 'open'
    // and sat in 'previews' past its closingDate: Buffy Revamped (Lyric, closed
    // 2026-10-19) and four more on 2026-11-03, each still read as an in-window
    // show by the opening-window review-gap alert. A sourced closingDate closes it.
    const active = show.status === 'open' || (show.status === 'previews' && expired);
    if (active && (expired || isStaleUkRegionalRun(show, today))) {
      closedList.push({ id: show.id, closingDate: show.closingDate || null, market: show.market || 'broadway' });
      if (apply) {
        show.status = 'closed';
        delete show._staleMissingSince; // same bookkeeping as update-show-status.js close path
      }
    }
  }
  return closedList;
}

module.exports = { getMarketDate, closeExpiredShows, isStaleUkRegionalRun, UK_REGIONAL_NO_CLOSE_DAYS };
