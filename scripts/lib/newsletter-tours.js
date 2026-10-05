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

/**
 * @param {Array<{id:string, category?:string, status?:string}>} shows
 * @param {Record<string,string>} stamps  {showId: ISO timestamp} from score-public-since.json
 * @param {string} weekStart  YYYY-MM-DD, inclusive
 * @param {string} weekEnd    YYYY-MM-DD, inclusive
 * @returns the tours whose score went public in the week; closed tours are left
 *   out (nothing to buy a ticket for).
 */
function pickNewlyScoredTours(shows, stamps, weekStart, weekEnd) {
  return (shows || []).filter(s => {
    if (!s || s.category !== 'tour' || s.status === 'closed') return false;
    const day = typeof stamps?.[s.id] === 'string' ? stamps[s.id].slice(0, 10) : null;
    return !!day && day >= weekStart && day <= weekEnd;
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

module.exports = { pickNewlyScoredTours, tourWhereLine };
