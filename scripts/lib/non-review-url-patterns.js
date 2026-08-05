'use strict';

/**
 * non-review-url-patterns.js — canonical "this URL is never a review" host
 * and path patterns.
 *
 * Single source of truth shared by two callers that used to hand-maintain
 * their own copies:
 *   - audit-show-review-gap.js's isReviewUrl() — the discovery-time gate that
 *     runs BEFORE a URL is even considered a candidate (S1 recall harness,
 *     opening-night discovery, the S5 adversarial probe's own naive query).
 *   - coverage-adversarial-probe.js's classifyNonReviewUrl() — the S5 probe's
 *     post-lookup fallback classifier, which runs AFTER an on-disk match
 *     attempt fails, right before a candidate would otherwise read as a gap.
 *
 * Extracted 2026-08 (task #907 ship-check finding, Codex adversarial review):
 * the probe originally carried its own hand-written duplicate of a subset of
 * these patterns. Two independently-maintained copies of the same "is this a
 * review" policy WILL drift — a future ticketing host added to one and not
 * the other either leaves the probe reporting false gaps, or lets a
 * probe-only exclusion hide a real review from the discovery-time filter.
 * (Same lesson as memory: includability predicates must be canonical.)
 *
 * Zero heavy deps (no fs/network) — safe for coverage-adversarial-probe.js's
 * "pure, fixture-testable" pure-decision-layer contract to require directly.
 */

// Non-review domains ignored inside aggregator articles (platform widgets,
// social, navigation, store links, internal Playbill/BWW article navigation).
const NON_REVIEW_HOST_PATTERNS = [
  /^facebook\.com$/, /^instagram\.com$/, /^twitter\.com$/, /^x\.com$/,
  /^youtube\.com$/, /^tiktok\.com$/, /^threads\.net$/, /^linkedin\.com$/,
  /^pinterest\./, /^reddit\.com$/, /^t\.me$/, /^whatsapp\./,
  /^playbillder\.com$/, /^playbillstore\.com$/, /^playbilltravel\.com$/,
  /^stagemag\.broadwayworld\.com$/, /^broadwayworldshop\.com$/,
  /^forum\.broadwayworld\.com$/, /^data\.broadwayworld\.com$/,
  /^wisdomdigital\.com$/, /^cur8\.com$/, /^jt-pr-dot-yamm-track\.appspot\.com$/,
  // venue & box-office (not reviews)
  /\.org$/, // catches many venue domains; allow-list known critic .orgs below
  /^ci\.ovationtix\.com$/,
  // ticketing / box-office hosts — aggregator "Get Tickets" links, never reviews.
  // Before 2026-06-05 these were skipped only because their unknown outlet was
  // skipped; with auto-onboard they would be ingested as bogus "telecharge" /
  // "todaytix" provisional outlets, so they must be filtered at the source.
  /^telecharge\.com$/, /^ticketmaster\.com$/, /(^|\.)todaytix\.com$/,
  /^seatgeek\.com$/, /^stubhub\.com$/, /^broadwaydirect\.com$/,
  /(^|\.)ticketmaster\./, /^ovationtix\.com$/, /^web\.ovationtix\.com$/,
  /^tickets\./, /^boxoffice\./,
  // Second wave, measured 2026-08-02 (task #872): the naive un-scoped census
  // arm reaches deeper into the SERP than the site:-scoped arms ever did, so
  // it surfaces the ticketing/listing/reference layer that sits between the
  // real reviews. Every host here was an accepted "gap" in the recall harness
  // on The Car Man / Brainiac Live / Tao of Glass and is never a review.
  // (londontheatre.co.uk is deliberately NOT here — it publishes real reviews
  // under /reviews/.)
  /^seatplan\.com$/, /^lovetheatre\.com$/, /^lovetovisit\.com$/,
  /^comparetheticketprice\.com$/, /^skiddle\.com$/, /^ticketsource\./,
  /^nimaxtheatres\.com$/, /(^|\.)londontheatres\.co\.uk$/,
  /^sadlerswells\.com$/, /^improbable\.co\.uk$/,
  /^imdb\.com$/, /(^|\.)wikipedia\.org$/, /(^|\.)tripadvisor\./,
  /^theatreboard\.com$/, /^officiallondontheatre\.com$/,
  /(^|\.)london-theatreland\.co\.uk$/, /^ma\.to$/,
  // Our own site is never a source for our own gap list.
  /(^|\.)broadwayscorecard\.com$/,
  // Book/consumer-review sites: a naive "<title> review" for a title that is
  // also a book ("The Gruffalo") pulls these in wholesale.
  // (hostOf/registrableHost strips "www." before these run — never add a
  // www-prefixed pattern, it can only ever be dead.)
  /(^|\.)goodreads\.com$/, /(^|\.)thebookbag\.co\.uk$/,
  /(^|\.)fantasybookreview\.co\.uk$/,
  // Remaining chaff measured in the first full recall run's newFromNaive
  // (data/audit/serp-census-recall.json, 2026-08-02): social, resellers,
  // experience marketplaces and venue own-sites.
  /^threads\.com$/, /(^|\.)atgtickets\.com$/, /(^|\.)getyourguide\./,
  /(^|\.)klook\.com$/, /(^|\.)headout\.com$/, /(^|\.)yelp\./,
  /(^|\.)justluxe\.com$/, /(^|\.)whichmuseum\./, /(^|\.)theotherpalace\.co\.uk$/,
  // Fourth wave (task #71 residual-gap triage, 2026-08-05): page-asset
  // chaff measured in data/audit/show-review-gap.json's "missing" lists
  // across ~150 audited shows — fonts/CDN/maps/forms embedded in an
  // aggregator article's HTML. show-score.com is DELIBERATELY NOT added
  // here despite its own catalog/nav links leaking through the same way —
  // ship-check adversarial review caught that coverage-adversarial-probe.js's
  // onDiskByUrlFor() relies on isReviewUrl() to index legitimately-captured
  // Show Score star-stub review files by URL (aggregator-domains.js's
  // AGGREGATOR_DOMAINS carries show-score.com as a valid outlet-URL pair);
  // blocking the whole host here would make the S5 probe stop recognizing
  // those on-disk records and misreport them as gaps. See the header comment
  // on classifyNonReviewUrl() in coverage-adversarial-probe.js.
  /(^|\.)cloudfront\.net$/, /(^|\.)gstatic\.com$/, /(^|\.)googleapis\.com$/,
  /(^|\.)google\.com$/, /(^|\.)todaytixgroup\.com$/,
  // Fifth wave (task #71): UK ticketing/tourism-listing platforms and ad-tech,
  // measured on WE family/kids shows (Dog Man - The Musical, A Midsummer
  // Night's Dream) — never review outlets, unlike londontheatredirect.com
  // (deliberately NOT added here — it also publishes /news/*-review posts).
  // southlondon.co.uk is ALSO deliberately excluded from this wave — ship-check
  // adversarial review caught that it's a registered Tier 4 outlet
  // ("south-london" in outlet-registry.json) with 7 real scored reviews under
  // /lifestyle/review-*; the sampled dog-man URL was its unrelated /area/
  // listing section, not evidence the whole host is non-review.
  /^doubleclick\.net$/, /^showify\.uk$/, /^showpass\.com$/,
  /^showtours\.co\.uk$/, /^bookitplease\.com$/, /^visitlondon\.com$/,
];

