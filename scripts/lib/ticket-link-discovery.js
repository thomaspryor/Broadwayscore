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
//
// `region` marks hosts that only ever sell in ONE market: ticketmaster.com is
// the US storefront and ticketmaster.co.uk the UK one, and a title that runs on
// both sides of the Atlantic has a live event page on each. Without this, SERP
// title-matching alone happily attached the US "A Christmas Carol (NY)"
// Ticketmaster artist page to the Old Vic's West End production (shipped by
// task #956, reddened the trunk 20/20 runs until task #1002). Omit `region` for
// genuinely multi-market hosts (todaytix.com serves /nyc and /london from one
// domain; eventbrite/universe/showclix are global).
const TICKETING_PLATFORMS = [
  { host: 'todaytix.com', platform: 'TodayTix' },
  { host: 'ticketmaster.com', platform: 'Ticketmaster', region: 'us' },
  { host: 'ticketmaster.co.uk', platform: 'Ticketmaster', region: 'uk' },
  { host: 'telecharge.com', platform: 'Telecharge', region: 'us' },
  { host: 'ovationtix.com', platform: 'OvationTix' },
  { host: 'eventbrite.com', platform: 'Eventbrite' },
  { host: 'smarttix.com', platform: 'SmartTix', region: 'us' },
  { host: 'ticketcentral.com', platform: 'Ticket Central', region: 'us' },
  { host: 'universe.com', platform: 'Universe' },
  { host: 'showclix.com', platform: 'ShowClix' },
  { host: 'ticketleap.com', platform: 'TicketLeap' },
  { host: 'seetickets.com', platform: 'See Tickets' },
  { host: 'ticketsource.co.uk', platform: 'TicketSource', region: 'uk' },
];

// UK markets/categories in shows.json. Everything else (broadway,
// off-broadway, regional US) is treated as 'us'.
const UK_MARKETS = new Set(['west-end', 'off-west-end']);

/** 'uk' | 'us' for a shows.json entry — market first, category as fallback. */
function showRegion(show) {
  const market = String((show && show.market) || '').toLowerCase();
  const category = String((show && show.category) || '').toLowerCase();
  return UK_MARKETS.has(market) || UK_MARKETS.has(category) ? 'uk' : 'us';
}

/** Region-locked host for a URL, or null when the host serves both markets. */
function urlRegion(url) {
  const host = hostOf(url);
  if (!host) return null;
  const platform = TICKETING_PLATFORMS.find((p) => hostMatches(host, p.host));
  return (platform && platform.region) || null;
}

/**
 * True when a ticket URL is on a storefront that cannot sell this show's
 * market — a West End show on ticketmaster.com, a Broadway show on
 * ticketmaster.co.uk. Pure; exported so both the SERP picker and the
 * corpus-wide CI assertion (scripts/tests/tm-gap-links.test.mjs) share one
 * definition rather than re-deriving it.
 */
function isRegionMismatch(url, show) {
  const linkRegion = urlRegion(url);
  if (!linkRegion) return false;
  return linkRegion !== showRegion(show);
}

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

// Words that must never carry a match on their own ("The Guilty" must not
// match "The Book of Mormon" via "the").
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'in', 'on', 'at', 'for', 'with', 'to',
  'its', 'his', 'her', 'my', 'our', 'your', 'is', 'or',
]);

// SERP-title boilerplate that doesn't indicate a different production.
const GENERIC_SERP_WORDS = new Set([
  'tickets', 'ticket', 'buy', 'official', 'site', 'show', 'shows', 'event',
  'events', 'broadway', 'off', 'west', 'end', 'new', 'york', 'nyc', 'london',
  'theatre', 'theater', 'playhouse', 'musical', 'play', 'todaytix',
  'ticketmaster', 'ovationtix', 'eventbrite', 'telecharge', 'stubhub',
  'dates', 'schedule', 'tour', 'presents', 'production',
  // Run-date boilerplate ("DUKES | July 8 - August 22")
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december',
]);

// All-digit tokens (day numbers, years) are date boilerplate, never content.
function isGenericToken(w) {
  return GENERIC_SERP_WORDS.has(w) || /^\d+$/.test(w);
}

function significantWords(text) {
  return foldTitle(text).split(' ').filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

/**
 * True when a SERP result title plausibly refers to the show. Word-boundary
 * matching on diacritic-folded, stopword-filtered words. Short titles (1-2
 * significant words) must match ALL words; longer titles at least half.
 * Single-word titles additionally reject results whose title carries 2+
 * unexplained content words ("Mercury: A Freddie Mercury Tribute" must not
 * match the play "Mercury"). Subtitle after ":" is tried as a fallback
 * primary title (e.g. "Iceboy!: Or The Completely Untrue Story…").
 */
function titleMatches(resultTitle, showTitle, venue = '') {
  const resultWords = new Set(foldTitle(resultTitle).split(' ').filter(Boolean));
  if (resultWords.size === 0) return false;
  // Strip venue-disambiguation parentheticals the catalog appends, e.g.
  // "Milk and Honey (AMT Theater)" — the SERP result won't repeat them.
  const bare = String(showTitle || '').replace(/\([^)]*\)\s*$/, '');
  const candidates = [bare];
  if (bare.includes(':')) candidates.push(bare.split(':')[0]);
  return candidates.some((candidate) => {
    const words = significantWords(candidate);
    if (words.length === 0) return false;
    const hits = words.filter((w) => resultWords.has(w)).length;
    const needed = words.length <= 2 ? words.length : Math.ceil(words.length * 0.5);
    if (hits < needed) return false;
    if (words.length === 1) {
      // One-word titles collide easily — reject results with 2+ content words
      // not explained by the title, the venue, or generic ticket boilerplate.
      const explained = new Set([...words, ...significantWords(venue)]);
      const unexpected = [...resultWords].filter(
        (w) => w.length > 1 && !STOPWORDS.has(w) && !isGenericToken(w) && !explained.has(w)
      );
      if (unexpected.length >= 2) return false;
    }
    return true;
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
    // A same-title production runs on both sides of the Atlantic more often
    // than not at Christmas; title-matching alone cannot tell the storefronts
    // apart. Reject before the title check so a US artist page can never be
    // attached to a West End show (task #1002).
    if (isRegionMismatch(url, show)) continue;
    if (!titleMatches(r.title || '', show.title, show.venue || '')) continue;
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
    ? 'london'
    : show.category === 'broadway' ? 'broadway new york' : 'off broadway new york';
  return `"${bareTitle}" ${region} tickets`;
}

module.exports = {
  pickTicketUrl,
  platformForUrl,
  titleMatches,
  buildTicketQuery,
  foldTitle,
  isRegionMismatch,
  showRegion,
  urlRegion,
  TICKETING_PLATFORMS,
  VENUE_SITES,
  RESALE_HOSTS,
};
