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
  // UK/WE ticketing + listing platforms (2026-08-02: gather saved a
  // bookitplease.com booking page as a Dog Man "review" stub under a
  // misattributed outlet).
  // NOTE: london-theatreland.co.uk deliberately NOT here — it publishes
  // original editorial reviews at /reviews/our/<show> (adversarial review
  // 2026-08-02); its listing pages are caught by the path-based checks.
  'bookitplease.com', 'showpass.com', 'atgtickets.com', 'lovetheatre.com',
  // thelondoner.com — /exclusive-offers/<show> is a ticket-offer page carrying
  // the producer's own show blurb. Its A Month in the Country page was ingested
  // via submit-review-form, criticName Unknown, and landed at
  // contentTier:'complete' (3790 chars of well-formed prose), so it was a live
  // scoring candidate held back only by having no score yet. Same shape as the
  // BRO-2712 southbankcentre finding.
  'thelondoner.com',
  // vocaleyes.co.uk — audio-description access LISTINGS ("Audio-described
  // performance, Touch tour, Date, Time"), not criticism. Excellent cause,
  // wrong corpus.
  'vocaleyes.co.uk',
  'ticketsource.co.uk', 'fromtheboxoffice.com', 'encoretickets.co.uk',
  'ticketek.co.uk', 'seetickets.com',
  // ticketline.co.uk (2026-09-01): same class as the UK sellers above and the
  // only reason it was missing is that nothing had ingested it before. It had
  // been parked in data/audit/outlet-registry-baseline.json as a "known
  // missing outlet", i.e. masked rather than excluded; blocking the domain is
  // the same remedy BRO-2712 applied to the venue/PR-firm hosts.
  'ticketline.co.uk',
  // 2026-08-16 (task #766 re-triage): skiddle.com is a UK gigs/events ticketing
  // and listings platform, not a review outlet — it was the majority host in
  // click-liverpool's own review-texts archive (2 of the outlet's real domain's
  // 1), which would have made it the auto-inferred "domain" for that outlet had
  // the domain-hint heuristic run unblocked. Verified zero hits across every
  // scored review URL in reviews.json before adding.
  'skiddle.com',
  // 2026-08-09: both were counted as MISSING REVIEWS for
  // disruption-off-broadway-2026 by the SERP census. Two of the three openings
  // the newsletter gate deleted from the 2026-08-03 issue were dropped over
  // gaps that did not exist, and these two hosts are one of them. Verified
  // zero hits across every scored review URL in reviews.json before adding
  // (a deny-list entry that matches a real review is worse than the phantom
  // gap it removes).
  'ticketluck.com', 'etickets.com',
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
  // Not a registered outlet under any outletId — surfaced twice as a wrong-host
  // review filed under a domainless outlet (daily-echo, western-mail), the
  // exact failure mode task #766 exists to close (data/audit re-triage,
  // 2026-08-16). Block outright rather than let a domainless outlet's SERP
  // guard or domain-hint inference ever accept it.
  'theatreandartreviews.com',
]);

// Reference sites — not reviews
const REFERENCE_DOMAINS = new Set([
  'wikipedia.org', 'wikidata.org', 'imdb.com',
  'yelp.com', 'tripadvisor.com', 'google.com', 'amazon.com',
  'iloveny.com',
  // University department news/press pages. tisch.nyu.edu announced an alum's
  // production ("Lukas T. Woodyard (PS MA '20) along with their collective ...
  // is producing the new work") and was ingested via submit-review-form as a
  // masticate-off-broadway-2026 review. A previous crown cycle baselined this
  // outletId and recorded "do NOT register these as real outlets if they
  // recur". It recurred. Blocking the host is what actually ends it — the
  // baseline only silences one outletId, and the next alum announcement from
  // any university arrives under a new one. Whole-domain so *.nyu.edu is
  // covered, since the department subdomain is incidental.
  'nyu.edu',
]);

// Venue/producer own-site listing pages — box-office "what's on" copy, never
// criticism (BRO-2712: southbank.london's Electra/Persona page was "Home
// What's On ... Save this Dates ... Ticket Information ... Location Info",
// ingested via /submit-review and scored as a "truncated" review).
const VENUE_DOMAINS = new Set([
  'southbank.london',
  // Same venue family, different domain — southbankcentre.co.uk's own
  // /whats-on/ listing pages are the identical "Toggle caption ... Dates &
  // tickets ... Access ... Ticket Office" box-office copy (BRO-2712
  // adversarial-review finding: dog-man-the-musical-west-end-2026's
  // southbankcentre--unknown.json was ingested via the same /submit-review
  // path and only excluded by luck — the LLM ensemble check happened to catch
  // it, the same check that MISSED southbank.london's Electra/Persona page).
  'southbankcentre.co.uk',
]);

// Theatre PR firms — press releases, not criticism, but they read as
// well-formed prose (byline, dateline, plot summary) so structural
// heuristics like isJunkOutlet() never catch them (BRO-2712: spincyclenyc.com
// filed a 4300-char SparkPlug Productions press release for The Bathroom
// Attendant with a "critic" name of "Ron" and contentTier=complete — a live
// candidate for scoring as a critic review before this was caught).
const PR_FIRM_DOMAINS = new Set([
  'spincyclenyc.com',
]);

// User-generated publishing platforms — anyone can post, there is no editorial
// desk and no critic of record, so a post here is not criticism even when it is
// long, well-formed and topically a review. Structural heuristics cannot catch
// them for the same reason PR-firm copy slips through (BRO-2712): the prose is
// fine, the source is not.
//
// vocal.media (2026-09-01, this made main red): vocal.media/critique/bathroom-attendant
// was ingested for the-bathroom-attendant-off-broadway-2026 at contentTier=complete
// with no byline and no publishDate, and turned up as a NEW unregistered outlet in
// `audit-outlet-registry.js --strict`. Note the same show also produced the
// spincyclenyc.com press release — one under-covered off-Broadway title pulls in
// whatever the SERP will give it, so this set should be expected to grow.
const UGC_PLATFORM_DOMAINS = new Set([
  'vocal.media',
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
      || matchesDomainSet(hostname, REFERENCE_DOMAINS)
      || matchesDomainSet(hostname, VENUE_DOMAINS)
      || matchesDomainSet(hostname, PR_FIRM_DOMAINS)
      || matchesDomainSet(hostname, UGC_PLATFORM_DOMAINS)) return true;
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
    || AGGREGATOR_DOMAINS.has(d) || REFERENCE_DOMAINS.has(d)
    || VENUE_DOMAINS.has(d) || PR_FIRM_DOMAINS.has(d) || UGC_PLATFORM_DOMAINS.has(d);
}

module.exports = {
  SOCIAL_DOMAINS,
  TICKET_DOMAINS,
  AGGREGATOR_DOMAINS,
  REFERENCE_DOMAINS,
  VENUE_DOMAINS,
  PR_FIRM_DOMAINS,
  UGC_PLATFORM_DOMAINS,
  isSocialMediaUrl,
  isBlockedReviewUrl,
  isBlockedDomain,
  matchesDomainSet,
};
