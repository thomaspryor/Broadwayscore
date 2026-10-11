/**
 * Pure decision logic for auto-close-expired-shows.js (BRO-5071).
 * Closing dates are calendar dates in the show's market timezone
 * (ET for Broadway/OB, London for WE/OWE); UTC comparison can close a day early.
 */
function getMarketDate(category, now = new Date()) {
  const tz = (category === 'west-end' || category === 'off-west-end')
    ? 'Europe/London'
    : 'America/New_York';
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
}

/** Returns [{id, closingDate, market}] for open shows past closingDate; mutates status only when apply=true. */
function closeExpiredShows(shows, { apply = false, now = new Date() } = {}) {
  const closedList = [];
  for (const show of Object.values(shows)) {
    const today = getMarketDate(show.category, now);
    if (show.status === 'open' && show.closingDate && show.closingDate < today) {
      closedList.push({ id: show.id, closingDate: show.closingDate, market: show.market || 'broadway' });
      if (apply) {
        show.status = 'closed';
        delete show._staleMissingSince; // same bookkeeping as update-show-status.js close path
      }
    }
  }
  return closedList;
}

module.exports = { getMarketDate, closeExpiredShows };
