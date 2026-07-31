/**
 * Pure decision logic for fallback ticket-link discovery (SERP → ticketLinks).
 *
 * Why this exists: enrich-todaytix-data.js only fills shows listed on TodayTix,
 * and enrich-ticket-platform-links.js only knows the 40 Broadway houses. Every
 * open Off-Broadway / Off-West End / regional show absent from TodayTix ended
 * up with ticketLinks: [] forever (29 shows on 2026-07-31). This module holds
 * the testable acceptance predicate; enrich-fallback-ticket-links.js does I/O.
 */

// Known ticketing platforms — host suffix → display platform name.
// Order matters: first match wins when scanning SERP results, so put
// primary-sale platforms before anything resale-adjacent.
const TICKETING_PLATFORMS = [
  { host: 'todaytix.com', platform: 'TodayTix' },
  { host: 'ticketmaster.com', platform: 'Ticketmaster' },
  { host: 'ticketmaster.co.uk', platform: 'Ticketmaster' },
  { host: 'telecharge.com', platform: 'Telecharge' },
  { host: 'ovationtix.com', platform: 'OvationTix' },
  { host: 'eventbrite.com', platform: 'Eventbrite' },
  { host: 'smarttix.com', platform: 'SmartTix' },
  { host: 'ticketcentral.com', platform: 'Ticket Central' },
  { host: 'universe.com', platform: 'Universe' },
  { host: 'showclix.com', platform: 'ShowClix' },
  { host: 'ticketleap.com', platform: 'TicketLeap' },
  { host: 'seetickets.com', platform: 'See Tickets' },
  { host: 'ticketsource.co.uk', platform: 'TicketSource' },
];

// Institutional venues that sell first-party from their own domain. Extend as
// gaps surface (the freshness digest's missing_tickets line names the shows).
const VENUE_SITES = [
  'bam.org',
  'sohoplayhouse.com',
  'marylebonetheatre.com',
  'donmarwarehouse.com',
  'arenastage.org',
  'goodmantheatre.org',
  'lajollaplayhouse.org',
  'nytw.org',
  'publictheater.org',
  'atlantictheater.org',
  'vineyardtheatre.org',
  'mcctheater.org',
  'signaturetheatre.org',
  '59e59.org',
  'newworldstages.com',
  'bfany.org', // Building for the Arts NY — operates Theatre Row
  'amtheater.org',
  'lct.org',
  'roundabouttheatre.org',
  '2st.com',
  'classicstage.org',
  'irishrep.org',
  'thenewgroup.org',
  'lunastage.org',
  'housingworks.org',
];

// SERP result paths that are listings/search hubs, never a buyable show page.
const LISTING_PATH_FRAGMENTS = ['/search', '/category', '/discover', '/shows?', '/whats-on?'];

// Resale-only marketplaces — never auto-link these.
const RESALE_HOSTS = ['stubhub.com', 'seatgeek.com', 'vividseats.com', 'viagogo.com', 'ticketnetwork.com'];

/**
 * Fold diacritics + lowercase + strip punctuation. Mirrors the lesson from the
 * Les Misérables matching bugs: "Misérables" must match "Miserables".
 */
function foldTitle(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

function hostMatches(host, allowedHost) {
  return host === allowedHost || host.endsWith('.' + allowedHost);
}

/** Platform display name for an allowlisted host, or null if not allowlisted. */
function platformForUrl(url, { title } = {}) {
  const host = hostOf(url);
  if (!host) return null;
  if (RESALE_HOSTS.some((h) => hostMatches(host, h))) return null;
  const platform = TICKETING_PLATFORMS.find((p) => hostMatches(host, p.host));
  if (platform) return platform.platform;
  if (VENUE_SITES.some((v) => hostMatches(host, v))) return 'Venue Box Office';
  return null;
}

/**
 * True when a SERP result title plausibly refers to the show. Requires at
 * least half of the show title's significant words (diacritic-folded) to
 * appear in the result title. Subtitle after ":" is tried as a fallback
 * primary title (e.g. "Iceboy!: Or The Completely Untrue Story…").
 */
function titleMatches(resultTitle, showTitle) {
  const folded = foldTitle(resultTitle);
  if (!folded) return false;
  // Strip venue-disambiguation parentheticals the catalog appends, e.g.
  // "Milk and Honey (AMT Theater)" — the SERP result won't repeat them.
  const bare = String(showTitle || '').replace(/\([^)]*\)\s*$/, '');
  const candidates = [bare];
  if (bare.includes(':')) candidates.push(bare.split(':')[0]);
  return candidates.some((candidate) => {
    const words = foldTitle(candidate).split(' ').filter((w) => w.length > 2);
    if (words.length === 0) return false;
    const hit = words.filter((w) => folded.includes(w)).length;
    return hit >= Math.ceil(words.length * 0.5);
  });
}

/**
 * Pick the best ticket URL from SERP results for a show.
 * Returns { url, platform } or null. Pure — no network.
 */
function pickTicketUrl(results, show) {
  if (!Array.isArray(results)) return null;
  for (const r of results || []) {
    const url = r && (r.url || r.link);
    if (!url) continue;
    if (LISTING_PATH_FRAGMENTS.some((f) => url.includes(f))) continue;
    const platform = platformForUrl(url);
    if (!platform) continue;
    if (!titleMatches(r.title || '', show.title)) continue;
    return { url: url.replace(/^http:/, 'https:'), platform };
  }
  return null;
}

// Neighborhood placeholders used as "venue" for small OB houses — useless as
// a SERP venue hint (see shows.json Greenwich V / Midtown W entries).
const NEIGHBORHOOD_VENUES = new Set([
  'midtown w', 'midtown e', 'greenwich v', 'soho/tribeca', 'west village',
  'brooklyn', 'harlem', 'lower east side', 'upper west side', 'upper east side',
]);

/** Build the SERP query for a show — venue-specific when the venue is real. */
function buildTicketQuery(show) {
  const bareTitle = String(show.title || '').replace(/\([^)]*\)\s*$/, '').trim();
  const venue = String(show.venue || '').trim();
  const isNeighborhood = NEIGHBORHOOD_VENUES.has(venue.toLowerCase());
  if (venue && !isNeighborhood) return `"${bareTitle}" ${venue} tickets`;
  const region = show.category === 'off-west-end' || show.category === 'west-end'
    ? 'london' : 'off broadway new york';
  return `"${bareTitle}" ${region} tickets`;
}

module.exports = {
  pickTicketUrl,
  platformForUrl,
  titleMatches,
  buildTicketQuery,
  foldTitle,
  TICKETING_PLATFORMS,
  VENUE_SITES,
  RESALE_HOSTS,
};
