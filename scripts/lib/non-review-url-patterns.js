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

// Ticket-seller hosts are owned by the WRITE PATH's list, not duplicated here
// — see the note in classifyReviewUrl. domain-filters.js is dependency-free
// (no fs, no network), so this preserves this module's "safe for the S5 probe's
// pure decision layer" load contract.
const { TICKET_DOMAINS, matchesDomainSet } = require('./domain-filters');
const { platformSuffixOf, multipartSuffixOf, stripCosmeticPrefixes } = require('./host-suffix-lists');

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
  // NOTE: `/^\/article(\/|$)/` was here, commented "playbill article nav", but
  // these patterns are matched HOST-AGNOSTICALLY against every URL — and
  // /article/ is where several major critic outlets publish. It dropped 736 of
  // 18841 existing reviews when measured against reviews.json, including 144
  // Vulture, 88 Entertainment Weekly, 33 Wall Street Journal, 106 New York Sun.
  // Vulture's review URLs are literally vulture.com/article/theater-review-*.
  //
  // The intended case is already covered, correctly and host-scoped, by the
  // playbill.com/broadwayworld.com 'aggregator-internal-nav' check in
  // classifyReviewUrl() below. Do not re-add a bare /article/ rule here; scope
  // any aggregator-nav rule to the aggregator's host.
  /^\/reviews\/?$/,   // BWW landing
  /^\/industry-/, /^\/theatre-auditions/, /^\/youth-theater/,
  /^\/newsroom/, /^\/newsletter/,
  /\/tickets?(\/|$|-)/i, // "Get Tickets" / box-office links, not reviews
  // NOTE (OWE opening audit 2026-08-06): do NOT add host-agnostic "-tickets"
  // or "/whats-on/" rules here — same trap as the removed bare /article/ rule
  // above. Full-corpus check found real reviews at BOTH shapes: Express UK and
  // Digital Spy review slugs end in "-tickets" (Operation Mincemeat scored
  // 100), and Manchester Evening News / Liverpool Echo / London Mums publish
  // reviews under /whats-on/ sections. The ticket-page cases are host-scoped
  // in NAMED_NON_REVIEW_URL_PATTERNS below (westendtheatre.com show pages,
  // londonboxoffice.co.uk root ticket slugs).
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
  // Sixth wave (task #1073, 2026-08-05 — Pass/Disruption/Vessel coverage audit):
  // BWW /shows/{id}/... (cast/synopsis/videos) pages are listing pages, never
  // reviews — the-vessel had one ingested via SERP as a "review" whose 920-char
  // synopsis blurb then host-masked the real coverage check. Mirrors the
  // theatermania.com/shows/ entry above and rebuild-all-reviews.js's
  // isShowListingUrl (which already names broadwayworld.com/shows/ a listing).
  // BWW /reviews/{slug} critics-HUB pages are handled by review-guards
  // isRoundupUrl (composed in classifyReviewUrl below), not duplicated here.
  // Sub-path REQUIRED (/shows/{id}/cast etc.) — the bare /shows/Title-123.html
  // shape hosts 3 currently-scored real reviews (Oliver!, Something Rotten!,
  // Titanique — QA ship-check 2026-08-06), so only the listing sub-pages are
  // blocked, never the bare page.
  { host: /(^|\.)broadwayworld\.com$/, path: /^\/shows?\/[^/]+\/.+/, reason: 'venue-production-page' },
  { host: /(^|\.)borninthecity\.com$/, reason: 'merch-store' },
  { host: /(^|\.)eventticketscenter\.com$/, reason: 'ticketing-reseller' },
  // Stagebuddy publishes real reviews under /theater/reviews/…; its
  // theater-feature section is previews/features, not reviews (Disruption
  // census counted one as a missing review, 2026-08-05).
  { host: /(^|\.)stagebuddy\.com$/, path: /^\/theater\/theater-feature\//, reason: 'feature-not-review' },
  // Seventh wave (2026-08-06 — Cats/NYSM/I'm Every Woman OWE opening audit,
  // first live exercise of #1073): ticketing/listing hosts that reached the
  // census "missing" lists — groupon deal pages and one was auto-INGESTED as a
  // provisional "groupon" outlet before downstream guards flagged it. All
  // measured zero hits across the 18,860 scored review URLs in reviews.json.
  // No $ anchor on purpose: groupon sells under many ccTLDs (groupon.com,
  // groupon.co.uk, groupon.de, …) — unlike the single-domain siblings below.
  { host: /(^|\.)groupon\./, reason: 'ticketing-reseller' },
  { host: /(^|\.)officialtheatre\.com$/, reason: 'ticketing-listing' },
  { host: /(^|\.)kxtickets\.com$/, reason: 'ticketing-listing' },
  { host: /(^|\.)westend\.com$/, reason: 'ticketing-listing' },
  // Producer's own what's-on page (mischiefcomedy.com listed as a Comedy About
  // Spies census "missing review"). Host-wide: a producer site never reviews
  // its own show.
  { host: /(^|\.)mischiefcomedy\.com$/, reason: 'venue-production-page' },
  // WET's own /NNNNNN/shows/… show/ticket pages (e.g. /317407/shows/cats-tickets/)
  // are listings; its real roundups live at /reviews/. Host+path scoped — a
  // host-agnostic "-tickets" rule would eat Express UK / Digital Spy review
  // slugs (see NON_REVIEW_PATH_PATTERNS note above).
  { host: /(^|\.)westendtheatre\.com$/, path: /^\/\d+\/shows\//, reason: 'ticketing-listing' },
  // LBO root ticket slugs (/now-you-see-me-tickets); its reviews live under
  // /news/ (e.g. /news/post/cats-review — a real captured review).
  { host: /(^|\.)londonboxoffice\.co\.uk$/, path: /^\/[^/]*-tickets\/?$/, reason: 'ticketing-listing' },
  // task #1756 (main-red incident): audit-aggregator-gap auto-ingested both
  // of these as "reviews" for jeeves-takes-charge-west-end-2026 — box-office
  // pricing text and a broken map widget, 0 usable words, never scored. Same
  // producer's-own-site shape as mischiefcomedy.com above: a venue never
  // reviews the show it's hosting. londontopia.net is scoped to its
  // /london-events/ listing path, not host-wide — unconfirmed whether it
  // publishes real coverage elsewhere.
  { host: /(^|\.)charingcrosstheatre\.co\.uk$/, reason: 'venue-production-page' },
  { host: /(^|\.)londontopia\.net$/, path: /^\/london-events\//, reason: 'event-listing' },
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

// Host normalization, moved VERBATIM from audit-show-review-gap.js (task
// #1073) so classifyReviewUrl and every caller share ONE implementation.
// The audit now imports these instead of carrying its own copy.

// Mirror/format subdomains that are never a distinct outlet — a publisher's AMP
// or mobile host is the same outlet as its bare domain.
// (mirror/format subdomain stripping now lives in host-suffix-lists.js's
// stripCosmeticPrefixes, so all three host-identity functions strip the same
// prefixes under the same "don't eat the publication label" guard.)
// Which suffix a host sits on comes from host-suffix-lists.js — the SHARED
// source of truth, also used by outlet-canonicalize.js (provisionalOutletIdFromHost)
// and silent-exclusion-detectors.js (normalizeHostSlug). This file used to carry
// a third literal copy whose comments read "Mirrors PROVISIONAL_BLOG_PLATFORMS
// in outlet-canonicalize.js" — and it had already fallen out of sync: it lacked
// any Blogger country mirror, so registrableHost('showshowdown.blogspot.co.id')
// returned the bare public suffix 'co.id' as if that were a registrable domain.
// Three functions that must agree cannot each keep a private list.

// Collapse a hostname to its registrable domain so section subdomains
// (theater.nytimes.com) and mirror hosts (amp.theguardian.com) look up the same
// registry entry as the bare domain. Leaves blog-platform publication subdomains
// intact so they keep their per-publication provisional identity.
function registrableHost(host) {
  if (!host || typeof host !== 'string') return host;
  const h = stripCosmeticPrefixes(host);
  if (!h) return host;
  if (platformSuffixOf(h)) return h;
  const parts = h.split('.').filter(Boolean);
  const keep = multipartSuffixOf(h) ? 3 : 2;
  return parts.length > keep ? parts.slice(-keep).join('.') : h;
}

function hostOf(u) {
  try { return registrableHost(new URL(u).hostname); }
  catch { return null; }
}

const STATIC_ASSET_EXT_RE = /\.(css|js|json|xml|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|mp4|pdf)$/i;

/**
 * classifyReviewUrl — THE canonical "may this URL be a review candidate"
 * decision (task #1073). Composes every URL-shape policy in one place:
 * host denylist, named host+path pairs, roundup-hub shapes (write-path policy
 * via review-guards.isRoundupUrl), aggregator internal nav, static assets.
 *
 * Rejects by URL/host SHAPE only — never by "outlet not registered", so
 * unknown-but-real outlets still flow to the unknown-outlets onboarding
 * report (Codex review finding, plan W3.B).
 *
 * @param {string} url
 * @returns {{ok: boolean, reason: string|null}}
 */
function classifyReviewUrl(url) {
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return { ok: false, reason: 'not-http-url' };
  }
  const h = hostOf(url);
  if (!h) return { ok: false, reason: 'unparseable-url' };
  if (NON_REVIEW_HOST_PATTERNS.some(rx => rx.test(h)) && !ALLOWED_ORG_HOSTS.has(h)) {
    return { ok: false, reason: 'non-review-host' };
  }
  // Ticket sellers: read the WRITE PATH's list rather than keeping a parallel
  // one here. domain-filters.js TICKET_DOMAINS is what isBlockedReviewUrl uses
  // to refuse an ingest; before this, the census kept its own copy, so a host
  // added to one list still counted as a "missing review" in the other. That
  // divergence is how ticketluck.com and etickets.com became two of the
  // phantom gaps that got Disruption deleted from the 2026-08-03 newsletter.
  // One list now covers discovery AND ingest.
  //
  // Only TICKET_DOMAINS is borrowed, deliberately — domain-filters' aggregator
  // and reference sets are broader than this classifier wants (show-score.com
  // in particular must stay classifiable here, see the note above on
  // NON_REVIEW_HOST_PATTERNS).
  if (matchesDomainSet(h, TICKET_DOMAINS)) {
    return { ok: false, reason: 'ticketing-reseller' };
  }
  const named = namedNonReviewReason(url);
  if (named) return { ok: false, reason: named };
  // Roundup hubs/articles: same policy the write path enforces
  // (review-guards.isRoundupUrl). Lazy require: keeps this module's
  // zero-heavy-deps load contract for the S5 probe and avoids any
  // load-order cycle with review-guards.
  const { isRoundupUrl } = require('./review-guards');
  const roundup = isRoundupUrl(url);
  if (roundup && roundup.isRoundup) return { ok: false, reason: 'roundup-page' };
  // Lighting & Sound America: bare /news/story.asp with no ?ID= is the news
  // index, not a review (moved from audit-show-review-gap.js isReviewUrl).
  if (h === 'lightingandsoundamerica.com') {
    try {
      const u = new URL(url);
      if (/\/news\/story\.asp$/i.test(u.pathname) && !u.searchParams.get('ID')) {
        return { ok: false, reason: 'lsa-news-index' };
      }
    } catch { return { ok: false, reason: 'unparseable-url' }; }
  }
  // Playbill/BWW internal navigation (we want outlet URLs, not aggregator nav).
  if ((h === 'playbill.com' || h === 'broadwayworld.com')
      && !/\/(review|reviews|theater|theatre|news|stage|culture|arts)/i.test(url)) {
    return { ok: false, reason: 'aggregator-internal-nav' };
  }
  try {
    const p = new URL(url).pathname;
    if (NON_REVIEW_PATH_PATTERNS.some(rx => rx.test(p))) {
      return { ok: false, reason: 'non-review-path' };
    }
    if (STATIC_ASSET_EXT_RE.test(p)) return { ok: false, reason: 'static-asset' };
  } catch { return { ok: false, reason: 'unparseable-url' }; }
  return { ok: true, reason: null };
}

module.exports = {
  NON_REVIEW_HOST_PATTERNS,
  ALLOWED_ORG_HOSTS,
  NON_REVIEW_PATH_PATTERNS,
  NAMED_NON_REVIEW_URL_PATTERNS,
  namedNonReviewReason,
  registrableHost,
  hostOf,
  classifyReviewUrl,
};
