/**
 * Pure decision logic for fallback ticket-link discovery (SERP → ticketLinks).
 *
 * Why this exists: enrich-todaytix-data.js only fills shows listed on TodayTix,
 * and enrich-ticket-platform-links.js only knows the 40 Broadway houses. Every
 * open Off-Broadway / Off-West End / regional show absent from TodayTix ended
 * up with ticketLinks: [] forever (29 shows on 2026-07-31). This module holds
 * the testable acceptance predicate; enrich-fallback-ticket-links.js does I/O.
 */

// Ticketing platforms with verified primary sales: host suffix to display name.
// BRO-3699: first-party sources for every entry are recorded in
// docs/ticketing-platforms-audit-bro-3699.md. Verify new hosts the same way.
// Ticketmaster and See Tickets also offer resale; allowlisting a platform
// does not establish the inventory type of every ticket on its event pages.
// Removed smarttix.com (utility software: https://smarttix.com/about/) and
// ticketcentral.com (default hosting page: https://ticketcentral.com/),
// neither of which currently demonstrates theatre ticket sales.
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
  { host: 'universe.com', platform: 'Universe' },
  { host: 'showclix.com', platform: 'ShowClix' },
  { host: 'ticketleap.com', platform: 'TicketLeap' },
  { host: 'seetickets.com', platform: 'See Tickets' },
  { host: 'ticketsource.co.uk', platform: 'TicketSource', region: 'uk' },
];

// Known-region markets/categories in shows.json. Deliberately NOT exhaustive:
// `regional` covers both US regional houses (Arena Stage, La Jolla) and any
// future UK regional (Chichester, Manchester), so it stays unknown rather than
// defaulting to 'us' and falsely rejecting a legitimate ticketsource.co.uk
// link. Same for a market this list has not learned yet.
const UK_MARKETS = new Set(['west-end', 'off-west-end']);
const US_MARKETS = new Set(['broadway', 'off-broadway']);

/**
 * 'uk' | 'us' | null for a shows.json entry — market first, category as
 * fallback. null means "not confidently known", which imposes no constraint.
 */
function showRegion(show) {
  const market = String((show && show.market) || '').toLowerCase();
  const category = String((show && show.category) || '').toLowerCase();
  // market genuinely wins: category is consulted only when market says nothing,
  // so a corrupt {market:'broadway', category:'west-end'} resolves to 'us'
  // rather than letting the weaker field override the stronger one.
  if (UK_MARKETS.has(market)) return 'uk';
  if (US_MARKETS.has(market)) return 'us';
  if (UK_MARKETS.has(category)) return 'uk';
  if (US_MARKETS.has(category)) return 'us';
  return null;
}

// TodayTix serves every market from one domain but partitions by the first
// path segment (/london/shows/…, /nyc/shows/…). Without this a /nyc link on a
// West End show passes the host check untouched — the same failure shape as the
// Ticketmaster one, just hidden behind a multi-market host.
const TODAYTIX_UK_CITIES = new Set(['london']);

// TodayTix US city segments seen in the corpus. Kept as an allow-list so an
// unfamiliar segment reads as "unknown" (no constraint) instead of "US".
const TODAYTIX_US_CITIES = new Set([
  'nyc', 'chicago', 'sf', 'la', 'boston', 'dc', 'philadelphia', 'seattle',
  'houston', 'atlanta', 'dallas', 'san-diego', 'denver', 'nj',
]);

/**
 * Region a URL is locked to, or null when it can serve either market.
 * Host-level first, then per-platform path partitions.
 */
