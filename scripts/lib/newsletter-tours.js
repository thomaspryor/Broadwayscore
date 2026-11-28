'use strict';

/**
 * newsletter-tours.js — picks the national tours for the weekly NYC email's
 * "Newly Scored Tours" section (BRO-4757, owner 2026-10-05: "add to email when a
 * tour gets enough reviews").
 *
 * "Got enough reviews" = the tour's Critic Score went public on the site.
 * data/audit/score-public-since.json stamps the first time a show's slim file
 * carries `cs` (generate-mobile-show-details.js sets it only past the tour
 * minimum, the same gate as isTourListed in src/lib/data-core.ts), and the
 * stamp is append-only, so each tour is picked in exactly one week.
 */

const FRESH_DAYS = 60;

function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * @param {Array<{id:string, category?:string, status?:string}>} shows
 * @param {Record<string,string>} stamps  {showId: ISO timestamp} from score-public-since.json
 * @param {string} weekStart  YYYY-MM-DD (Monday of the issue week)
 * @param {string} weekEnd    YYYY-MM-DD, inclusive
 * @param {object} [opts]
 * @param {Array<{showId:string, assignedScore?:number|null, publishDate?:string|null}>} [opts.reviews]
 *   when given, a tour qualifies only if its newest scored review is at most
 *   FRESH_DAYS old at weekEnd. A data catch-up can stamp a years-old tour
 *   (wicked-tour-2021's newest review is from 2021); that is not news.
 * @param {Set<string>} [opts.excludeIds]  shows a recent issue already featured
 * @returns the tours whose score went public in the window; closed tours are
 *   left out (nothing to buy a ticket for). The window opens the day before
 *   weekStart: the email is drafted Saturday and refreshed Sunday midday, so a
 *   Sunday-evening stamp would otherwise fall between two issues. excludeIds
 *   keeps a Sunday-morning stamp from showing in both.
 */
function pickNewlyScoredTours(shows, stamps, weekStart, weekEnd, opts = {}) {
  const from = addDays(weekStart, -1);
  const minFresh = addDays(weekEnd, -FRESH_DAYS);
  let newest = null;
  if (Array.isArray(opts.reviews)) {
    newest = new Map();
    for (const r of opts.reviews) {
      if (!r || r.assignedScore == null || typeof r.publishDate !== 'string') continue;
      const d = r.publishDate.slice(0, 10);
      if (!newest.has(r.showId) || d > newest.get(r.showId)) newest.set(r.showId, d);
    }
  }
  return (shows || []).filter(s => {
    if (!s || s.category !== 'tour' || s.status === 'closed') return false;
    if (opts.excludeIds && opts.excludeIds.has(s.id)) return false;
    const day = typeof stamps?.[s.id] === 'string' ? stamps[s.id].slice(0, 10) : null;
    if (!day || day < from || day > weekEnd) return false;
    return !newest || (newest.get(s.id) || '') >= minFresh;
  });
}

/**
 * Where the tour plays: "Now in Chicago" during an engagement, "Next: Denver"
 * between engagements, null without a schedule. Mirrors getTourNowNext() in
 * src/lib/tour-schedule.ts (TypeScript, so not importable here).
 * @param {Array<{city:string, start:string, end:string}>} stops  date-ordered
 * @param {string} today  YYYY-MM-DD
 */
function tourWhereLine(stops, today) {
  const list = Array.isArray(stops) ? stops : [];
  const short = (city) => String(city).replace(/,\s*[A-Z]{2}$/, '');
  const now = list.find(s => s.start <= today && today <= s.end);
  if (now) return `Now in ${short(now.city)}`;
  const next = list.find(s => s.start > today);
  return next ? `Next: ${short(next.city)}` : null;
}

module.exports = { pickNewlyScoredTours, tourWhereLine, FRESH_DAYS };
