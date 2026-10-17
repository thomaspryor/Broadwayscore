'use strict';

/**
 * Off-Broadway venue listing discovery.
 *
 * Mirrors scripts/lib/playbill-ob-schedule.js. Sibling discovery source for
 * Off-Broadway non-profit subscription houses (Atlantic, Vineyard, Signature,
 * MCC) that don't list on TodayTix and aren't fully covered by Playbill's
 * OB schedule article.
 *
 * Functions exported:
 *   - parseVenueListingHtml(venue, html)   → [{title, venue, slug, source}]
 *   - scrapeVenueListing(venue)            → fetch + parse; also writes staging
 *   - extractByLink(doc, venue)            → strategy: scoped <a href> match
 *   - extractBySelector(doc, venue)        → strategy: scoped DOM selector
 *   - extractJsonLdTheaterEvents(doc)      → reusable JSON-LD helper
 *   - OB_VENUE_CONFIGS                     → the 4 OB non-profits (added in V-T2)
 *   - writeStagingCandidate(...)           → atomic staging-file write (V-T5)
 *
 * Design notes:
 *   - Exclusion as DATA (regex[]) not lambdas. Configs are JSON-serializable
 *     for fixture replay. See feedback_test_extraction_pattern.md.
 *   - Strategies are named functions. Config row picks one via {strategy: 'link'|'selector'}.
 *   - JSON-LD helper is a one-screen utility that any future venue can call.
 *
 * Cross-validation note: scrapeVenueListing does NOT promote candidates to
 * shows.json. It writes them to data/audit/ob-venue-candidates.json. A
 * separate script (scripts/promote-ob-venue-candidates.js, V-T6b) handles
 * cross-validation against Playbill OB / Lortel before promotion.
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { fetchPage } = require('./scraper');
// Shared JSON-LD reader — handles schema.org @graph, which a hand-rolled
// `Array.isArray(x) ? x : [x]` silently misses (scripts/lib/jsonld.js).
const { parseJsonLd, hasJsonLdType } = require('./jsonld');

const STAGING_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'ob-venue-candidates.json');

// ============================================================
// OB VENUE CONFIGS (V-T2)
// ============================================================
// URLs + selectors verified 2026-05-24 by Playwright subagent.
// Adding/changing a venue: probe it, capture HTML fixture, write a
// per-venue test (tests/unit/venue-extract-<name>.test.mjs) before
// shipping the config change.
//
// Exclusion patterns are intentionally generic (membership/donate/etc.)
// — site-specific banner copy gets caught by the strategy's scopeSelector
// AND the fixture test, not by adding venue-specific regexes here.

const COMMON_OB_EXCLUDE_PATTERNS = [
  /^membership$/i, /^donate$/i, /^donate now$/i, /^login$/i, /^cart$/i,
  /^sorry/i, /^help us/i, /^access your/i,
  /^contact/i, /^subscribe/i, /^newsletter/i,
  /^learn more$/i, /^read more$/i, /^buy tickets?$/i,
  /^our (mission|team|staff|board|space|values|history)/i,
  /education program/i, /reading series/i, /staged reading/i,
  /spring gala/i, /annual gala/i, /gala benefit/i,
  /^benefit\b/i, /annual benefit/i, /fundraiser/i,
];

const OB_VENUE_CONFIGS = [
  {
    name: 'Atlantic Theater',
    url: 'https://atlantictheater.org/productions/',
    strategy: 'link',
    linkPattern: /\/production\/[a-z0-9-]+\/?$/,
    // Atlantic puts the season as header nav items (Elementor menu). The
    // scope is intentionally the nav container; linkPattern with trailing
    // anchor excludes #book and #directions fragments.
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    preferPlaywright: false,
    category: 'off-broadway',
  },
  {
    name: 'Vineyard Theatre',
    // No `www` subdomain on this URL — / and /whats-on/ return different
    // pages. /showsevents/ is the canonical season-list page.
    url: 'https://vineyardtheatre.org/showsevents/',
    strategy: 'link',
    linkPattern: /\/shows\//,
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    preferPlaywright: true,
    category: 'off-broadway',
  },
  {
    name: 'Signature Theatre',
    coversVenues: ['Pershing Square Signature Center', 'Irene Diamond Stage'],
    url: 'https://signaturetheatre.org/productions/',
    strategy: 'selector',
    // .type-event includes both upcoming (5) and past (9). Upcoming-only
    // filtering happens in the fixture test via ancestor heading; for now
    // we accept all 14 and let the cross-validation gate (V-T6b) reject
    // past shows that don't appear in Playbill/Lortel current data.
    selector: '.type-event .wp-block-post-title',
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    preferPlaywright: true,
    // networkidle times out at 45s on this page; must wait for the
    // first .type-event element to appear instead.
    playwrightWaitForSelector: '.type-event',
    category: 'off-broadway',
  },
  // ── Tier A (added 2026-05-26): SERP-verified 100% NYT review hit rate ──
  {
    name: 'Soho Rep',
    // Soho Rep features ONE current show prominently. The hero card uses
    // h1.show--title for the title and h3.show--date for the date range.
    // Some weeks they have nothing playing → 0 candidates is OK (anomaly
    // gate handles it once baseline exists).
    url: 'https://www.sohorep.org/',
    strategy: 'selector',
    selector: 'h1.show--title',
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    preferPlaywright: false,
    category: 'off-broadway',
  },
  {
    name: 'The New Group',
    // h2.obj-title appears multiple times per show (hero + list card).
    // Per-page dedup in parseVenueListingHtml collapses these.
    // IMPORTANT: TNG often plays at the Pershing Square Signature Center,
    // so canonicalVenue() in lib/title-match.js aliases "The New Group"
    // → "signature center" — same key as Signature's scrape → cross-source
    // dedupe in promote-script catches the overlap.
    url: 'https://www.thenewgroup.org/',
    strategy: 'selector',
    selector: 'h2.obj-title',
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    preferPlaywright: false,
    category: 'off-broadway',
  },
  {
    name: 'Irish Rep',
    // Venue strings this reader's listing covers (ob-venue-reader-coverage.js).
    coversVenues: ['Irish Repertory Theatre', 'Irish Repertory Studio Theatre'],
    // Root page features h1 = current show (e.g. "The Loved Ones") and
    // h2.event-card__title = upcoming/recent productions.
    // Use combined selectors; exclude_patterns filters out "GALA 2026 |..."
    // and any "raising her voice" speakers.
    url: 'https://irishrep.org/',
    strategy: 'selector',
    selector: 'h1, h2.event-card__title',
    excludeTitlePatterns: [
      ...COMMON_OB_EXCLUDE_PATTERNS,
      /^gala\b/i,                     // "GALA 2026 | ..."
      /^page not found$/i, /^home$/i, /^our mission$/i, /^box office$/i,
      /^find us$/i, /^explore$/i, /^become a member$/i, /^support /i,
      /^suggested shows$/i, /^frequently/i, /your visit$/i, /what.?s on$/i,
      /raising her voice/i, // talks/lectures, not shows
    ],
    preferPlaywright: false,
    category: 'off-broadway',
  },

  {
    name: "St. Ann's Warehouse",
    // Homepage links each current/upcoming production at /show/<slug>/.
    // WordPress + Tribe Events — plain fetch works (verified 2026-05-27,
    // ~59KB HTML). Past productions live elsewhere; the homepage shows
    // current season only, which is exactly what we want.
    url: 'https://stannswarehouse.org/',
    strategy: 'link',
    linkPattern: /\/show\/[a-z0-9-]+\/?$/,
    excludeTitlePatterns: [
      ...COMMON_OB_EXCLUDE_PATTERNS,
      /^\d{4} gala$/i, // "2026 Gala" etc. — non-show fundraisers
    ],
    preferPlaywright: false,
    category: 'off-broadway',
  },

  {
    name: 'MCC Theater',
    // TODO: this URL embeds the season year (2025-26). When MCC switches
    // to 2026-27 (typically mid-2026), update to /our-2026-27-season/.
    // The anomaly gate (V-T7) will fire when this rots → 0 shows from MCC.
    url: 'https://mcctheater.org/our-2025-26-season/',
    // Was 'selector' with .c-col-card .c-col-card__title — JSDOM silently
    // bails on the page because MCC's HTML has a `class="...""` typo
    // (extra closing quote on c-col-card divs). Switching to 'link' which
    // works on raw <a href> attributes via regex+JSDOM and tolerates the
    // malformed parent div. Show URLs: /<slug>/ and /tix/<slug>/.
    strategy: 'regex',
    linkPattern: /^https?:\/\/mcctheater\.org\/(?:tix\/)?[a-z0-9-]+\/?$/,
    // MCC's Bright Data path is variable — every 1-in-3 fetch returns a
    // stripped ~37KB cached/bot-blocked shell. Real page is ~68KB and
    // contains the season-page slug. Retry until we see it.
    flaky: true,
    minHtmlBytes: 50000,
    htmlSentinel: 'our-2025-26-season',
    excludeTitlePatterns: [
      ...COMMON_OB_EXCLUDE_PATTERNS,
      // MCC-specific noise slugs (nav, account, etc.) that share the
      // /<slug>/ shape. Match against the title (derived from slug).
      /^tix$/i, /^donate/i, /^account$/i, /^basket$/i, /^press$/i,
      /^sign up$/i, /^contact$/i, /^join us$/i, /^support$/i,
      /^our /i, /^the robert w/i, /^what we do$/i, /^who we are$/i,
      /^learning and culture$/i, /^your visit$/i, /^rent our space$/i,
      /^work with us$/i, /^privacy policy$/i,
      /^patron/i, /memberships?$/i,
    ],
    preferPlaywright: false,
    category: 'off-broadway',
  },
  // ── S5-T2 (2026-07-22): venues ranked from the late-add defect analysis
  // (scripts/lib/late-add-detector.js output; doc in claude-outputs). Both
  // venues below directly produced a real late-add gap in the corpus —
  // adding their listings closes exactly the discovery hole that caused it.
  {
    name: 'Bedlam',
    // music-city-off-broadway-2026's earliest review predated our catalog
    // clock by 491d; Bedlam's own priorRuns venue for that show was Bedlam.
    // /shows/ is Bedlam's FULL production archive (current + years of past
    // shows), not a curated current-season page — same shape as Signature's
    // .type-event (upcoming+past mixed, see above). Accept all; the existing
    // cross-validation gate (promote-ob-venue-candidates.js) rejects
    // anything not corroborated by Playbill/Lortel before promotion, so
    // historical noise never reaches shows.json.
    // KNOWN LIMITATION: Bedlam's current show (Music City, verified 2026-07-22)
    // sits at the Squarespace-default unedited slug /shows/new-portfolio-item
    // — extractByLink derives its title from the slug, so this candidate
    // surfaces as "New Portfolio Item," which won't fuzzy-title-match
    // Playbill/Lortel at the cross-validation gate. Real signal (right show,
    // wrong derived title) rather than noise; flagged here so a future
    // session doesn't waste time re-diagnosing it as a parser bug.
    url: 'https://bedlam.org/shows',
    strategy: 'link',
    linkPattern: /\/shows\/[a-z0-9-]+\/?$/,
    excludeTitlePatterns: [
      ...COMMON_OB_EXCLUDE_PATTERNS,
      /^project (one|two|three|four|five|six)\b/i, // Squarespace placeholder items, never-published slots
    ],
    preferPlaywright: false,
    category: 'off-broadway',
  },
  {
    name: "Audible's Minetta Lane Theatre",
    // sexual-misconduct-of-the-middle-classes-off-broadway-2026's earliest
    // review predated our catalog clock by 313d, at this exact venue —
    // its own listing wasn't in the discovery rotation at all.
    url: 'https://audiblexminetta.com/event-calendar',
    strategy: 'link',
    linkPattern: /shows\/[a-z0-9-]+$/,
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    preferPlaywright: false,
    category: 'off-broadway',
  },
  // ── BRO-3123 (2026-09-09): two venues whose own listing was never in the
  // discovery rotation at all — neither sells primarily through TodayTix,
  // and small/limited-run bookings there don't always reach Show Score
  // either. "The Ford/Hill Project" (BAM) and "Bigfoot Ripped My Dog In
  // Half I Saw It" (Soho Playhouse, OvationTix-only) were both missing for
  // exactly this reason before being added to shows.json by hand.
  {
    name: 'Soho Playhouse',
    // BRO-4396: switched from the homepage's /see-a-show/<slug> links to the
    // OvationTix org the venue sells every booking through
    // (ci.ovationtix.com/35583). The homepage slugs were short marketing
    // slugs ("diana-untold", "bigfoot-ripped"), so candidates carried a
    // truncated title and no dates and could only promote on a Playbill
    // match that small runs never get: 16 sat in staging until BRO-4377
    // added two by hand. OvationTix gives the full production name and every
    // performance date (verified live 2026-09-29: 32 productions).
    url: 'https://ci.ovationtix.com/35583',
    strategy: 'ovationtix',
    ovationtixClientId: 35583,
    // Fresh anomaly baseline: the OvationTix reader returns ~2x the rows the
    // homepage links did, which would trip the 2x-median gate for a week.
    anomalyKey: 'Soho Playhouse (OvationTix)',
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    preferPlaywright: false,
    category: 'off-broadway',
  },
  {
    name: 'BAM',
    // Homepage lists every current/upcoming production across all program
    // types at /<program>/<year>/<slug> — Theater's own prefix (/theater/)
    // is unique to that program, so the pattern naturally excludes BAM's
    // Dance/Opera/Music/Kids listings without a category filter. Plain
    // fetch works, no JS rendering needed (verified 2026-09-09, ~460KB
    // HTML; found /theater/2026/ford-hill-project directly). BAM sells
    // tickets through its own commerce.bam.org, invisible to
    // TodayTix/Show Score.
    url: 'https://www.bam.org/',
    strategy: 'link',
    linkPattern: /\/theater\/\d{4}\/[a-z0-9-]+\/?$/,
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    preferPlaywright: false,
    category: 'off-broadway',
  },

  // ══ BRO-4396 (2026-09-29): every venue with 2+ Off-Broadway shows since
  // 2025 that had no reader. Probed live 2026-09-29; fixtures in
  // tests/fixtures/ob-discovery/. Generic platform readers first (one org id
  // or endpoint per venue), per-site selectors only where no platform feed
  // exists. Dated readers let the venue's own listing count as evidence
  // (decideVenueListingPromotion); rows past their last date are dropped.
  //
  // ── OvationTix orgs (web.ovationtix.com public REST) ──
  { name: 'WP Theater', url: 'https://ci.ovationtix.com/34655', strategy: 'ovationtix', ovationtixClientId: 34655, excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS, category: 'off-broadway' },
  // Rental house with several rooms; one-show bookings drop out at the gate.
  { name: 'The Players Theatre', coversVenues: ['Players Theatre Loft'], url: 'https://ci.ovationtix.com/277', strategy: 'ovationtix', ovationtixClientId: 277, excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS, category: 'off-broadway' },
  { name: 'The Flea Theater', url: 'https://ci.ovationtix.com/14', strategy: 'ovationtix', ovationtixClientId: 14, excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS, category: 'off-broadway' },
  { name: 'Axis Theatre', url: 'https://ci.ovationtix.com/133', strategy: 'ovationtix', ovationtixClientId: 133, excludeTitlePatterns: [...COMMON_OB_EXCLUDE_PATTERNS, /^ztest\b/i], category: 'off-broadway' },
  { name: 'The Space at Irondale', url: 'https://ci.ovationtix.com/27285', strategy: 'ovationtix', ovationtixClientId: 27285, excludeTitlePatterns: [...COMMON_OB_EXCLUDE_PATTERNS, /^ztest\b/i, /^from the vault\b/i], category: 'off-broadway' },
  // York Theatre Company's org; it plays the Theatre at St. Jean's. The
  // "TWUSA:" rows are Theatreworks USA one-day children's shows.
  { name: "Theater at St. Jean's", coversVenues: ["Theatre at St. Jean's", 'St. Jean'], url: 'https://ci.ovationtix.com/34375', strategy: 'ovationtix', ovationtixClientId: 34375, excludeTitlePatterns: [...COMMON_OB_EXCLUDE_PATTERNS, /^twusa\b/i], category: 'off-broadway' },
  // ── Spektrix (public /api/v3/events) ──
  { name: '59E59 Theaters', url: 'https://www.59e59.org/shows/', spektrixUrl: 'https://tickets.59e59.org/59e59/api/v3/events', strategy: 'spektrix', excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS, category: 'off-broadway' },
  { name: 'Classic Stage Company', url: 'https://www.classicstage.org/', spektrixUrl: 'https://tickets.classicstage.org/classicstage/api/v3/events', strategy: 'spektrix', excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS, category: 'off-broadway' },
  // Theatre for a New Audience's account (it plays its own Polonsky
  // Shakespeare Center); test events are prefixed "zTest".
  { name: 'Polonsky Shakespeare Center', coversVenues: ['Theatre for a New Audience'], url: 'https://www.tfana.org/', spektrixUrl: 'https://tickets.tfana.org/tfana/api/v3/events', strategy: 'spektrix', excludeTitlePatterns: [...COMMON_OB_EXCLUDE_PATTERNS, /^ztest\b/i, /\bseminar\b/i, /discussion group/i], category: 'off-broadway' },
  // PAC NYC's account also sells DJ sets, talks, access services and a gala
  // (52 current events, 4 of them theatre): keep the theatre genres only.
  { name: 'Perelman Performing Arts Center', url: 'https://pacnyc.org/', spektrixUrl: 'https://system.spektrix.com/pacnyc/api/v3/events', strategy: 'spektrix', spektrixGenres: ['Theater', 'Musical Theater'], excludeTitlePatterns: [...COMMON_OB_EXCLUDE_PATTERNS, /^reading:/i], category: 'off-broadway' },
  // ── JSON APIs ──
  // NYU Skirball's WordPress 'performance' type with ACF run dates. Tags:
  // 40 theater, 42 transdisciplinary, 43 dance (the catalog carries its
  // dance: Kyle Abraham, De Keersmaeker); talks/screenings/comedy excluded.
  {
    name: 'NYU Skirball',
    url: 'https://nyuskirball.org/whats-on/',
    jsonUrl: 'https://nyuskirball.org/wp-json/wp/v2/performance?per_page=100&orderby=date&order=desc&_fields=id,title,link,meta.first_date,meta.last_date,performance_tag',
    strategy: 'json-api',
    jsonSpec: { itemsPath: '[]', titleField: 'title.rendered', firstField: 'meta.first_date', lastField: 'meta.last_date', urlField: 'link', filterField: 'performance_tag', filterAnyOf: [40, 42, 43] },
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    category: 'off-broadway',
  },
  // Repertorio's Vue site reads this PatronTicket (Salesforce) feed.
  {
    name: 'Repertorio Español',
    // Rotating repertory plus a stand-up series with the same shape (15
    // dates over five months): its listing can't tell them apart.
    selfEvidence: false,
    url: 'https://repertorio.nyc/performances',
    jsonUrl: 'https://repertorio.nyc/api/data',
    strategy: 'json-api',
    jsonSpec: { itemsPath: 'data.events[]', titleField: 'name', datesField: 'instances[].formattedDates.ISO8601', urlField: 'purchaseUrl', filterField: 'type', filterAnyOf: ['Tickets'] },
    excludeTitlePatterns: [...COMMON_OB_EXCLUDE_PATTERNS, /gift certificates?/i, /subscriptions?/i],
    category: 'off-broadway',
  },
  // ── Page-embedded data ──
  // Cherry Lane sells through a Vivenu shop; its Next.js page data lists every
  // performance (UTC; isoDay converts to the New York date).
  {
    name: 'Cherry Lane Theatre',
    url: 'https://shows.cherrylanetheatre.org/',
    strategy: 'next-data',
    jsonSpec: { itemsPath: 'props.pageProps.sellerPage.events[]', titleField: 'name', datesField: 'start' },
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    category: 'off-broadway',
  },
  // Tixr calendar: one JSON-LD Event per performance. Mostly a comedy club;
  // single stand-up nights drop out at the run-length gate.
  { name: 'Asylum NYC', selfEvidence: false, url: 'https://calendar.asylumnyc.com/', strategy: 'json-ld', excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS, category: 'off-broadway' },
  // ── Dated cards on the venue's own page ──
  {
    name: 'New Victory Theater',
    url: 'https://www.newvictory.org/tickets-and-events',
    strategy: 'dated-selector',
    // Public live runs only: school-day and sensory-friendly duplicates,
    // workshops and teacher labs share the grid.
    itemSelector: 'a.event-item[href*="-live-performance-"]:not([href$="-sensory-friendly"])',
    titleSelector: '.event-item__title',
    dateSelector: '.event-item__date',
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    category: 'off-broadway',
  },
  {
    name: 'HERE Arts Center',
    url: 'https://here.org/shows/',
    strategy: 'dated-selector',
    itemSelector: '.wrap-collabsible',
    titleSelector: '.lbl-toggle',
    dateSelector: '.supporting-info',
    excludeTitlePatterns: [...COMMON_OB_EXCLUDE_PATTERNS, /season$/i, /kick-?off party/i, /^urhere$/i, /^choose wonder\b/i],
    category: 'off-broadway',
  },
  {
    name: 'New York City Center',
    // Mostly dance companies and comedy beside Encores! and the Stage II
    // plays; the catalog carries none of the dance companies.
    selfEvidence: false,
    url: 'https://www.nycitycenter.org/tickets',
    strategy: 'dated-selector',
    itemSelector: 'a.event-item',
    titleSelector: '.event-item__title',
    dateSelector: '.event-item__date',
    excludeTitlePatterns: [...COMMON_OB_EXCLUDE_PATTERNS, /^studio 5\b/i],
    category: 'off-broadway',
  },
  {
    name: 'Studio Seaview',
    url: 'https://studioseaview.com/whats-on/',
    strategy: 'dated-selector',
    itemSelector: '.site-events__card',
    titleSelector: '.site-events__card-title',
    dateSelector: '.site-events__card-inner__content-dates',
    linkSelector: 'a[href*="/show/"]',
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    category: 'off-broadway',
  },
  {
    name: 'New York Theatre Workshop',
    // Season URL embeds the season; the anomaly gate fires when it rots.
    url: 'https://www.nytw.org/2026-27-season/',
    strategy: 'dated-selector',
    itemSelector: '.show_box',
    titleSelector: '.show_name',
    dateSelector: '.show_dates',
    // Co-productions play the partner's house (The Grief Eater Near North
    // Bender, "in association with Roundabout", is at the Laura Pels and is
    // read there).
    itemMustNotMatch: /produced in association with/i,
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    category: 'off-broadway',
  },
  {
    name: 'A.R.T./New York Theatres',
    coversVenues: ['Jeffrey and Paula Gural Theatre', 'A.R.T./New York'],
    url: 'https://art-newyork.org/spaces/theatres/now-playing/',
    strategy: 'dated-selector',
    itemSelector: '.sugar-calendar-event-list-block__listview__event',
    titleSelector: '.sugar-calendar-event-list-block__event__title',
    dateSelector: '.sugar-calendar-event-list-block__event__datetime',
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    category: 'off-broadway',
  },
  {
    name: 'Laura Pels Theatre',
    // Roundabout's page lists all its houses, Broadway included (Studio 54,
    // Todd Haimes): keep cards that name the Laura Pels.
    url: 'https://www.roundabouttheatre.org/shows',
    strategy: 'dated-selector',
    itemSelector: '.wp-block-roundabout-production',
    itemMustMatch: /laura-pels/i,
    titleSelector: '.production__title',
    dateSelector: '.production__date-display',
    excludeTitlePatterns: COMMON_OB_EXCLUDE_PATTERNS,
    category: 'off-broadway',
  },
  {
    name: 'Lincoln Center Theater',
    // Exact houses only: "... at Lincoln Center" venues (David Geffen Hall,
    // the Rose Theater) are not this listing.
    coverageExact: ['Lincoln Center Theater - Mitzi E. Newhouse Theater', 'Mitzi E. Newhouse Theater', 'LCT3 at the Claire Tow Theater', 'Claire Tow Theater', 'Lincoln Center Theater'],
    // Newhouse and Claire Tow only (the Beaumont is a Broadway house). The
    // cards carry start labels, not ranges, so these rows need a second
    // source (Playbill/TheaterMania) to promote.
    url: 'https://www.lct.org/shows/',
    strategy: 'dated-selector',
    itemSelector: '.main-text-content > article',
    itemMustMatch: /newhouse|claire tow/i,
    titleSelector: 'a.title',
    dateSelector: '.show-dates',
    excludeTitlePatterns: [...COMMON_OB_EXCLUDE_PATTERNS, /season$/i],
    category: 'off-broadway',
  },
  // ── New York Theatre Guide venue pages ──
  // Rental houses with no listing of their own, and venues whose sites sit
  // behind a bot challenge this reader cannot pass (The Public, Park Avenue
  // Armory, Theatre Row's Ludus). An editorial listing, dated.
  ...[
    ['The Public Theater', ['public-theater'], ["Joe's Pub", 'Delacorte Theater']],
    ['Lucille Lortel Theatre', ['lucille-lortel-theatre']],
    ['New World Stages', ['new-world-stages']],
    ['Daryl Roth Theatre', ['daryl-roth-theatre'], ['DR2 Theatre']],
    ['Greenwich House Theater', ['greenwich-house-theater']],
    ['Park Avenue Armory', ['park-avenue-armory'], null, { selfEvidence: false }],
    ['Playwrights Horizons', ['playwrights-horizons']],
    ['92NY', ['92ny-buttenwieser-hall']],
    // Only Theatres Three and Four have NYTG pages; the coverage report must
    // not count Theatre Five (or One, Two, Six) as read.
    ['Theatre Row', ['theatre-row-theatre-three', 'theatre-row-theatre-four'], null, { coverageExact: ['Theatre Row - Theatre Three', 'Theatre Row - Theatre Four', 'Theatre Row (Theatre Three)', 'Theatre Row (Theatre Four)', 'Theatre Three at Theatre Row', 'Theatre Four at Theatre Row', 'Theatre Row – Theater Four', 'Theatre Row – Theatre Three'] }],
    ['The Ruby Theatre', ['ruby-theatre']],
    ['Orpheum Theatre', ['orpheum-theatre']],
    ['The Marjorie S. Deane Little Theater', ['the-marjorie-s-deane-little-theater']],
    // "West End Theatre" normalizes to "west end", which build-ob-venues.js
    // blocklists (London), so its rows can only promote on a TheaterMania
    // or Playbill match, never on this listing alone.
    ['West End Theatre', ['the-west-end-theatre']],
    ['Astor Place Theatre', ['astor-place-theatre']],
    ['The Duke on 42nd Street', ['duke-on-42nd-street']],
    // The Theater Center's two houses (Anne L. Bernstein, Jerry Orbach).
    ['The Theater Center', ['the-theater-center', 'jerry-orbach-theatre'], ['Jerry Orbach Theatre']],
    ["Theatre at St. Clement's", ['theatre-at-st-clements']],
    ['Westside Theatre', ['westside-theatre']],
    ['Stage 42', ['stage-42']],
    ['East Village Basement', ['east-village-basement']],
  ].map(([name, nytgSlugs, coversVenues, extra]) => ({
    name,
    ...(coversVenues ? { coversVenues } : {}),
    ...(extra || {}),
    url: `https://www.newyorktheatreguide.com/venues/${nytgSlugs[0]}`,
    strategy: 'nytg-venue',
    nytgSlugs,
    excludeTitlePatterns: [...COMMON_OB_EXCLUDE_PATTERNS, /\btours?$/i],
    category: 'off-broadway',
  })),
];

// ============================================================
// OFF-WEST END DATED READERS (BRO-4398)
// ============================================================
// London venues read through the same dated readers as the OB pool
// (ob-listing-platforms.js). discover-new-shows.js's OWE fan-out uses one of
// these in place of the venue's slug-title link reader in VENUE_LISTING_PAGES
// (same `name`, so promote-owe-venue-candidates.js finds the venue either
// way), and reads the ones with no link reader directly. Dated rows let the
// OWE promoter accept the venue's own listing as evidence of a run
// (decideVenueListingPromotion), which an undated slug title never could.
//
// Spektrix clients were read from each site's ticketing markup
// (client-name / custom-domain attributes, or the /api/v3 base URL in its
// scripts) and probed live 2026-09-30. `spektrixInstances` adds the
// per-event performance count from /api/v3/instances, which is what tells
// a four-week run from a monthly club night on these mixed-program accounts.
//
// Not read here (probed 2026-09-30): Marylebone Theatre (its
// JSON-LD event list stops at 2025 productions; link reader stays), The
// Other Palace, Donmar
// Warehouse and Royal Court (403 to plain HTTP; Royal Court is also
// catalogued West End), Soho Theatre (1,515 Spektrix events, almost all
// stand-up), Theatre503 (courses and one-nighters; none catalogued) and
// Barbican (see LONDON_NO_READER_REASONS in ob-venue-reader-coverage.js).

// Spektrix accounts sell add-ons and access services as events. Each
// pattern names a row seen on a London account on 2026-09-30.
const LONDON_SPEKTRIX_EXCLUDE_PATTERNS = [
  /^\*/,                                                         // Park: "**The Pianist Programme", "*Drinks"
  /\bprogrammes?\b|\bplaytext\b|\bcast album\b|\bbundle\b/i,     // Southwark: "... Playtext", "... Bundle"
  /touch tour|audio descri|caption|assisted listening|headset/i, // access services
  /\bdrinks\b|\bpizzas?\b|pre-?order|ice cream|\bmerch/i,        // bar/food pre-orders
  /secure my booking|gift (?:voucher|card)|\bmembership\b|\bdonat/i,
  /backstage tours?\b|\btheatre tours?\b|walking tours?\b/i,       // Almeida "Theatre Tour", Finborough walks
  /\btest (?:event|show)\b|\b(?:priority|web|booking) test\b|^z?test\b/i, // "Tfg Test Event", Young Vic "Temporary Priority Test"
  /\b(?:online )?course\b|\bintensive\b|\bmaster ?class\b|\bworkshops?\b/i, // Theatre503/Riverside classes
  /\bscratch nights?\b|\br&d\b|\bsharing\)?$/i,                  // Lyric/Riverside works in development
  /\bin conversation\b|\bq ?& ?a\b|\bbook signing\b/i,
  /^for the culture:/i,                                          // Lyric's one-night festival strand
  /\bon screen\b|\bnt live\b/i,                                  // Orange Tree streams, Kiln/Riverside broadcasts
  /^winner of\b/i,                                               // Park: "Winner of the 2026 Papatango New Writing Prize" (title TBA)
];
const LONDON_OWE_EXCLUDE_PATTERNS = [...COMMON_OB_EXCLUDE_PATTERNS, ...LONDON_SPEKTRIX_EXCLUDE_PATTERNS];
// Add-ons flagged by the account itself (Kiln, Young Vic).
const SPEKTRIX_SUPPLEMENTARY = { attribute_SupplementaryEvent: /^true$/i };