function urlRegion(url) {
  const host = hostOf(url);
  if (!host) return null;
  const platform = TICKETING_PLATFORMS.find((p) => hostMatches(host, p.host));
  if (platform && platform.region) return platform.region;
  if (platform && platform.host === 'todaytix.com') {
    const city = ((String(url).match(/todaytix\.com\/([a-z-]+)\//i) || [])[1] || '').toLowerCase();
    if (TODAYTIX_UK_CITIES.has(city)) return 'uk';
    if (TODAYTIX_US_CITIES.has(city)) return 'us';
    return null; // unrecognised segment → unknown, never a guess
  }
  return null;
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
  const region = showRegion(show);
  // Either side unknown → no constraint. Only a positive us-vs-uk conflict
  // rejects, so the guard can never refuse a link it merely fails to classify.
  if (!linkRegion || !region) return false;
  return linkRegion !== region;
}

// BRO-5455: regional first-party booking sites missing from the fallback
// allowlist. Scope these to their venue so a same-title production elsewhere
// cannot acquire a regional house's booking page.
const REGIONAL_VENUE_SITES = [
  { host: 'goodspeed.org', venue: 'goodspeed' },
  { host: 'theoldglobe.org', venue: 'old globe' },
  { host: 'northlight.org', venue: 'northlight' },
  { host: 'steppenwolf.org', venue: 'steppenwolf' },
  { host: 'rsc.org.uk', venue: 'royal shakespeare' },
  { host: 'lyceum.org.uk', venue: 'royal lyceum' },
  { host: 'royalexchange.co.uk', venue: 'royal exchange' },
  { host: 'cft.org.uk', venue: 'chichester festival' },
  // BRO-5455 (2nd pass): the venues behind the remaining high-severity
  // missing_tickets rows in the freshness report (UK regional + US regional).
  { host: 'pitlochryfestivaltheatre.com', venue: 'pitlochry festival' },
  { host: 'theatreroyal.org.uk', venue: 'theatre royal bath' },
  { host: 'oran-mor.co.uk', venue: 'oran mor' },
  { host: 'citz.co.uk', venue: 'citizens theatre' },
  { host: 'sheffieldtheatres.co.uk', venue: 'sheffield' },
  { host: 'bristololdvic.org.uk', venue: 'bristol old vic' },
  { host: 'leedsplayhouse.org.uk', venue: 'leeds playhouse' },
  { host: 'octagonbolton.co.uk', venue: 'octagon theatre bolton' },
  { host: 'homemcr.org', venue: 'home manchester' },
  { host: 'sjt.uk.com', venue: 'stephen joseph' },
  { host: 'yorktheatreroyal.co.uk', venue: 'york theatre royal' },
  { host: 'tron.co.uk', venue: 'tron theatre' },
  { host: 'hulltruck.co.uk', venue: 'hull truck' },
  { host: 'hopemilltheatre.co.uk', venue: 'hope mill' },
  { host: 'everymanplayhouse.com', venue: 'liverpool everyman' },
  { host: 'writerstheatre.org', venue: 'writers theatre' },
  { host: 'theaterwit.org', venue: 'theater wit' },
  { host: 'raventheatre.com', venue: 'raven theatre' },
  { host: 'redtwist.org', venue: 'redtwist' },
  { host: 'lookingglasstheatre.org', venue: 'lookingglass' },
  { host: 'studiotheatre.org', venue: 'studio theatre washington' },
  { host: 'olneytheatre.org', venue: 'olney theatre' },
  { host: 'keegantheatre.com', venue: 'keegan theatre' },
  { host: 'odysseytheatre.com', venue: 'odyssey theatre' },
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
  'stratfordeast.com', // Theatre Royal Stratford East
  'almeida.co.uk', // Almeida Theatre (covers ticketing.almeida.co.uk)
  'southwarkplayhouse.co.uk',
  'americanrepertorytheater.org', // A.R.T., Cambridge MA
  'repertorio.nyc', // Repertorio Español
  'borninthecity.com', // off-off-Broadway producer/ticketing site (e.g. The Gym at Judson shows)
  'tfana.org', // Theatre for a New Audience / Polonsky Shakespeare Center (card #795)
  'asylumnyc.com', // Asylum NYC (card #795)
  ...REGIONAL_VENUE_SITES.map((v) => v.host),
];

// SERP result paths that are listings/search hubs, never a buyable show page.
const LISTING_PATH_FRAGMENTS = ['/search', '/category', '/discover', '/shows?', '/whats-on?'];

// Resale-only marketplaces — never auto-link these.
// gotickets.com and boxofficeticketsales.com both self-describe as resale
// marketplaces (tickets sourced from "licensed professional sellers", not
// sold on behalf of the venue) despite reading as generic small-venue box
// office platforms — verified via each site's own FAQ/support pages
// (BRO-3636 follow-up; a SERP-fallback link to gotickets.com briefly landed
// in shows.json before this was caught).
const RESALE_HOSTS = ['stubhub.com', 'seatgeek.com', 'vividseats.com', 'viagogo.com', 'ticketnetwork.com', 'gotickets.com', 'boxofficeticketsales.com'];

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
    const regionalVenue = REGIONAL_VENUE_SITES.find((v) => hostMatches(hostOf(url), v.host));
    if (regionalVenue && !(` ${foldTitle(show.venue)} `).includes(` ${regionalVenue.venue} `)) continue;
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

// ---------------------------------------------------------------------------
// BRO-7368: SERP-independent venue-host lookup.
//
// Scrapingdog's SERP hands back opaque Google redirect tokens for many UK/US
// regional venues (url-discovery.js, BRO-7171 Stage 2b), so pickTicketUrl never
// sees the allowlisted venue page. Every REGIONAL_VENUE_SITES host is already
// known per show, so the show page can be read straight off that host's own
// sitemap / what's-on listing with a free direct fetch. The functions below are
// the pure half; enrich-fallback-ticket-links.js does the fetching.
// ---------------------------------------------------------------------------

/** The allowlisted first-party host for this show's venue, or null. */
function venueHostForShow(show) {
  const venue = ` ${foldTitle(show && show.venue)} `;
  const hit = REGIONAL_VENUE_SITES.find((v) => venue.includes(` ${v.venue} `));
  return hit ? hit.host : null;
}

// Sitemap shard names that list productions vs ones that never do.
const SHOW_SITEMAP_RE = /event|show|production|whats-?on|playing|perform|stage|season/i;
const OTHER_SITEMAP_RE = /page|misc/i;
// Whole words only: a bare /tag/ would skip "stage-sitemap", /post/ would skip
// citz.co.uk's "sitemap-posttype-page". A trailing \w* takes camelCase shard
// names such as bristololdvic's "pastProductions" / "accessListings".
const SKIP_SITEMAP_RE = /(^|[^a-z])(posts?|blog\w*|news|people|bios?|profiles?|jobs?|donat\w*|venues?|categor\w*|tags?|authors?|campaigns?|digital\w*|heritage\w*|banners?|images?|videos?|press\w*|archives?|past\w*|access\w*|workshops?\w*|exhibitions?\w*|mailing\w*|returns?|reusable\w*|landing|products?|content_type)([^a-z]|$)/i;

/**
 * Child sitemaps worth reading from a sitemap index, most promising first.
 * Unrecognised shard names are skipped: a cap of `cap` fetches per host keeps
 * the lookup cheap, so it spends them only where shows are listed.
 */
function pickChildSitemaps(urls, cap = 4) {
  const scored = [];
  for (const u of urls || []) {
    let name;
    try { name = new URL(u).pathname; } catch { continue; }
    if (SKIP_SITEMAP_RE.test(name)) continue;
    const score = SHOW_SITEMAP_RE.test(name) ? 2 : OTHER_SITEMAP_RE.test(name) ? 1 : 0;
    if (score > 0) scored.push({ u, score });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, cap).map((s) => s.u);
}

/** Absolute same-host links (query and fragment dropped) from an HTML page. */
function extractSameHostLinks(html, baseUrl) {
  const baseHost = hostOf(baseUrl);
  const out = new Set();
  for (const m of String(html || '').matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    let u;
    try { u = new URL(m[1].replace(/&amp;/g, '&'), baseUrl); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || hostOf(u.href) !== baseHost) continue;
    out.add(`${u.origin}${u.pathname}`);
  }
  return [...out];
}

// Path segments that mark editorial / admin pages, never a production page.
const NON_SHOW_SEGMENT_RE = /^(blog|news|press|press-kit|people|bios?|about(-us)?|education|learning|learn|creative-learning|jobs|careers|podcasts?|journal|articles?|stories|support(-us)?|donate|membership|hire|venue-hire|contact(-us)?|access|basket|checkout|account|my-account|archives?|past[a-z-]*)$/;
const SHOW_SECTION_RE = /^(whats-?on|whats-?playing|events?|shows?|productions?|stage|performances?|plays?)$/;

function showYear(show) {
  const d = (show && (show.openingDate || show.previewsStartDate)) || '';
  const y = Number(String(d).slice(0, 4)) || Number((String((show && show.id) || '').match(/-(\d{4})(?:-|$)/) || [])[1]);
  return y || null;
}

/**
 * Score one venue-site URL as this show's page, or null when it is not one.
 * Every significant title word must appear in the last path segment (or the
 * segment is the title run together, e.g. raventheatre.com/stage/astrangeloop).
 * Extra slug words are allowed only when generic boilerplate, a trailing CMS
 * hash (homemcr.org "iron-x7k2"), or (at most 2) words the show's own synopsis
 * uses ("august-wilsons-fences" for Fences). One-word titles also need a
 * production section in the path so "/contact" never matches "Contact".
 */
function scoreVenuePage(url, show) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const segments = u.pathname.split('/').filter(Boolean).map((s) => {
    try { return decodeURIComponent(s).toLowerCase(); } catch { return s.toLowerCase(); }
  });
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1];
  const parents = segments.slice(0, -1);
  const inShowSection = parents.some((s) => SHOW_SECTION_RE.test(s));
  // An editorial parent (/news/…) always disqualifies; an editorial-looking
  // last segment only outside a production section (/whats-on/contact/ is a
  // show called Contact, /contact/ is the contact page).
  if (parents.some((s) => NON_SHOW_SEGMENT_RE.test(s))) return null;
  if (!inShowSection && NON_SHOW_SEGMENT_RE.test(last)) return null;

  let tokens = foldTitle(last.replace(/[-_.+]/g, ' ')).split(' ').filter(Boolean);
  const bare = String(show.title || '').replace(/\([^)]*\)\s*$/, '');
  const titleCompact = foldTitle(bare).replace(/ /g, '');
  if (tokens.length > 1 && /\d/.test(tokens[tokens.length - 1]) && /[a-z]/.test(tokens[tokens.length - 1])
    && tokens[tokens.length - 1].length <= 6) tokens = tokens.slice(0, -1); // CMS hash suffix

  // An older year anywhere in the path is an archived production: rsc.org.uk
  // /whats-on/2019/hamlet, theoldglobe.org/…/2016-season/… (BRO-7368 review).
  const year = showYear(show);
  const titleTokens = foldTitle(bare).split(' ');
  if (year) {
    for (const seg of segments) {
      for (const m of seg.matchAll(/(?<!\d)(?:19|20)\d{2}(?!\d)/g)) {
        if (Number(m[0]) < year - 1 && !titleTokens.includes(m[0])) return null;
      }
    }
  }

  const candidates = [bare];
  if (bare.includes(':')) candidates.push(bare.split(':')[0]);
  // Apostrophes dropped first so "Wilson's" reads as the slug's "wilsons".
  const synopsisWords = new Set(foldTitle(String(show.synopsis || '').replace(/['’]/g, '')).split(' '));
  let best = null;
  for (const candidate of candidates) {
    const words = significantWords(candidate);
    if (words.length === 0) continue;
    const compactHit = tokens.join('') === titleCompact;
    if (!compactHit && !words.every((w) => tokens.includes(w))) continue;
    if (words.length === 1 && !inShowSection) continue;
    // A bare number that is not a year is content, not boilerplate: hamlet-2
    // is not Hamlet, henry-iv-part-2 is not Part 1. It counts only when the
    // title itself carries it, never via the synopsis.
    const isNumber = (t) => /^\d+$/.test(t) && !/^(19|20)\d{2}$/.test(t);
    if (!compactHit && tokens.some((t) => isNumber(t) && !titleTokens.includes(t))) continue;
    const extras = compactHit ? [] : tokens.filter(
      (t) => t.length > 1 && !STOPWORDS.has(t) && !isGenericToken(t) && !words.includes(t)
    );
    if (extras.length > 2 || extras.some((t) => !synopsisWords.has(t))) continue;
    const score = { url, extras: extras.length, inShowSection, pathLength: u.pathname.length };
    if (!best || score.extras < best.extras) best = score;
  }
  return best;
}

/**
 * Pick this show's page from URLs found on its own venue host (sitemap locs or
 * what's-on links). Returns { url, platform } or null. Pure — no network.
 * Only the venue's own allowlisted host counts, and the result must pass the
 * same platform/resale/region gates as a SERP pick.
 */
function pickVenuePageUrl(urls, show) {
  const host = venueHostForShow(show);
  if (!host || !Array.isArray(urls)) return null;
  const scored = [];
  for (const raw of urls) {
    const url = String(raw || '').replace(/^http:/, 'https:').split(/[?#]/)[0];
    const h = hostOf(url);
    // The venue host itself (hostOf already drops www.), never shop./blog./
    // archive. subdomains, which carry merchandise or past seasons.
    if (!h || h !== host) continue;
    if (platformForUrl(url) === null || isRegionMismatch(url, show)) continue;
    const s = scoreVenuePage(url, show);
    if (s) scored.push(s);
  }
  if (scored.length === 0) return null;
  scored.sort((a, b) => a.extras - b.extras
    || Number(b.inShowSection) - Number(a.inShowSection)
    || a.pathLength - b.pathLength);
  return { url: scored[0].url, platform: platformForUrl(scored[0].url) };
}

/**
 * True when another catalog row shares this show's title at the same venue
 * host (an earlier or later run, e.g. an RSC Hamlet revival). An undated
 * archive page for that other run stays in the venue sitemap and answers 200,
 * so for these shows a sitemap-only hit is not evidence; the URL must also be
 * on the venue's current listing pages (what's-on / homepage).
 */
function needsListingConfirmation(shows, show) {
  const host = venueHostForShow(show);
  if (!host || !Array.isArray(shows)) return false;
  const norm = (t) => foldTitle(String(t || '').replace(/\([^)]*\)\s*$/, ''));
  const title = norm(show.title);
  return shows.some((o) => o && o !== show && o.id !== show.id
    && norm(o.title) === title && venueHostForShow(o) === host);
}

module.exports = {
  needsListingConfirmation,
  venueHostForShow,
  pickChildSitemaps,
  extractSameHostLinks,
  pickVenuePageUrl,
  REGIONAL_VENUE_SITES,
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
