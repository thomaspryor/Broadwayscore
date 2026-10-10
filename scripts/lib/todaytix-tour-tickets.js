/**
 * TodayTix ticket links for national-tour engagements (BRO-4601 phase 3).
 *
 * TodayTix lists touring engagements in its US metros (Chicago, SF Bay Area,
 * LA + Orange County, Washington DC, Boston) as separate listings, each with
 * its own venue and run dates. A listing belongs to a tour stop when the
 * titles match and the listing opens within MATCH_DAYS of the stop's first
 * date, the stop's state is in the listing's metro and the venue names agree
 * (plausibleStop). The opening date is the strong signal: a local production of the
 * same title (Come From Away at the Marriott Theatre, Chicago) opens on a
 * different day from any tour stop, and listings without a real start date
 * never match.
 *
 * Pure: no I/O. scripts/fetch-tour-tickets.js does the fetching and writing.
 */

const { buildTodayTixUrl } = require('./url-utils');
const { foldDiacritics } = require('./title-match');

/** TodayTix location id → URL path segment. Only US metros where tours play. */
const TOUR_LOCATIONS = {
  3: 'chicago',
  4: 'sf-bay-area',
  5: 'los-angeles',
  6: 'washington-dc',
  7: 'boston',
};

const MATCH_DAYS = 2;
const DAY = 86400000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** "Disney's Beauty and the Beast" / "Beauty and the Beast: The Musical" → "beauty and the beast". */
function normTitle(title) {
  // ™/® first: folding would turn "Club™" into "ClubTM".
  return foldDiacritics(String(title || '').replace(/[™®©]/g, ''))
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/^(disney's|the)\s+/, '')
    .replace(/\b(the broadway musical|the musical|a new musical)\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function daysApart(a, b) {
  return Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY;
}

/** States each TodayTix metro covers (a stop's city ends ", ST"). */
const LOCATION_STATES = { 3: ['IL'], 4: ['CA'], 5: ['CA'], 6: ['DC', 'VA', 'MD'], 7: ['MA'] };

// Words every theatre name shares; what's left must overlap for a match.
const VENUE_STOPWORDS = new Set(['the', 'theatre', 'theater', 'center', 'centre', 'for', 'of', 'and', 'at', 'arts', 'performing', 'hall', 'music', 'opera', 'house', 'auditorium', 'pac', 'civic', 'concert', 'playhouse', 'washington', 'dc', 'san', 'los', 'angeles', 'chicago', 'boston', 'francisco', 'jose']);
function venueName(v) {
  return foldDiacritics(String(v || '')).toLowerCase().replace(/theater\b/g, 'theatre').replace(/[^a-z0-9]+/g, ' ').trim();
}
function venueWords(v) {
  return new Set(foldDiacritics(String(v || '')).toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter(w => w && !VENUE_STOPWORDS.has(w)));
}

/**
 * The listing can be this stop: the stop's state is in the listing's metro,
 * and the venue names agree: they share a distinctive word ("Segerstrom",
 * "CIBC"), or one contains the other when either has none. "Orpheum Theatre" alone can't tell SF from Omaha, which is
 * what the state check is for.
 */
function plausibleStop(l, stop) {
  const st = (String(stop.city).match(/,\s*([A-Z]{2})$/) || [])[1];
  if (!st || !(LOCATION_STATES[l._locationId] || []).includes(st)) return false;
  const a = venueWords(l.venue);
  const b = venueWords(stop.venue);
  if (a.size && b.size) return [...a].some(w => b.has(w));
  // A generic name ("Center for the Performing Arts", San Jose) has no word
  // to compare: one full name must then contain the other.
  const x = venueName(l.venue);
  const y = venueName(stop.venue);
  return Boolean(x && y) && (x.includes(y) || y.includes(x));
}

/**
 * Ticket links per tour, keyed by tour id:
 *   { [tourId]: [{ city, start, url, onSale, todaytixId, locationId }] }
 * in the tour's stop order. A stop with no matching listing has no entry.
 *
 * Each listing goes to the one (tour, stop) it opens closest to; a tie
 * between two (two companies of one title, or two stops a day apart in one
 * metro) drops the listing rather than guess (code review).
 *
 * @param listings TodayTix /shows rows, each with `_locationId` added.
 * @param tours    [{ id, title }] for the tours to match.
 * @param schedules data/tour-schedules.json `tours` map.
 */
function matchTourTickets(listings, tours, schedules) {
  const toursByTitle = new Map();
  for (const t of tours) {
    if (!schedules[t.id]?.stops) continue;
    const key = normTitle(t.title);
    if (!toursByTitle.has(key)) toursByTitle.set(key, []);
    toursByTitle.get(key).push(t);
  }
  const chosen = new Map(); // `${tourId}|${stopIdx}` -> listing
  for (const l of listings) {
    if (!TOUR_LOCATIONS[l._locationId] || !l.slug || !ISO_DATE.test(String(l.startDate))) continue;
    const pairs = [];
    for (const t of toursByTitle.get(normTitle(l.displayName || l.name)) || []) {
      schedules[t.id].stops.forEach((stop, i) => {
        const gap = daysApart(l.startDate, stop.start);
        if (gap <= MATCH_DAYS && plausibleStop(l, stop)) pairs.push({ key: `${t.id}|${i}`, gap });
      });
    }
    if (!pairs.length) continue;
    const best = Math.min(...pairs.map(p => p.gap));
    const top = pairs.filter(p => p.gap === best);
    if (top.length > 1) continue;
    const prev = chosen.get(top[0].key);
    // Two listings for one stop (a venue relisted under a new name): the
    // on-sale one is the one a buyer can use.
    if (!prev || (!prev.areRegularTicketsAvailable && l.areRegularTicketsAvailable)) chosen.set(top[0].key, l);
  }
  const out = {};
  for (const t of tours) {
    const links = [];
    (schedules[t.id]?.stops || []).forEach((stop, i) => {
      const l = chosen.get(`${t.id}|${i}`);
      if (!l) return;
      links.push({
        city: stop.city,
        start: stop.start,
        url: buildTodayTixUrl(l.id, l.slug, TOUR_LOCATIONS[l._locationId]),
        onSale: l.areRegularTicketsAvailable === true,
        todaytixId: l.id,
        locationId: l._locationId,
      });
    });
    if (links.length) out[t.id] = links;
  }
  return out;
}

/**
 * Merge a fresh match into the previous file. Links from a location whose
 * fetch failed this run are kept from the previous file, so one TodayTix
 * outage doesn't strip every Chicago button for a day.
 */
function mergeTickets(prev, fresh, failedLocations) {
  const failed = new Set(failedLocations.map(Number));
  const out = {};
  const ids = new Set([...Object.keys(prev || {}), ...Object.keys(fresh)]);
  for (const id of ids) {
    const kept = (prev?.[id] || []).filter(l => failed.has(Number(l.locationId)));
    const merged = [...(fresh[id] || []), ...kept.filter(k => !(fresh[id] || []).some(f => f.city === k.city && f.start === k.start))];
    merged.sort((a, b) => a.start.localeCompare(b.start));
    if (merged.length) out[id] = merged;
  }
  return out;
}

module.exports = { TOUR_LOCATIONS, MATCH_DAYS, normTitle, matchTourTickets, mergeTickets };
