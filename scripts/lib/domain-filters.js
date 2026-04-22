/**
 * Shared domain filtering for review collection pipeline.
 * Single source of truth for blocked domains across all scrapers.
 *
 * Usage:
 *   const { isBlockedReviewUrl, isSocialMediaUrl, SOCIAL_DOMAINS, NON_REVIEW_DOMAINS } = require('./lib/domain-filters');
 *   if (isBlockedReviewUrl(url)) skip;
 */

// Social media platforms — never valid review URLs
const SOCIAL_DOMAINS = new Set([
  'facebook.com', 'instagram.com', 'twitter.com', 'x.com',
  'youtube.com', 'youtu.be', 'tiktok.com', 'threads.net',
  'reddit.com', 'linkedin.com', 'tumblr.com', 'pinterest.com',
  'vimeo.com', 'spotify.com', 'music.amazon.com', 'apple.com',
]);

// Ticket/booking platforms — never valid review URLs
const TICKET_DOMAINS = new Set([
  'todaytix.com', 'telecharge.com', 'ticketmaster.com', 'broadwaydirect.com',
  'seatgeek.com', 'stubhub.com', 'vividseats.com', 'broadwaybox.com',
  'goldstar.com', 'headout.com', 'rush.app', 'bwayrush.com',
  'luckyseat.com', 'broadwayroulette.com',
]);

// Aggregator/listing sites — not direct review sources
const AGGREGATOR_DOMAINS = new Set([
  'show-score.com', 'showscore.com',
  // NOTE: playbill.com removed from blanket block — Playbill publishes original articles (/article/ paths).
  // Listing pages (/production/, /show/) are caught by the path-based check below.
  // NOTE: broadwayworld.com NOT here — BWW publishes original reviews; roundups use isRoundupArticle flag
  'ibdb.com', 'broadway.com', 'broadway.org',
  // NOTE: newyorktheatreguide.com and newyorktheaterguide.com both removed —
  // NYTG publishes original reviews (Kyle Turner, Allison Considine, etc.).
  // Was blocking Becky Shaw NYTG review despite passing all other guards
  // (2026-04-07). The US spelling ("theater") was kept briefly on the theory
  // that it redirects to the UK spelling, but isBlockedReviewUrl operates on
  // the literal URL and will block before any redirect is followed — so any
  // review we ingest whose source URL happens to be the US spelling also gets
  // silently dropped. Bucket A, Tier 2 Fix 9.
  'lovelondonloveculture.com', 'westendtheatre.com',
  'newyorkcitytheatre.com', 'broadwayacrossamerica.com',
  'broadwayscorecard.com', 'broadway.org.uk', 'londonsbroadwaybuzz.ca',
  'stagedoor.com', // WE aggregator — critic-reviews pages are not outlet reviews
]);

// Reference sites — not reviews
const REFERENCE_DOMAINS = new Set([
  'wikipedia.org', 'wikidata.org', 'imdb.com',
  'yelp.com', 'tripadvisor.com', 'google.com', 'amazon.com',
  'iloveny.com',
]);

/**
 * Check if a hostname matches any domain in a set (exact or subdomain match).
 * e.g., "m.facebook.com" matches "facebook.com"
 */
function matchesDomainSet(hostname, domainSet) {
  const h = hostname.replace(/^www\./, '').toLowerCase();
  if (domainSet.has(h)) return true;
  for (const d of domainSet) {
    if (h.endsWith('.' + d)) return true;
  }
  return false;
}

/**
 * Check if a URL points to a social media platform.
 */
function isSocialMediaUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return matchesDomainSet(hostname, SOCIAL_DOMAINS);
  } catch { return false; }
}

/**
 * Check if a URL is a non-review URL (social, ticket, aggregator, or reference site).
 * Use this to filter URLs that should never be treated as review sources.
 */
function isBlockedReviewUrl(url) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;
    if (matchesDomainSet(hostname, SOCIAL_DOMAINS)
      || matchesDomainSet(hostname, TICKET_DOMAINS)
      || matchesDomainSet(hostname, AGGREGATOR_DOMAINS)
      || matchesDomainSet(hostname, REFERENCE_DOMAINS)) return true;
    // Path-based blocking for sites that publish BOTH reviews and listings
    const lowerPath = parsed.pathname.toLowerCase();
    // Playbill: /article/ paths are reviews/content (allow), /production/ and /show/ are listings (block)
    if (matchesDomainSet(hostname, new Set(['playbill.com']))) {
      if (lowerPath.startsWith('/article/')) return false; // allow articles
      return true; // block everything else (listings, production pages)
    }
    // Path-based ticket/listing detection — catches ticket pages on news sites
    // (e.g., standard.co.uk/go/london/mamma-mia-musical-theatre-tickets-in-london)
    if (lowerPath.includes('/tickets/') || lowerPath.includes('/buy-tickets')
      || lowerPath.includes('/book-tickets') || lowerPath.includes('tickets-in-london')
      || lowerPath.includes('/going-out/tickets/')) return true;
    // Feature articles and interviews — not reviews
    // Matches exact path segments: /features/, /feature/, /interviews/, /interview/
    // Does NOT match /featured-review/ or /review-features-xyz/ (substring matches)
    const pathParts = lowerPath.split('/').filter(Boolean);
    if (pathParts.some(p => p === 'features' || p === 'feature' || p === 'interviews' || p === 'interview')) return true;
    // Malformed URLs (e.g., "http://Here We Are review — ...")
    if (parsed.hostname.includes(' ') || !parsed.hostname.includes('.')) return true;
    return false;
  } catch { return false; }
}

/**
 * Check a raw domain string against all blocked sets.
 */
function isBlockedDomain(domain) {
  const d = domain.replace(/^www\./, '').toLowerCase();
  return SOCIAL_DOMAINS.has(d) || TICKET_DOMAINS.has(d)
    || AGGREGATOR_DOMAINS.has(d) || REFERENCE_DOMAINS.has(d);
}

module.exports = {
  SOCIAL_DOMAINS,
  TICKET_DOMAINS,
  AGGREGATOR_DOMAINS,
  REFERENCE_DOMAINS,
  isSocialMediaUrl,
  isBlockedReviewUrl,
  isBlockedDomain,
  matchesDomainSet,
};