const OWE_VENUE_CONFIGS = [
  // ── Spektrix ──
  { name: 'Theatre Royal Stratford East', url: 'https://www.stratfordeast.com/whats-on', spektrixUrl: 'https://tickets.stratfordeast.com/stratfordeast/api/v3/events', spektrixInstances: true, strategy: 'spektrix', excludeTitlePatterns: [...LONDON_OWE_EXCLUDE_PATTERNS, /^ses\b/i], category: 'off-west-end' },
  // Kiln runs a cinema on the same account (films, NT Live): theatre only.
  { name: 'Kiln Theatre', url: 'https://kilntheatre.com/whats-on/', spektrixUrl: 'https://tickets.kilntheatre.com/tricycle/api/v3/events', spektrixInstances: true, spektrixGenreField: 'attribute_Type', spektrixGenres: ['Theatre'], spektrixExclude: SPEKTRIX_SUPPLEMENTARY, strategy: 'spektrix', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
  { name: 'Southwark Playhouse', url: 'https://southwarkplayhouse.co.uk/', spektrixUrl: 'https://system.spektrix.com/southwarkplayhouse/api/v3/events', spektrixInstances: true, strategy: 'spektrix', excludeTitlePatterns: [...LONDON_OWE_EXCLUDE_PATTERNS, /writers collective/i], category: 'off-west-end' },
  { name: 'Orange Tree Theatre', url: 'https://www.orangetreetheatre.co.uk/whats-on/', spektrixUrl: 'https://tickets.orangetreetheatre.co.uk/orangetree/api/v3/events', spektrixInstances: true, strategy: 'spektrix', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
  // Park sells stand-up, music and kids' clubs on the same account.
  // coverageExact: "Park" alone would also claim Regent's Park Open Air
  // Theatre and Troubadour Wembley Park in the coverage report.
  { name: 'Park Theatre', coverageExact: ['Park Theatre', 'Park90', 'Park200'], url: 'https://parktheatre.co.uk/whats-on/', spektrixUrl: 'https://tickets.parktheatre.co.uk/parktheatre/api/v3/events', spektrixInstances: true, spektrixGenreField: 'attribute_Genre', spektrixGenres: ['Drama', 'Comedy', 'Musicals'], strategy: 'spektrix', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
  { name: 'Bush Theatre', url: 'https://www.bushtheatre.co.uk/whats-on/', spektrixUrl: 'https://tickets.bushtheatre.co.uk/bushtheatre/api/v3/events', spektrixInstances: true, strategy: 'spektrix', excludeTitlePatterns: [...LONDON_OWE_EXCLUDE_PATTERNS, /^alt b:/i], category: 'off-west-end' },
  { name: 'Arcola Theatre', url: 'https://www.arcolatheatre.com/whats-on/', spektrixUrl: 'https://boxoffice.arcolatheatre.com/arcolatheatre/api/v3/events', spektrixInstances: true, spektrixGenreField: 'attribute_Genre', spektrixGenres: ['Theatre'], strategy: 'spektrix', excludeTitlePatterns: [...LONDON_OWE_EXCLUDE_PATTERNS, /\bayt\b/i], category: 'off-west-end' },
  { name: "King's Head Theatre", url: 'https://kingsheadtheatre.com/whats-on/', spektrixUrl: 'https://tickets.kingsheadtheatre.com/kingsheadtheatre/api/v3/events', spektrixInstances: true, spektrixExclude: { attribute_LiveOnWebsite: /^false$/i }, strategy: 'spektrix', excludeTitlePatterns: [...LONDON_OWE_EXCLUDE_PATTERNS, /\badult$/i], category: 'off-west-end' },
  { name: 'Lyric Hammersmith', url: 'https://lyric.co.uk/whats-on/', spektrixUrl: 'https://tickets.lyric.co.uk/lyrichammersmith/api/v3/events', spektrixInstances: true, strategy: 'spektrix', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
  // Young Vic's Shedinburgh strand is a festival of one-nighters in The Maria.
  { name: 'Young Vic', coversVenues: ['The Maria Theatre', 'Young Vic (Main House)'], url: 'https://www.youngvic.org/whats-on', spektrixUrl: 'https://system.spektrix.com/youngvic/api/v3/events', spektrixInstances: true, spektrixExclude: { ...SPEKTRIX_SUPPLEMENTARY, attribute_Festival: /\S/ }, strategy: 'spektrix', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
  // Mostly cinema, classes and wellness: theatre only.
  { name: 'Riverside Studios', url: 'https://riversidestudios.co.uk/whats-on/', spektrixUrl: 'https://spektrix.riversidestudios.co.uk/riversidestudios/api/v3/events', spektrixInstances: true, spektrixGenreField: 'attribute_EventType', spektrixGenres: ['Theatre'], strategy: 'spektrix', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
  { name: 'Bridge Theatre', url: 'https://bridgetheatre.co.uk/', spektrixUrl: 'https://tickets.bridgetheatre.co.uk/bridgetheatrelondon/api/v3/events', spektrixInstances: true, strategy: 'spektrix', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
  // Rose Theatre Kingston's account also sells workshops, tribute acts,
  // touring family shows and offers: its own Drama web category only.
  { name: 'Rose Theatre Kingston', url: 'https://www.rosetheatre.org/whats-on', spektrixUrl: 'https://tickets.rosetheatre.org/rosetheatrekingston/api/v3/events', spektrixInstances: true, spektrixGenreField: 'attribute_WebCategory', spektrixGenres: ['Drama'], strategy: 'spektrix', excludeTitlePatterns: [...LONDON_OWE_EXCLUDE_PATTERNS, /\btest\b/i], category: 'off-west-end' },
  // Wilton's sells film-with-live-score nights, music hall, magic, opera
  // and heritage tours alongside its theatre.
  { name: "Wilton's Music Hall", url: 'https://wiltons.org.uk/whats-on/', spektrixUrl: 'https://tickets.wiltons.org.uk/wiltons/api/v3/events', spektrixInstances: true, spektrixGenreField: 'attribute_GenresForWebsiteFiltering', spektrixGenres: ['Theatre', 'Musical Theatre', 'New Writing', 'Family'], stripMonthYearTags: true, strategy: 'spektrix', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
  // ── Ticketsolve ──
  { name: 'Waterloo East Theatre', url: 'https://www.waterlooeast.co.uk/', ticketsolveUrl: 'https://waterlooeast.ticketsolve.com/shows.xml', ticketsolveExcludeCategory: /showcase|workshop|class|course/i, strategy: 'ticketsolve', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
  // ── JSON-LD ──
  // Menier: Event nodes in the homepage @graph, one per run.
  { name: 'Menier Chocolate Factory', url: 'https://www.menierchocolatefactory.com/', strategy: 'json-ld', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
  // ── Dated cards (UK day-first dates) ──
  // datedOnly: an undated card on these pages is a promo for another house
  // (New Diorama's Operation Mincemeat) or a walk/talk strand (Finborough).
  { name: 'Almeida Theatre', url: 'https://almeida.co.uk/whats-on/', strategy: 'dated-selector', dayFirst: true, datedOnly: true, itemSelector: '.c-event-card', titleSelector: '.c-event-card__title', dateSelector: '.c-event-card__daterange', linkSelector: 'a.c-event-card__permalink', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
  { name: 'New Diorama Theatre', url: 'https://www.newdiorama.com/whats-on', strategy: 'dated-selector', dayFirst: true, datedOnly: true, itemSelector: 'figure', titleSelector: 'figcaption h2', dateSelector: 'figcaption h3', linkSelector: 'a[href*="/whats-on/"]', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
  // One card per booking block: a run split over two blocks (What The
  // Animals Say, 29 Sep-24 Oct and 27 Oct-21 Nov) merges to one row.
  // Hampstead sells through Tessitura (no public feed); its what's-on cards
  // carry "Dates: 28 Aug – 7 Nov 2026".
  { name: 'Hampstead Theatre', url: 'https://www.hampsteadtheatre.com/whats-on/', strategy: 'dated-selector', dayFirst: true, datedOnly: true, itemSelector: '.card', titleSelector: '.card__heading', dateSelector: '.card__dates', linkSelector: 'a[href*="/production/"]', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
  // One page for both Troubadour houses: keep the Wembley Park cards.
  { name: 'Troubadour Wembley Park Theatre', url: 'https://www.troubadourtheatres.com/whats-on/', strategy: 'dated-selector', dayFirst: true, datedOnly: true, itemSelector: '.c-featured-event', itemMustMatch: /Wembley/, titleSelector: 'h3', dateSelector: '.c-featured-event__details__discription', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
  { name: 'Finborough Theatre', url: 'https://www.finboroughtheatre.co.uk/', strategy: 'dated-selector', dayFirst: true, datedOnly: true, itemSelector: 'a.production-card', titleSelector: 'h3', dateSelector: 'div.text-2xl.text-center', excludeTitlePatterns: LONDON_OWE_EXCLUDE_PATTERNS, category: 'off-west-end' },
];

// ============================================================
// PURE PARSING
// ============================================================

/**
 * Parse a venue listing page's HTML into candidate objects.
 * Pure: no fetch, no IO. Fixture-testable.
 */
const { foldDiacritics } = require('./title-match');
const { ROMAN_NUMERALS } = require('./title-display-case');
const {
  parseOvationTixBundle,
  parseTribeEvents,
  extractDatedJsonLdEvents,
  extractDatedCards,
  fetchOvationTixBundle,
  fetchTribeEvents,
  fetchSpektrixEvents,
  parseSpektrixEvents,
  parseTicketsolveShows,
  extractJsonItems,
  extractNextData,
  parseNytgVenuePages,
  getJson,
  NYTG_BASE,
} = require('./ob-listing-platforms');

// Strategies whose payload is JSON from a ticketing/CMS API, not a page.
// venue-listing-discover.test.mjs replays these from .json fixtures.
const DATED_JSON_STRATEGIES = new Set(['ovationtix', 'tribe-events', 'spektrix', 'json-api']);
// Strategies scrapeVenueListing fetches from their own feed URL rather than
// venue.url: the JSON ones plus Ticketsolve's shows.xml (BRO-4433 ship-check:
// discover-new-shows.js gated on DATED_JSON_STRATEGIES alone and fetched the
// Waterloo East homepage instead of its feed).
// A booking tagged with its month and two-digit year: "Romeo and Juliet -
// Oct26", "The Law of Mayhem Apr27", "Wolf Country Jan 27" (Wilton's Music
// Hall's Spektrix names). Per venue (stripMonthYearTags), never global: a
// title can end in a date ("Halloween Oct 31"), BRO-4433 ship-check.
const MONTH_YEAR_TAG_RE = /\s+(?:-\s+)?(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec) ?[23]\d$/;
const FEED_STRATEGIES = new Set([...DATED_JSON_STRATEGIES, 'ticketsolve']);

function parseVenueListingHtml(venue, html, { todayIso = new Date().toISOString().slice(0, 10) } = {}) {
  // Dated platform readers (BRO-4396) take a JSON payload (object or string)
  // instead of HTML; everything else is an HTML page.
  const isJsonStrategy = DATED_JSON_STRATEGIES.has(venue.strategy);
  if (!isJsonStrategy && (!html || typeof html !== 'string' || html.length < 50)) return [];
  if (isJsonStrategy && !html) return [];

  // rows: [{title, firstDate?, lastDate?, performanceCount?, url?}]
  let rows;
  // `regex` strategy bypasses JSDOM entirely for sites that ship malformed
  // HTML which silently breaks the parser (MCC Theater has a `class=""`
  // typo on .c-col-card divs that makes JSDOM skip the whole subtree —
  // anchors inside become invisible to querySelectorAll).
  if (venue.strategy === 'regex') {
    rows = extractByRegex(html, venue).map(title => ({ title }));
  } else if (isJsonStrategy) {
    let payload = html;
    if (typeof payload === 'string') {
      try { payload = JSON.parse(payload); } catch { return []; }
    }
    if (venue.strategy === 'ovationtix') rows = parseOvationTixBundle(payload, { clientId: venue.ovationtixClientId });
    else if (venue.strategy === 'spektrix') rows = parseSpektrixEvents(payload, { genres: venue.spektrixGenres, genreField: venue.spektrixGenreField, exclude: venue.spektrixExclude, todayIso });
    else if (venue.strategy === 'json-api') rows = extractJsonItems(payload, venue.jsonSpec);
    else rows = parseTribeEvents(payload);
  } else if (venue.strategy === 'ticketsolve') {
    rows = parseTicketsolveShows(html, { todayIso, excludeCategory: venue.ticketsolveExcludeCategory });
  } else if (venue.strategy === 'nytg-venue') {
    rows = parseNytgVenuePages(html);
  } else if (venue.strategy === 'next-data') {
    const data = extractNextData(html);
    rows = data ? extractJsonItems(data, venue.jsonSpec) : [];
  } else {
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    switch (venue.strategy) {
      case 'link':
        rows = extractByLink(doc, venue).map(title => ({ title }));
        break;
      case 'selector':
        rows = extractBySelector(doc, venue).map(title => ({ title }));
        break;
      case 'json-ld':
        rows = extractDatedJsonLdEvents(doc);
        break;
      case 'dated-selector':
        rows = extractDatedCards(doc, venue, { todayIso });
        break;
      default:
        throw new Error(`Unknown venue.strategy: ${venue.strategy} for ${venue.name}`);
    }
  }

  // Apply exclusion patterns (DATA not functions) + length bounds.
  const excludePatterns = venue.excludeTitlePatterns || [];
  const seen = new Set();
  const filtered = [];
  for (const r of rows) {
    let title = String((r && r.title) || '').replace(/\s+/g, ' ').trim();
    if (venue.stripMonthYearTags) title = title.replace(MONTH_YEAR_TAG_RE, '').trim();
    if (title.length < 2 || title.length > 160) continue;
    if (excludePatterns.some(p => p.test(title))) continue;
    if (seen.has(title)) continue; // dedupe within page
    // A dated row that already finished is archive, not a current booking.
    if (r.lastDate && r.lastDate < todayIso) continue;
    if (venue.datedOnly && !r.firstDate && !r.lastDate) continue;
    seen.add(title);
    filtered.push({ ...r, title });
  }

  return filtered.map(r => ({
    title: r.title,
    venue: venue.name,
    // Apostrophes dropped, not split ("Violet's" → violets), as catalog ids are.
    slug: foldDiacritics(r.title).toLowerCase().replace(/['‘’]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    category: venue.category || 'off-broadway',
    source: `venue-page:${venue.name.toLowerCase().replace(/\s+/g, '-')}`,
    discoveredAt: new Date().toISOString(),
    // The venue's own dates for this booking (BRO-4396). Only dated readers
    // set them; decideVenueListingPromotion needs both to treat the listing
    // as its own evidence.
    ...(r.firstDate ? { listingFirstDate: r.firstDate } : {}),
    ...(r.lastDate ? { listingLastDate: r.lastDate } : {}),
    ...(typeof r.performanceCount === 'number' ? { listingPerformanceCount: r.performanceCount } : {}),
    ...(r.genre ? { listingGenre: r.genre } : {}),
    ...(r.url ? { listingUrl: absoluteUrl(r.url, venue.url) } : {}),
    // OvationTix only returns performances still on sale, so its first date
    // is the NEXT performance, not the first one (ship-check 2026-09-29: Elf
    // Lyons began 2026-09-24, OvationTix said 2026-10-01).
    ...(r.firstDate && venue.strategy === 'ovationtix' ? { listingFirstDateIsNext: true } : {}),
    // Ticketsolve's shows.xml likewise drops past performances: a run whose
    // first listed day has arrived may have started earlier (BRO-4433).
    ...(r.firstDate && venue.strategy === 'ticketsolve' && r.firstDate <= todayIso ? { listingFirstDateIsNext: true } : {}),
    // NYTG is an editorial listing, not the venue's box office, and its
    // closing date for an open-ended run is a booking horizon (Gazillion
    // Bubble Show: 2007 to 2027-01-18), so it never becomes closingDate.
    // Only a long run's date is treated as a horizon; a limited run's end
    // date is its closing.
    ...(venue.strategy === 'nytg-venue' ? { listingEvidence: 'editorial-listing' } : {}),
    ...(venue.strategy === 'nytg-venue' && r.firstDate && r.lastDate && (Date.parse(r.lastDate) - Date.parse(r.firstDate)) > 180 * 86400000 ? { listingLastDateIsHorizon: true } : {}),
    // Mixed-program venues (dance companies, stand-up, installations beside
    // the plays): their own listing is not evidence that a row is a play, so
    // their candidates need Playbill/TheaterMania to promote.
    ...(venue.selfEvidence === false ? { listingEvidence: 'needs-corroboration' } : {}),
  }));
}

function absoluteUrl(href, base) {
  try { return new URL(href, base).toString(); } catch { return href; }
}

// ============================================================
// STRATEGIES
// ============================================================

/**
 * Strategy 'link': find anchors whose href matches venue.linkPattern.
 * Title comes from the URL slug (kept simple; OWE venues already use this).
 * If venue.scopeSelector is set, search only within that container — prevents
 * sitewide-selector leak (e.g., footer nav anchors).
 */
function extractByLink(doc, venue) {
  if (!venue.linkPattern) throw new Error(`extractByLink: venue ${venue.name} missing linkPattern`);
  const root = venue.scopeSelector ? doc.querySelector(venue.scopeSelector) : doc;
  if (!root) return []; // scope not found → empty (likely 404 / page rot)

  const seen = new Set();
  const titles = [];
  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href') || '';
    if (!venue.linkPattern.test(href)) continue;
    // Skip navigation/category pages
    if (/\/(past-shows|access|account|login|logout|search|tag|category|page\/)/i.test(href)) continue;
    // Derive title from slug
    const slug = href.split('#')[0].split('?')[0].split('/').filter(Boolean).pop() || '';
    if (!slug || slug.length < 3) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const title = slugToTitle(slug);
    titles.push(title);
  }
  return titles;
}

/**
 * "indian-princesses" → "Indian Princesses", "richard-ii" → "Richard II".
 * Plain capitalising stored "Richard Ii" as the show title (BRO-4563).
 */
function slugToTitle(slug) {
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\b[a-z]+\b/gi, w => (ROMAN_NUMERALS.has(w.toLowerCase()) ? w.toUpperCase() : w));
}

/**
 * Strategy 'selector': find elements via venue.selector, take textContent.
 * If venue.scopeSelector is set, restrict to that container.
 */
/**
 * Strategy 'regex': bypasses JSDOM entirely. Extract hrefs matching
 * venue.linkPattern from raw HTML via regex, derive title from the
 * last path segment (same as link strategy). Useful when the page has
 * malformed HTML that silently breaks JSDOM (see MCC).
 */
function extractByRegex(html, venue) {
  if (!venue.linkPattern) throw new Error(`extractByRegex: venue ${venue.name} missing linkPattern`);
  const hrefRe = /href\s*=\s*["']([^"']+)["']/gi;
  const seen = new Set();
  const titles = [];
  let m;
  while ((m = hrefRe.exec(html)) !== null) {
    const href = m[1];
    if (!venue.linkPattern.test(href)) continue;
    const slug = href.split('#')[0].split('?')[0].replace(/\/$/, '').split('/').pop() || '';
    if (!slug || slug.length < 3) continue;
    if (seen.has(slug)) continue;
    seen.add(slug);
    const title = slugToTitle(slug);
    titles.push(title);
  }
  return titles;
}

function extractBySelector(doc, venue) {
  if (!venue.selector) throw new Error(`extractBySelector: venue ${venue.name} missing selector`);
  const root = venue.scopeSelector ? doc.querySelector(venue.scopeSelector) : doc;
  if (!root) return [];

  const titles = [];
  for (const el of root.querySelectorAll(venue.selector)) {
    const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) titles.push(t);
  }
  return titles;
}

/**
 * Reusable JSON-LD TheaterEvent extractor. Returns the raw parsed objects
 * with @type === 'TheaterEvent'. Caller picks fields (name/startDate/location).
 * Future venues with structured data should prefer this over selector hacks.
 */
function extractJsonLdTheaterEvents(doc) {
  const events = [];
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const items = parseJsonLd(script.textContent);
      for (const item of items) {
        // hasJsonLdType covers @type as a string OR an array of strings —
        // sites like LondonTheatre.co.uk emit `@type: ["Event","TheaterEvent"]`.
        if (hasJsonLdType(item, 'TheaterEvent') && !item.subEvent) events.push(item);
      }
    } catch { /* malformed JSON-LD blocks are skipped */ }
  }
  return events;
}

// ============================================================
// FETCH + PARSE + STAGING WRAPPER
// ============================================================

/**
 * Fetch the venue page (Playwright if preferPlaywright), parse, return
 * candidates. Does NOT write to staging by itself — caller decides.
 */
async function scrapeVenueListing(venue) {
  const opts = {};
  if (venue.preferPlaywright) opts.preferPlaywright = true;
  if (venue.playwrightWaitForSelector) opts.playwrightWaitForSelector = venue.playwrightWaitForSelector;

  // Some venues (notably MCC Theater) are flaky behind Bright Data — every
  // 1-in-3 fetch returns a stripped 37KB cached/bot-blocked shell instead
  // of the real ~68KB page. Retry up to 3 times with backoff if either:
  // (a) the HTML is suspiciously short (< minHtmlBytes), OR
  // (b) parsing returns 0 candidates AND we have a sentinel string that
  //     must appear in the real page (venue.htmlSentinel).
  if (venue.strategy === 'ovationtix') {
    const bundle = await fetchOvationTixBundle(venue.ovationtixClientId);
    return parseVenueListingHtml(venue, bundle);
  }
  if (venue.strategy === 'tribe-events') {
    const json = await fetchTribeEvents(venue.url);
    return parseVenueListingHtml(venue, json);
  }
  if (venue.strategy === 'spektrix') {
    return parseVenueListingHtml(venue, await fetchSpektrixEvents(venue.spektrixUrl, { instances: !!venue.spektrixInstances, timeoutMs: venue.spektrixTimeoutMs }));
  }
  if (venue.strategy === 'json-api') {
    return parseVenueListingHtml(venue, await getJson(venue.jsonUrl));
  }
  if (venue.strategy === 'ticketsolve') {
    return parseVenueListingHtml(venue, await getJson(venue.ticketsolveUrl, { raw: true }));
  }
  if (venue.strategy === 'nytg-venue') {
    // One page per slug (Theatre Row's rooms each have their own), joined:
    // parseNytgVenuePages reads every __NEXT_DATA__ block in the string.
    const pages = [];
    for (const slug of venue.nytgSlugs) {
      const r = await fetchPage(`${NYTG_BASE}${slug}`, {});
      if (r && r.content) pages.push(r.content);
      else console.warn(`::warning::venue ${venue.name}: NYTG page ${slug} fetch returned empty content`);
    }
    return parseVenueListingHtml(venue, pages.join('\n'));
  }

  const maxAttempts = venue.flaky ? 3 : 1;
  const minHtmlBytes = venue.minHtmlBytes || 0;
  let html = '';
  let candidates = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fetchPage(venue.url, opts);
    html = result?.content || '';
    if (!html) {
      console.warn(`::warning::venue ${venue.name}: fetch returned empty content (attempt ${attempt}/${maxAttempts})`);
      if (attempt < maxAttempts) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
      return [];
    }
    const tooSmall = minHtmlBytes > 0 && html.length < minHtmlBytes;
    const sentinelMissing = venue.htmlSentinel && !html.includes(venue.htmlSentinel);
    if (tooSmall || sentinelMissing) {
      console.warn(`::warning::venue ${venue.name}: ${tooSmall ? `html ${html.length} < ${minHtmlBytes}` : `sentinel "${venue.htmlSentinel}" missing`} (attempt ${attempt}/${maxAttempts})`);
      if (attempt < maxAttempts) { await new Promise(r => setTimeout(r, 2000 * attempt)); continue; }
    }
    candidates = parseVenueListingHtml(venue, html);
    break;
  }
  return candidates;
}

/**
 * Promise.allSettled over `items` with at most `limit` units in flight,
 * results in input order (BRO-4396). `laneOf(item)` puts items in a named
 * lane that runs as ONE unit, its items one after another: every OvationTix
 * org shares a lane so that API sees a single caller (back-to-back parallel
 * calls drew 403s).
 */
async function settledWithConcurrency(items, limit, fn, { laneOf } = {}) {
  const results = new Array(items.length);
  const units = [];
  const lanes = new Map();
  items.forEach((item, i) => {
    const lane = laneOf ? laneOf(item) : null;
    if (!lane) { units.push([i]); return; }
    if (!lanes.has(lane)) { lanes.set(lane, []); units.push(lanes.get(lane)); }
    lanes.get(lane).push(i);
  });
  let next = 0;
  async function worker() {
    while (next < units.length) {
      const unit = units[next++];
      for (const i of unit) {
        try { results[i] = { status: 'fulfilled', value: await fn(items[i], i) }; }
        catch (reason) { results[i] = { status: 'rejected', reason }; }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, units.length)) }, worker));
  return results;
}

// ============================================================
// STAGING (V-T5 — atomic candidate file)
// ============================================================

const crypto = require('crypto');
const { withFileLock } = require('./file-lock');

function candidateHash({ title, venue }) {
  const norm = `${(title || '').toLowerCase().trim()}|${(venue || '').toLowerCase().trim()}`;
  return crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

function loadStaging(stagingPath = STAGING_PATH) {
  try {
    const text = fs.readFileSync(stagingPath, 'utf8');
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}

/**
 * BRO-4484: the read half of updateStaging. Unlike loadStaging (lenient, for
 * readers), an existing file that does not parse as an array returns null so
 * updateStaging refuses to rewrite it: writing a mutation of "[]" over a
 * corrupt or conflict-marked file reads, at push time, as a prune of every
 * row (the staging merge is three-way and honours prunes). A missing file is
 * a genuine empty staging list.
 */
function loadStagingForUpdate(stagingPath = STAGING_PATH) {
  let text;
  try {
    text = fs.readFileSync(stagingPath, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    return null;
  }
  try {
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/**
 * Atomic write — tmp file + rename. Prevents half-written staging on crash.
 * tmp name is PID-scoped so two concurrent writers (even ones NOT going
 * through updateStaging's lock — e.g. a caller mid-migration to it) can't
 * clobber each other's in-flight tmp file.
 *
 * `stagingPath` defaults to the real STAGING_PATH; every call site below
 * threads its own override through (or omits one) — it exists so
 * venue-listing-discover.test.mjs can exercise the real locked
 * read-modify-write against a scratch file instead of the committed
 * data/audit/ob-venue-candidates.json.
 */
function writeStaging(entries, stagingPath = STAGING_PATH) {
  fs.mkdirSync(path.dirname(stagingPath), { recursive: true });
  const tmp = `${stagingPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2));
  fs.renameSync(tmp, stagingPath);
}

/**
 * Locked read-modify-write for the staging file (BRO-158, the #788 class).
 *
 * This file has 4 independent producers — discover-new-shows.js's OB venue
 * fan-out, add-requested-show.js, extract-aggregator-candidates.js, and
 * promote-ob-venue-candidates.js's post-promotion prune — each doing its own
 * read-modify-write with no coordination. Two producers running close
 * together (a manual add-requested-show.yml dispatch overlapping the hourly
 * scrape, or a slow promote run still fetching Playbill/Lortel while a fresh
 * discover-new-shows.js run lands) is a classic lost-update race: whichever
 * writes last wins and silently drops the other's candidates. This is the
 * same shape as #893/#923 (show-review-gap.json) — same fix, same helper
 * (scripts/lib/file-lock.js's withFileLock), applied here as its own lock
 * file rather than sharing gap-audit-merge.js's, since the two guard
 * unrelated files.
 *
 * `mutateFn` is called with the CURRENT on-disk entries, read fresh AFTER
 * the lock is acquired — never a snapshot a caller read before a long fetch
 * — so callers that need to filter/prune (promote-ob-venue-candidates.js,
 * extract-aggregator-candidates.js) must express the removal as a predicate
 * over candidateHash rather than writing back a pre-computed array; see
 * those call sites. writeStaging only runs if mutateFn returns without
 * throwing, so a mutateFn error leaves the on-disk file untouched instead of
 * reverting valid concurrent updates.
 *
 * Fails open (same as withFileLock generally): if the lock can't be
 * acquired within the timeout, the read-modify-write still runs, just
 * unprotected — a warning is logged rather than blocking the caller forever.
 *
 * `stagingPath` overrides both STAGING_PATH and its lock file (defaults to
 * the real STAGING_PATH); see writeStaging's docstring for why it exists.
 *
 * @param {(current: object[]) => object[]} mutateFn
 * @param {string} [stagingPath]
 * @returns {object[]} the entries actually written
 */
function updateStaging(mutateFn, stagingPath = STAGING_PATH) {
  const lockPath = `${stagingPath}.lock`;
  let lockHeld = false;
  const next = withFileLock(lockPath, (held) => {
    lockHeld = held;
    const current = loadStagingForUpdate(stagingPath);
    if (current === null) {
      console.error(`::error::ob-venue-candidates staging file ${stagingPath} exists but is not a JSON array — refusing to rewrite it (BRO-4484: a rewrite would prune every row at push time). Fix or restore the file.`);
      return [];
    }
    const updated = mutateFn(current);
    writeStaging(updated, stagingPath);
    return updated;
  });
  if (!lockHeld) {
    console.warn('::warning::ob-venue-candidates staging lock could not be acquired (assumed stale/unwritable) — the read-modify-write ran unprotected. A concurrent producer could have lost data.');
  }
  return next;
}

/**
 * Insert-or-update candidates by hash. Existing entries with the same hash
 * are replaced (refreshes discoveredAt + evidence); new ones are appended.
 */
function writeStagingCandidates(newCandidates, stagingPath = STAGING_PATH) {
  return updateStaging((existing) => {
    const byHash = new Map(existing.map(e => [e.candidateHash, e]));
    for (const c of newCandidates) {
      const h = candidateHash(c);
      byHash.set(h, { ...c, candidateHash: h });
    }
    return [...byHash.values()];
  }, stagingPath);
}

module.exports = {
  STAGING_PATH,
  DATED_JSON_STRATEGIES,
  FEED_STRATEGIES,
  OB_VENUE_CONFIGS,
  OWE_VENUE_CONFIGS,
  COMMON_OB_EXCLUDE_PATTERNS,
  LONDON_SPEKTRIX_EXCLUDE_PATTERNS,
  parseVenueListingHtml,
  scrapeVenueListing,
  settledWithConcurrency,
  extractByLink,
  extractBySelector,
  extractByRegex,
  slugToTitle,
  extractJsonLdTheaterEvents,
  writeStagingCandidates,
  writeStaging,
  loadStaging,
  updateStaging,
  candidateHash,
};