const ALLOWED_ORG_HOSTS = new Set([
  'artsfuse.org', 'npr.org', 'exeuntnyc.org', // edge cases that ARE review outlets
]);

const NON_REVIEW_PATH_PATTERNS = [
  /^\/article(\/|$)/, // playbill article nav
  /^\/reviews\/?$/,   // BWW landing
  /^\/industry-/, /^\/theatre-auditions/, /^\/youth-theater/,
  /^\/newsroom/, /^\/newsletter/,
  /\/tickets?(\/|$|-)/i, // "Get Tickets" / box-office links, not reviews
];

/**
 * Third wave, measured task #907 (day-one live triage of the S5 probe's
 * first CI run — 6 of 9 first-run "gaps" were exactly this class) plus its
 * own fix's live --sample re-run (broadway.com, theatermania.com/shows/).
 * Unlike NON_REVIEW_HOST_PATTERNS above, some entries are host+path pairs:
 * a host that DOES publish real reviews under one path (theatermania.com's
 * /news/review-.../, londontheatre.co.uk's /reviews/) but never under
 * another (their own ticketing/show-info page) — so only the specific path
 * is excluded, not the whole host. `reason` is a stable label surfaced by
 * the S5 probe's classifyNonReviewUrl() when a candidate is named-excluded.
 */
const NAMED_NON_REVIEW_URL_PATTERNS = [
  { host: /(^|\.)newyorkcitytheatre\.com$/, reason: 'ticketing-reseller' },
  { host: /(^|\.)newbrunswicktheater\.com$/, reason: 'ticketing-reseller' },
  { host: /(^|\.)nationaltheatre\.org\.uk$/, path: /^\/productions\//, reason: 'venue-production-page' },
  { host: /(^|\.)middlesexcountyculture\.com$/, path: /^\/event\//, reason: 'event-listing' },
  { host: /(^|\.)londontheatre\.co\.uk$/, path: /^\/show\/\d+/, reason: 'ticketing-listing' },
  { host: /(^|\.)broadway\.com$/, reason: 'ticketing-reseller' },
  { host: /(^|\.)theatermania\.com$/, path: /^\/shows\//, reason: 'venue-production-page' },
];

/**
 * Does this URL match one of the NAMED_NON_REVIEW_URL_PATTERNS above?
 * @param {string} url
 * @returns {string|null} the pattern's reason label, or null
 */
function namedNonReviewReason(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  for (const p of NAMED_NON_REVIEW_URL_PATTERNS) {
    if (!p.host.test(host)) continue;
    if (p.path && !p.path.test(u.pathname)) continue;
    return p.reason;
  }
  return null;
}

module.exports = {
  NON_REVIEW_HOST_PATTERNS,
  ALLOWED_ORG_HOSTS,
  NON_REVIEW_PATH_PATTERNS,
  NAMED_NON_REVIEW_URL_PATTERNS,
  namedNonReviewReason,
};
