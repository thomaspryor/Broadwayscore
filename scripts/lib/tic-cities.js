'use strict';

/**
 * Per-city config for the Theatre Limelight review sites (theatreinchicago.com,
 * theatreindc.com). BRO-6518 built the Chicago pickup; BRO-6771 generalizes it
 * so a city is a config entry here, not a copy of the scripts. Pure data.
 *
 *   key              --city= value on the CLIs
 *   base             site origin (listing, reviews and detail pages hang off it)
 *   host             hostname used to recognise our own evidenceUrls
 *   discoverySource  shows.json discoverySource (also in src/lib/local-market.ts)
 *   metro            data/venue-metros.json place slug written to show.city
 *   files            audit memory files, kept per city so the two never mix
 *   since            optional: only productions that opened on/after this date,
 *                    or are still open, are staged (short-history launch)
 */

const CITIES = {
  chicago: {
    key: 'chicago',
    label: 'Chicago',
    base: 'https://www.theatreinchicago.com',
    host: 'theatreinchicago.com',
    discoverySource: 'theatreinchicago',
    metro: 'chicago-il',
    files: {
      seen: 'data/audit/tic-daily-seen.json',
      added: 'data/audit/tic-daily-added.json',
    },
    since: null,
    // null = no extra rules (Chicago keeps its original tour-house and IL/IN city logic in tic-stage.js).
    tourHouses: null,
    venueCities: null,
    requireMetro: false,
  },
  dc: {
    key: 'dc',
    label: 'Washington DC',
    base: 'https://www.theatreindc.com',
    host: 'theatreindc.com',
    discoverySource: 'theatreindc',
    metro: 'washington-dc',
    files: {
      seen: 'data/audit/tic-daily-seen-dc.json',
      added: 'data/audit/tic-daily-added-dc.json',
    },
    since: '2026-05-01',
    // Touring houses: national tours are tracked in data/tour-schedules.json, not as local productions.
    tourHouses: [
      /kennedy center/i, /national theat/i, /warner theat/i, /hippodrome/i, /lyric.*baltimore/i,
      /capital one arena/i, /dar constitution hall/i, /anthem/i, /strathmore/i, /music center/i,
    ],
    // theatreindc addresses end with the bare city ("4200 Campbell Avenue Arlington"): [city, state].
    // Only the DC metro is listed on purpose. Baltimore, Columbia, Annapolis and Frederick appear on
    // the site but are other metros; they fall through to a null venueLine and are rejected.
    venueCities: [
      ['Washington', 'DC'],
      ['Arlington', 'VA'], ['Alexandria', 'VA'], ['Falls Church', 'VA'], ['Fairfax', 'VA'], ['Vienna', 'VA'],
      ['Reston', 'VA'], ['Herndon', 'VA'], ['McLean', 'VA'], ['Springfield', 'VA'], ['Woodbridge', 'VA'],
      ['Bethesda', 'MD'], ['North Bethesda', 'MD'], ['Chevy Chase', 'MD'], ['Rockville', 'MD'], ['Silver Spring', 'MD'],
      ['Takoma Park', 'MD'], ['College Park', 'MD'], ['Hyattsville', 'MD'], ['Mount Rainier', 'MD'], ['Olney', 'MD'],
      ['Gaithersburg', 'MD'], ['Germantown', 'MD'], ['Greenbelt', 'MD'], ['Laurel', 'MD'], ['Wheaton', 'MD'],
      ['Kensington', 'MD'], ['Glen Echo', 'MD'], ['Bowie', 'MD'], ['Upper Marlboro', 'MD'], ['Largo', 'MD'], ['Brentwood', 'MD'],
    ],
    requireMetro: true,
  },
};

function getCity(key) {
  const c = CITIES[key || 'chicago'];
  if (!c) throw new Error(`unknown city "${key}" (known: ${Object.keys(CITIES).join(', ')})`);
  return c;
}

/** The city config whose host appears in a URL, or null. */
function cityForUrl(url) {
  const u = String(url || '');
  return Object.values(CITIES).find((c) => u.includes(c.host)) || null;
}

module.exports = { CITIES, getCity, cityForUrl };
