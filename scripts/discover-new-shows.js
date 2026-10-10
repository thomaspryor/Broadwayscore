#!/usr/bin/env node
/**
 * Broadway New Show Discovery
 *
 * Discovers new Broadway shows by unioning TodayTix API + the Playbill
 * "Schedule of Upcoming and Announced Broadway Shows" article — both run
 * every pass, not source-B-only-if-source-A-returns-nothing. The prior
 * Broadway.org scraper was wired as `if (discoveredShows.length === 0)`;
 * TodayTix reliably returns ~40+ shows, so that branch never actually ran —
 * dead code that looked like redundancy while Broadway discovery quietly
 * depended on TodayTix alone for months (card #1445). Removed rather than
 * revived: it was also Cloudflare-blocked more often than not, so making it
 * a real always-on union source would have added telemetry noise without
 * real coverage. Per-source contribution counts are recorded every run to
 * data/audit/discovery-source-coverage.json (scripts/lib/discovery-source-coverage.js)
 * so a source going silent is a detected defect, not silent rot.
 *
 * scripts/check-broadway-source-coverage.js is the independent check that
 * this union itself isn't missing shows: it diffs the same Playbill
 * schedule against shows.json and alerts on anything Playbill has that we
 * don't.
 *
 * IMPORTANT — WE/London date handling:
 * TodayTix and Official London Theatre (OLT) return `startDate` = first preview/performance,
 * NOT the press night (opening night for critics). For all London discovery paths, set:
 *   openingDate: null,
 *   previewsStartDate: startDate
 * The real openingDate is set later by ShowScore press night data or manual enrichment.
 * Broadway shows use IBDB for dates, so this doesn't apply to BW paths.
 *
 * Usage: node scripts/discover-new-shows.js [--dry-run] [--include-off-broadway] [--include-west-end]
 *        [--tm-page-budget=N]   Theatremonkey show pages fetched per run for venues (default 20; env TM_VENUE_PAGE_BUDGET)
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { JSDOM } = require('jsdom');
const { fetchPage, cleanup } = require('./lib/scraper');
const { parseShortDate, venueFromShowScoreDoc } = require('./lib/show-score-status');
const { checkKnownShow, detectPlayFromTitle } = require('./lib/known-shows');
const { writeClosingDate } = require('./lib/closing-date-guard');
const { slugify, checkForDuplicate, findSameTitleTwinIfNoOpeningDate } = require('./lib/deduplication');
const { computeShowReconciliation, resolveReconciliationFields, appendReconciliationAudit } = require('./lib/discovery-reconcile');
const { validateChangeStability } = require('./lib/change-stability-guard');
const { classifyTodayTixStartDate, unconfirmedStartFlags, productionIdYear } = require('./lib/todaytix-dates');
const { batchLookupIBDBDates, checkIBDBForPriorProductions } = require('./lib/ibdb-dates');
const { ibdbYearMismatch, expectedShowYear } = require('./lib/ibdb-year-guard');
const { getTheaterAddress } = require('./lib/venue-addresses');
const { withMarketSuffix } = require('./lib/market-slug');
const { cleanSearchTitle } = require('./lib/title-normalization');
const { splitCombinedCredits } = require('./lib/credit-splitting');
const { verifyCreativeTeamViaSerp } = require('./lib/creative-team-verify');
const { scrapeCurrentRuntimes, matchRuntimesToShows, batchScrapeAgeRecommendations } = require('./lib/broadway-com-runtimes');
const { classifyGenre, applyGenreCategoryOverride } = require('./lib/genre-classification');
const { isLondonMarket, isOffWestEndVenue, isWestEndVenue, isKnownOffBroadwayVenue, isNonNycVenue, isNonTheatreVenue, isLondonReceivingHouse, isBroadwayCategory, sanitizeVenueForWrite } = require('./lib/venue-classification');
const { BROADWAY_THEATERS, normalizeVenueName: normalizeBroadwayVenue } = require('./lib/broadway-theaters');
const showsWriteGuard = require('./lib/shows-write-guard');
const { fetchTmOffBroadway, parseTmOffBroadwayRow, findTmSameTitleShow } = require('./lib/theatermania-ob');
const { loadPendingAddShows } = require('./lib/pending-add-shows');
const { matchesRetired } = require('./lib/retired-show-ids');
const { decidePrematurePreviews } = require('./lib/premature-previews');

// Tags each candidate with which discovery source produced it (BRO-2072) so
// reconcileMatchedShow() below can require multi-source agreement before
// trusting a venue/date patch. Internal field only — never copied into
// shows.json (showEntry is built field-by-field) and stripped from the
// pending-review JSON alongside the other `_`-prefixed internal fields.
function tagSource(shows, sourceLabel) {
  for (const s of shows) {
    if (!s._discoverySource) s._discoverySource = sourceLabel;
  }
  return shows;
}

function isoDateOrNull(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed.toISOString().split('T')[0];
}

// The id (and the ISO dates it derives from) a candidate WOULD mint. Computed
// ONCE at the top of the candidate loop (2026 data audit, S0-T3) so the
// retired-id refusal there and the row actually written further down can
// never disagree about the id — a second copy of this arithmetic is exactly
// how a "retired" id would quietly mint under a slightly different name.
// Pure: no shows.json access, no side effects. Exported for the unit test.
//
// Year rule — use the production's own year for the ID. Order matters:
// openingDate, then previewsStartDate, then the quarantined
// unconfirmedStartDate, and only then fall back to "now".
//
// The `now.getFullYear()` fallback is the third link in the 2027-Encores!
// chain (2026-08-12). A season announced 6-10 months out reaches here with
// openingDate null (see classifyTodayTixStartDate), so every 2027 show was
// minted as `<slug>-off-broadway-2026`. That is both wrong on its face and
// self-blocking: "You're a Good Man, Charlie Brown" (Feb 2027) generated the
// SAME id as the 92NY production that ran in March 2026, so the ID-collision
// guard in the loop dropped it even after the twin guard was taught to let
// it through. A date we don't trust enough to gate reviews on is still
// plenty good enough to name a row.
//
// Slug rule — market-aware. withMarketSuffix() strips any pre-existing market
// suffix before re-appending — idempotent, so a title/slug that already
// carries the suffix (e.g. round-tripped through another discovery path)
// doesn't get it appended a second time, which used to produce IDs like
// `beetlejuice-the-musical-west-end-west-end-2026` (BRO-3237).
//
// Provisional year (BRO-4204 S5-T4). When NO date names the production the
// year falls back to the current year — and that is where the audit's 22
// wrong-year ids came from: a source (TodayTix, a venue season page, the
// Playbill schedule) listed the title before any date, the row was minted as
// `<slug>-2026`, the dates arrived through enrichment months later saying
// 2027, and nothing ever renamed the id. The fallback itself is still the
// right call (a dateless announcement must get SOME id), so instead of
// changing it we stamp `idYearProvisional: true` on the minted row. That is
// the breadcrumb validate-data's id-year-drift WARN reports and the S8-T1
// rename tool can key on: a provisional year that later disagrees with the
// dates is a rename candidate, a deliberate year is not.
function mintCandidateId(show, now = new Date()) {
  const openingDate = isoDateOrNull(show.openingDate);
  const closingDate = isoDateOrNull(show.closingDate);
  const previewsStartDate = isoDateOrNull(show.previewsStartDate);
  const datedYear = productionIdYear({ openingDate, previewsStartDate, unconfirmedStartDate: show.unconfirmedStartDate });
  const idYearProvisional = !datedYear;
  const idYear = datedYear || String(now.getFullYear());
  const marketSlug = withMarketSuffix(slugify(show.title), show.category);
  return { openingDate, closingDate, previewsStartDate, idYear, idYearProvisional, marketSlug, showId: `${marketSlug}-${idYear}` };
}

// Strict exact-match set of the 41 official Broadway houses (canonical + aliases),
// normalized. We deliberately do NOT use broadway-theaters' isOfficialBroadwayTheater
// here: its findTheater() does loose substring matching (great for resolving a
// known shows.json venue, wrong for discovery), which false-positives "Lotte New
// York Palace Hotel" → Palace Theatre and "Laura Pels Theatre" (an OB house).
const BROADWAY_HOUSE_NAMES = new Set();
for (const t of Object.values(BROADWAY_THEATERS)) {
  if (t.canonical) BROADWAY_HOUSE_NAMES.add(normalizeBroadwayVenue(t.canonical));
  for (const alias of t.aliases || []) BROADWAY_HOUSE_NAMES.add(normalizeBroadwayVenue(alias));
}
const { classifyShow } = require('./lib/classify-show');
const { titleSaysMusical } = require('./lib/title-says-musical');
const { scrapePlaybillOBData, checkSilentRot } = require('./lib/playbill-ob-schedule');
const { scrapePlaybillBroadwayData, checkSilentRot: checkBroadwaySilentRot, titleCaseFromAllCaps } = require('./lib/playbill-broadway-schedule');
const { normalizeShowTitle, buildVenueVocabulary } = require('./lib/show-title-normalize');
const {
  OB_VENUE_CONFIGS,
  OWE_VENUE_CONFIGS,
  DATED_JSON_STRATEGIES,
  FEED_STRATEGIES,
  parseVenueListingHtml,
  scrapeVenueListing,
  settledWithConcurrency,
  writeStagingCandidates,
} = require('./lib/venue-listing-discover');
const {
  writeStagingCandidates: writeOweStagingCandidates,
} = require('./lib/owe-venue-staging');
const { checkVenueAnomaly } = require('./lib/venue-anomaly');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');
const { validateOne: validatePlaybillProduction } = require('./validate-show-venue');
const { buildExistingTitleMap, detectRevivalByTitleCrossReference, shouldAcceptIbdbRevival } = require('./lib/revival-cross-reference');

const { hasHelpFlag } = require('./lib/cli-help.js');
// Shared JSON-LD reader — handles schema.org @graph, which a hand-rolled
// `Array.isArray(x) ? x : [x]` silently misses (scripts/lib/jsonld.js).
const { parseJsonLd, hasJsonLdType } = require('./lib/jsonld');
// OLT listing reader shared with scripts/enrich-west-end-dates.js (audit S7-T10).
const { parseOltTheaterEvents, extractJsonLdBlocks } = require('./lib/olt-enrichment');
// S4-T5 (2026 data audit, BRO-4204): per-source last-success markers and the
// Theatremonkey show-page venue resolver (pure decision logic in the lib, §15).
const { recordParseResult } = require('./lib/source-last-success');
const {
  TM_INDEX_URL, titleKey, parseTheatremonkeyIndex, extractTheatremonkeyVenue, extractTheatremonkeyDates,
  parseVenuePageBudget, loadVenueCache, saveVenueCache, planVenueFetches, recordVenueResult,
} = require('./lib/theatremonkey-venue');
const { findConflictingShowId } = require('./lib/show-score-url-map');
const { gateScrapedSynopsis, truncateAtSentence } = require('./lib/synopsis-fact-check');

const USAGE = `discover-new-shows.js — Broadway New Show Discovery.

Usage:
  node scripts/discover-new-shows.js [options]
  node scripts/discover-new-shows.js --help, -h    print this usage and exit
`;

// --help/-h checked before any real work (cousin of #260/#263/#264/#266 — see scripts/lib/cli-help.js).
if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }
const SHOWS_FILE = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'new-shows-pending.json');

const dryRun = process.argv.includes('--dry-run');
const includeOffBroadway = process.argv.includes('--include-off-broadway');
const includeWestEnd = process.argv.includes('--include-west-end');
const consumeShowScoreCandidates = process.argv.includes('--consume-show-score-candidates');
const verbose = process.argv.includes('--verbose');

// Wall-clock budget (task #438, same class as #369/#415/#421): under slow/
// degraded scraping tiers this script has no bound on its own and runs to the
// workflow's 45-min step timeout, which SIGKILLs the process and loses ALL
// discovered results instead of committing partial progress. Disabled unless
// --time-budget-min=N is passed. See scripts/lib/run-budget.js.
const timeBudget = createRunBudget(parseTimeBudgetMin(process.argv.slice(2)));

const CANDIDATES_PATH = path.join(__dirname, '..', 'data', 'show-score-candidates.json');
const URLS_PATH = path.join(__dirname, '..', 'data', 'show-score-urls.json');

// Non-theater content patterns — shared across all markets (Broadway, OB, West End)
const NON_THEATER_PATTERNS = [
  'comedy club', 'comedy night', 'stand-up', 'standup',
  'magic show:', 'magick', 'bubble show', // NOT 'magic' alone (false-positive: Magic Mike, The Magic Show, Magic/Bird)
  'orchestra', 'symphony', 'symphonic', 'philharmonic', 'chamber music',
  'quintet', 'ensemble', // NOT 'quartet' alone (false-positive: Million Dollar Quartet — corpus-audited, task BRO-181)
  'the metropolitan opera', // Met Opera productions (Turandot, La Boheme, etc.)
  'royal opera', 'opera house', // London opera
  'selected shorts', 'book club', 'in conversation with',
  'nt live:', 'london\'s west end:',
  'dance company', 'dance +', 'ballet',
  'lottery', 'accessible lottery',
  'meet the music', 'lyrics & lyricists',
  'uptown showdown', 'amateur night',
  'flamenco festival',
  // NOT bare 'circus' alone (BRO-2662: matched "The Secret Circus Musical",
  // a live tracked Off-Broadway musical currently in previews). No safe
  // multi-word replacement exists either — unlike 'gala'/'tour', "circus" as
  // a genre has no noise-vs-signal split by title shape: real tracked shows
  // are titled "Cirque du Soleil Paramour" (Broadway musical),
  // "Cirque Berserk", "Scrooge: Cirque Extravaganza", "Cirque Alice" (West
  // End/Off-West End plays) — any "cirque"/"circus"-branded multi-word
  // pattern collides with one of these. Genuine non-theatrical circus
  // listings from TodayTix are already routed correctly downstream via
  // show.todayTixCategory === 'Circus and Magic' (see type-detection below),
  // so no title-substring gate is needed for that source. No historical log
  // of the noise titles this bare token was originally added to catch
  // exists, so it's removed rather than replaced with a guessed list.
  'in concert', 'concert performance',
  'company xiv', // burlesque/cabaret company
  'rakugo', // Japanese storytelling
  'museum of', 'exhibit', 'exhibition', // museums/exhibits, not shows
  'immersive experience', // non-theatrical experiences
  'game show', 'gameshow', 'punishment game', // game shows (BATSU etc.)
  'jazz at lincoln center', // jazz concerts, not theater
  'convention', 'festival of', // festivals/conventions (Breakin' Convention etc.)
  // Non-profit OB venue page noise: galas, fundraisers, readings, education
  // programs. Use multi-word phrases only — a plain 'gala' substring
  // matches "Via Galactica" (1972 Broadway show) via " gala" → " gala"-ctica.
  // Patterns added when wiring Atlantic/Vineyard/Signature/MCC venue pages —
  // their season pages list these alongside mainstage shows.
  'spring gala', 'annual gala', 'gala benefit', 'gala fundraiser',
  'benefit reading', 'benefit performance', 'annual benefit',
  'reading series', 'staged reading',
  'fundraiser', 'fundraising',
  'donor event', 'donor reception',
  'education program', 'student showcase',
];

// Junk-title shapes from the 2026 data audit (BRO-4204 S4-T6): festivals,
// panels / Q&As, NT Live cinema screenings, prize nights, comedy previews,
// work-in-progress nights, venue "events" listings and sports double-headers.
// A word-anchored regex rather than more NON_THEATER_PATTERNS substrings so
// 'festival' cannot hit "Festen" and 'panel' cannot hit "Panelbeater".
// Concert-tour titles ("Rachel Zegler – Live in London", "X in Concert") added
// after the S4-T5 Theatremonkey dry-run admitted one at @sohoplace; 0 tracked
// titles match either form (corpus check 2026-09-28).
// Corpus-checked 2026-09-28 against every title in shows.json (3,073 rows):
// each token hits only the audit's junk rows (Kilburn High Road Festival,
// Migrant Qa Panel, Nt Live All My Sons 12a Tbc, Stiles Drewe Best New Song
// Prize 2026, Edinburgh Fringe Comedy Previews, Rosie Jones: Anyone But Me
// (WIP), Bar Events, Barbarians v Wales Double Header) and nothing tracked.
const NON_THEATRE_TITLE_RE = /^nt live\b|\blive in (?:london|new york|concert)\b|\bin concert\b|\bfestival\b|\bpanel\b|\bq ?& ?a\b|\bqa\b|\bscreening\b|\bprize\b|\(wip\)|\bwork[- ]in[- ]progress\b|\bcomedy previews\b|\bfringe previews\b|\bdouble header\b|^(?:bar|venue|special) events\b/i;

// TodayTix top-level categories that are never a staged production. Checked
// on the raw TodayTix object (`show.category.name`); the same value is written
// to shows.json as `todayTixCategory`. "Concerts" is how Betty Buckley at Joe's
// Pub and Harry Connick Jr. at Carnegie Hall reached the Off-Broadway list.
// "Events" is deliberately NOT here: on the live NYC feed it also carries NYU
// Skirball's international theatre (Milo Rau, Romeo Castellucci, Dead Centre,
// Manual Cinema), which the NYT reviews — and the owner's rule (2026 audit,
// D3) is to keep anything that gets or might get reviewed. Junk that rides
// "Events" still falls to the title regex, the venue gate and the one-night gate.
const NON_THEATRE_TODAYTIX_CATEGORIES = new Set(['Concerts', 'Landmarks', 'Films', 'Conversations']);

// TodayTix categories that vouch for a listing at a non-theatre venue: a
// TodayTix Off-Broadway row at Radio City / Carnegie Hall / 54 Below is
// admitted only when TodayTix itself tags it Plays or Musicals (owner rule,
// 2026 audit). London paths do not get this override — see isNonTheaterContent.
const STAGED_PRODUCTION_CATEGORIES = new Set(['Plays', 'Musicals']);

// West End-specific additional patterns — shared by TodayTix London, OLT, and ShowScore candidate processing
const WE_EXTRA_PATTERNS = [
  'dining experience', 'candlelight', 'by candlelight',
  'discovering dinosaurs', 'prehistoric planet',
  // REMOVED 2026-08-26 (BRO-181 corpus audit): 'classic penguins' matched
  // "Garry Starr: Classic Penguins", now a tracked Off-Broadway play
  // (garry-starr-classic-penguins-off-broadway-2026) — the fringe-act
  // assumption in the original comment no longer holds.
];

/**
 * Title-only gate for the London listing feeds (OLT, Theatremonkey) that reach
 * shows.json without going through isNonTheaterContent(): the two substring
 * lists those loops always applied PLUS NON_THEATRE_TITLE_RE. Until 2026-09-29
 * the regex only ran inside isNonTheaterContent(), so "Rachel Zegler – Live in
 * London" (@sohoplace, a real theatre) was minted as a West End play — the
 * venue gates passed and nothing looked at the title (audit S8-T2, BRO-4204).
 * Pure: exported for tests/unit/discover-new-shows-gates.test.mjs.
 */
function londonListingTitleRejected(title) {
  const t = String(title || '').toLowerCase();
  if (!t) return false;
  if (NON_THEATER_PATTERNS.some(p => t.includes(p))) return true;
  if (WE_EXTRA_PATTERNS.some(p => t.includes(p))) return true;
  return NON_THEATRE_TITLE_RE.test(t);
}
// REMOVED 2026-07-31: WE_SOLO_PERFORMER_PATTERN (/^(?!(?:The|A|An) )[A-Z][a-z]+ [A-Z][a-z]+$/,
// "FirstName LastName" ⇒ skip as a presumed solo concert). Audited against the live
// TodayTix London catalog (282 shows): every post-category-filter hit was a real
// production — Space Dogs, Kimberly Akimbo, Miss Saigon, Jane Eyre, Twelfth Night,
// Nine Night, Martin Guerre, Hay Fever… — because plays are routinely titled after
// their protagonist, which is indistinguishable from a performer name. 9 of those
// titles were absent from the catalog entirely (Space Dogs reached opening night
// unlisted, owner-reported). Actual concerts are already excluded by the TodayTix
// category filter, NON_THEATER_PATTERNS, and isOneNightShow. Do not reintroduce a
// person-name-shaped title filter; see scripts/discover-new-shows.test.mjs.

// Known non-show titles that TodayTix lists but aren't theatrical productions
const EXCLUDED_TITLES = [
  'the museum of broadway',
  'batsu!', // restaurant game show at Kogame
  'jeremy pelt and endea owens', // Jazz at Lincoln Center concert
  'caribbean crossroads', // Jazz at Lincoln Center concert
  'lindy west: adult braces', // Symphony Space author reading
  'dave eggers: contrapposto', // Symphony Space author reading
  'percival everett: james', // Symphony Space author reading
  'abby jimenez: the night we met', // Symphony Space author reading
  'caro claire burke: yesteryear', // Symphony Space author reading
  'the pelicot trial', // One-night event at church
  'turandot', // Met Opera
  'madama butterfly', // Met Opera
  'la boheme', // Met Opera (also matches "La Bohème" after normalization)
];

// Venues that categorically do not host theater
const NON_THEATER_VENUES = [
  'kogame',           // restaurant (BATSU game show)
  'appel room',       // Jazz at Lincoln Center
  'rose theater',     // Jazz at Lincoln Center (review feedback: shortened for robustness)
];

// Check if a show is a one-night event (startDate === endDate)
// Only applied to TodayTix ingestion, not IBDB historical data
function isOneNightShow(show) {
  if (!show.startDate || !show.endDate) return false;
  // TodayTix returns the literal string "null" (not JSON null) for shows
  // without confirmed run dates yet — "null" === "null" made every
  // not-yet-on-sale announced show look like a one-night event and get
  // filtered before ever reaching the dedup/new-show pipeline (Gap B, card
  // #1446: Mix and Master, The Full Monty, Warriors, Three Days of Rain were
  // all real full Broadway/Off-Broadway runs filtered this way).
  //
  // The one place "null" dates DO mean a one-off booking is a non-theatre
  // venue (2026 audit, BRO-4204 S4-T8): a Carnegie Hall / Royal Albert Hall /
  // 54 Below listing with no run dates is a single concert or cabaret night,
  // not a not-yet-on-sale production, so the skip fires there and only there.
  // A "null"-dated listing at a theatre keeps the #1446 behaviour.
  if (show.startDate === 'null' || show.endDate === 'null') return isNonTheatreVenue(show.venue);
  return show.startDate === show.endDate;
}

// Validate TodayTix startDate against ID recycling. TodayTix sometimes reuses
// show IDs for new productions, returning a future date that looks legitimate
// but is months off from the actual current production. Caused Pen Pals
// (Aug 2025 listed vs Jan 2025 actual, 8 months off) and Take Me Out
// (Nov 2022 listed vs Apr 2022 actual, 7 months off) to break the pre-opening
// guard and exclude valid reviews.
//
// The trust window and the quarantine field now live in
// scripts/lib/todaytix-dates.js, shared with enrich-todaytix-data.js so
// existing shows get the same treatment new ones do. See that file for why the
// date is quarantined rather than dropped (the 2027 Encores! cascade).
function sanitizeTodayTixDate(startDate, showTitle) {
  return classifyTodayTixStartDate(startDate, showTitle).previewsStartDate;
}

// The admission rule this enforces is written up in docs/show-inclusion-policy.md
// (2026 data audit, BRO-4204). `show` is TodayTix-shaped (displayName,
// subcategories, venue as string or { name }, category { name }, description);
// the Playbill / ShowScore paths synthesize that shape before calling.
//
// `market` is 'london' on the London discovery paths and 'nyc' (default)
// otherwise. It changes exactly one gate: a non-theatre venue match rejects
// outright in London, but in NYC is overridden when TodayTix tags the row
// Plays or Musicals (a staged production booked into Radio City or Carnegie
// Hall — Les Misérables: The Arena Concert Spectacular is the reviewed case).
function isNonTheaterContent(show, { market = 'nyc' } = {}) {
  const title = (show.displayName || show.name || '').toLowerCase();
  if (EXCLUDED_TITLES.some(excluded => title.includes(excluded))) return true;
  if (NON_THEATER_PATTERNS.some(pattern => title.includes(pattern))) return true;
  if (NON_THEATRE_TITLE_RE.test(title)) return true; // festival / panel / screening / Q&A / prize / WIP titles
  const subcatNames = (show.subcategories || []).map(sc => sc.name);
  if (subcatNames.includes('Classical')) return true; // Opera

  // Gate 1b: TodayTix top-level category — Concerts, Landmarks, Films and
  // Conversations are never staged productions, whatever the venue.
  if (NON_THEATRE_TODAYTIX_CATEGORIES.has(show.category?.name)) return true;

  // Gate 2: Venue blocklist — categorically non-theater venues
  const venue = (typeof show.venue === 'string' ? show.venue : show.venue?.name || '').toLowerCase();
  if (NON_THEATER_VENUES.some(v => venue.includes(v))) return true;

  // Gate 3: Stadiums, arenas, concert halls, cabaret rooms (NON_THEATRE_VENUE_RE,
  // scripts/lib/venue-classification.js). London: reject outright. NYC: admit
  // only when TodayTix tags the row Plays or Musicals. A production critics
  // review at one of these still gets in via the aggregator promoters, which
  // never consult this gate (the safety valve).
  if (isNonTheatreVenue(show.venue)) {
    if (market === 'london') return true;
    if (!STAGED_PRODUCTION_CATEGORIES.has(show.category?.name)) return true;
  }

  // Gate 3b: Greater London receiving houses (Hackney Empire, New Wimbledon
  // Theatre…) list UK tour stops, not London productions. London paths only.
  if (market === 'london' && isLondonReceivingHouse(show.venue)) return true;

  // Gate 4: Synopsis keywords — catches shows with clean titles but non-theater descriptions
  const description = (show.description || '').toLowerCase();
  const SYNOPSIS_KEYWORDS = ['game show', 'punishment game', 'jazz at lincoln center'];
  if (SYNOPSIS_KEYWORDS.some(kw => description.includes(kw))) return true;

  return false;
}

// Extra fields for a TodayTix OB show pulled in WITHOUT the "Off Broadway"
// subcategory (i.e. rescued by the venue-name fallback). That's a lower-
// confidence inference — we're overriding TodayTix's missing tag from our own
// venue list — so mark it provisional + a distinct discoverySource. This routes
// it through validate-show-venue.js --all-provisional for a Playbill cross-check
// before the venue/date are trusted (CLAUDE.md §3). Subcat-tagged shows are
// TodayTix's own authoritative classification and get no flags.
function obFallbackFlags(show) {
  const taggedOB = show.subcategories?.some(sc => sc.name === 'Off Broadway');
  if (taggedOB) return {};
  return { provisional: true, discoverySource: 'todaytix-venue-fallback' };
}

// Resolves a TodayTix-shaped show object's venue (string or { name }) through
// sanitizeVenueForWrite, returning null when it's a placeholder/neighbourhood
// blob rather than resurrecting one via `|| 'TBA'`. TodayTix's venue field is
// not guaranteed to be a real venue name — it returned "Soho/Tribeca" for
// Jest to Impress, which every prior call site here wrote straight into
// shows.json unguarded (card #994 S0 remainder: the guard must cover every
// writer, not just the ShowScore-scrape path traced in S0-T2).
function resolveTodayTixVenue(show) {
  const raw = typeof show.venue === 'string' ? show.venue : show.venue?.name;
  return sanitizeVenueForWrite(raw);
}

// True when a TodayTix venue (string or { name }) is one of the 41 official
// Broadway houses. Lets discovery rescue Broadway shows TodayTix lists without
// the "Broadway" subcat (e.g. Other Desert Cities @ Hudson Theatre, 2026-05-29).
function isBroadwayHouse(venue) {
  const name = typeof venue === 'string' ? venue : venue?.name;
  if (!name || name === 'TBA') return false;
  return BROADWAY_HOUSE_NAMES.has(normalizeBroadwayVenue(name));
}

// Same as obFallbackFlags but for Broadway: a show rescued by the venue-house
// match (no "Broadway" subcat) is a lower-confidence inference, so flag it
// provisional for IBDB/Playbill cross-validation. Subcat-tagged Broadway shows
// are TodayTix's own authoritative classification and get no flags.
function bwayFallbackFlags(show) {
  const taggedBway = show.subcategories?.some(sc => sc.name === 'Broadway');
  if (taggedBway) return {};
  return { provisional: true, discoverySource: 'todaytix-venue-fallback' };
}

// TodayTix API - public, no auth required, no Cloudflare
function fetchTodayTixPage(offset = 0, limit = 100) {
  return new Promise((resolve, reject) => {
    const url = `https://api.todaytix.com/api/v2/shows?location=1&limit=${limit}&offset=${offset}`;
    const req = https.get(url, { timeout: 15000 }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`TodayTix API HTTP ${response.statusCode}`));
        response.resume();
        return;
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Failed to parse TodayTix API response')); }
      });
      response.on('error', reject);
    }).on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TodayTix API request timed out')); });
  });
}

async function fetchShowsFromTodayTix() {
  console.log('Fetching Broadway shows from TodayTix API...');
  const allShows = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await fetchTodayTixPage(offset, limit);
    if (!response.data || response.data.length === 0) break;
    allShows.push(...response.data);
    if (allShows.length >= (response.pagination?.total || 0)) break;
    offset += limit;
  }

  // Filter by subcategories: Broadway always, Off-Broadway when flag is set
  // Gate 1: One-night shows are filtered at TodayTix ingestion (not IBDB historical)
  const broadwayShows = allShows.filter(s => {
    if (isNonTheaterContent(s) || isOneNightShow(s)) return false;
    if (isNonNycVenue(s.venue)) return false; // touring house in TodayTix's NYC feed (BRO-3211)
    // TodayTix mis-tags some Broadway shows (no "Broadway" subcat). Fall back to
    // venue: if it plays one of the 41 official Broadway houses, include it.
    // Other Desert Cities (Hudson Theatre) slipped through on subcat alone.
    return s.subcategories?.some(sc => sc.name === 'Broadway') || isBroadwayHouse(s.venue);
  });
  const offBroadwayShows = includeOffBroadway ? allShows.filter(s => {
    if (s.subcategories?.some(sc => sc.name === 'Broadway')) return false; // exclude shows tagged as both
    // TodayTix mis-tags some OB shows (no "Off Broadway" subcat). Fall back to
    // venue name: if it plays a theatre we already classify as Off-Broadway,
    // include it. Broken Snow (Theatre 71) slipped through on subcat alone.
    // Checked BEFORE taggedOB: TodayTix tags out-of-state touring houses
    // "Off Broadway" (Beetlejuice @ State Theatre New Jersey, verified against
    // the live API 2026-09-14), so the tag cannot be trusted to exclude them
    // and the venue-allowlist fallback below never gets a chance to. BRO-3211.
    if (isNonNycVenue(s.venue)) return false;
    const taggedOB = s.subcategories?.some(sc => sc.name === 'Off Broadway');
    if (!taggedOB && !isKnownOffBroadwayVenue(s.venue)) return false;
    return !isNonTheaterContent(s) && !isOneNightShow(s);
  }) : [];

  // Log filtered shows for CI visibility
  const filteredByContent = allShows.filter(s => isNonTheaterContent(s));
  const filteredByOneNight = allShows.filter(s => !isNonTheaterContent(s) && isOneNightShow(s));
  if (filteredByContent.length > 0) {
    console.log(`  Filtered ${filteredByContent.length} non-theater content: ${filteredByContent.slice(0, 5).map(s => s.displayName || s.name).join(', ')}${filteredByContent.length > 5 ? '...' : ''}`);
  }
  if (filteredByOneNight.length > 0) {
    console.log(`  Filtered ${filteredByOneNight.length} one-night events: ${filteredByOneNight.map(s => s.displayName || s.name).join(', ')}`);
  }
  // Non-NYC touring houses (BRO-3211). Logged even at zero: this guard is the
  // only thing standing between a TodayTix row tagged "Off Broadway" at an
  // out-of-state venue and a bogus Off-Broadway production, and it matches the
  // venue by name. If TodayTix ever renames the venue the guard silently stops
  // matching, so a run that prints 0 here when the road date is still listed is
  // the signal that it has drifted — without the line there is no evidence either way.
  const filteredByNonNyc = allShows.filter(s => isNonNycVenue(s.venue));
  console.log(`  Filtered ${filteredByNonNyc.length} non-NYC touring-house shows${filteredByNonNyc.length ? `: ${filteredByNonNyc.map(s => `${s.displayName || s.name} @ ${s.venue?.name || s.venue}`).join(', ')}` : ''}`);

  // Deduplicate by displayName (API sometimes has duplicate listings)
  const seen = new Set();
  const showsList = [];
  for (const show of broadwayShows) {
    const title = (show.displayName || show.name || '').trim();
    if (!title || title.length < 3 || seen.has(title)) continue;
    seen.add(title);

    // TodayTix startDate = first preview, NOT opening night. Treat as
    // previewsStartDate; IBDB enrichment (runs later in update-show-status.yml)
    // fills in the real openingDate.
    const bwayStart = classifyTodayTixStartDate(show.startDate, title);

    // Same leak as the OB loop below: TodayTix's venue field can be a
    // placeholder/blob, not just missing (card #1060, Broadway/WE sibling
    // of #994). Defer rather than write TBA — TodayTix is polled fresh
    // each run, so nothing is lost, only delayed.
    const bwayVenue = resolveTodayTixVenue(show);
    if (!bwayVenue) {
      if (verbose) console.log(`  [SKIP] "${title}" — TodayTix venue "${(typeof show.venue === 'string' ? show.venue : show.venue?.name) || ''}" is a placeholder/blob, deferring to next run (card #1060)`);
      continue;
    }

    showsList.push({
      title,
      venue: bwayVenue,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: null,
      previewsStartDate: bwayStart.previewsStartDate,
      closingDate: show.endDate === 'null' ? null : show.endDate || null,
      description: show.description || '',
      todayTixCategory: show.category?.name || null,
      todaytixId: show.id || null,
      ...unconfirmedStartFlags(bwayStart.unconfirmedStartDate),
      // provisional + discoverySource when rescued by the Broadway-house fallback
      ...bwayFallbackFlags(show),
    });
  }

  for (const show of offBroadwayShows) {
    const title = (show.displayName || show.name || '').trim();
    if (!title || title.length < 3 || seen.has(title)) continue;
    seen.add(title);

    const obStart = classifyTodayTixStartDate(show.startDate, title);

    // TodayTix's own venue field can be a neighbourhood blob ("Soho/Tribeca")
    // rather than a real venue name — that's how jest-to-impress-off-broadway
    // landed with a placeholder (card #994 S0 remainder). Defer this show to
    // the next daily run rather than write a placeholder; TodayTix is polled
    // live each run, so nothing is lost, only delayed.
    const obVenue = resolveTodayTixVenue(show);
    if (!obVenue) {
      if (verbose) console.log(`  [SKIP] "${title}" — TodayTix venue "${(typeof show.venue === 'string' ? show.venue : show.venue?.name) || ''}" is a placeholder/blob, deferring to next run (card #994)`);
      continue;
    }

    showsList.push({
      title,
      venue: obVenue,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: null,
      previewsStartDate: obStart.previewsStartDate,
      closingDate: show.endDate === 'null' ? null : show.endDate || null,
      category: 'off-broadway',
      description: show.description || '',
      todayTixCategory: show.category?.name || null,
      todaytixId: show.id || null,
      ...unconfirmedStartFlags(obStart.unconfirmedStartDate),
      // provisional + discoverySource when rescued by the venue-name fallback
      ...obFallbackFlags(show),
    });
  }

  console.log(`TodayTix API: ${allShows.length} total NYC shows, ${broadwayShows.length} Broadway (subcat or known house), ${offBroadwayShows.length} Off-Broadway (subcat or known venue), ${showsList.length} unique`);
  return showsList;
}

/**
 * Off-Broadway discovery via Playbill's "Schedule of Upcoming Off-Broadway
 * Shows" article. TodayTix doesn't list non-profit subscription houses
 * (Atlantic, Vineyard, MCC); Playbill does.
 *
 * Each Playbill entry is mapped into a candidate object that synthesizes
 * the TodayTix-shaped fields the existing gate predicates read
 * (displayName, subcategories, venue.name, description). This lets
 * isNonTheaterContent() and isOneNightShow() apply unchanged — no
 * separate gate logic, no risk of new sources silently bypassing the
 * exclusion rules.
 */
async function fetchShowsFromPlaybillOB() {
  console.log('Fetching Off-Broadway shows from Playbill schedule article...');
  const { entries, html } = await scrapePlaybillOBData();
  checkSilentRot({ entries, html });
  if (entries.length === 0) {
    console.log('Playbill OB: 0 entries');
    return [];
  }

  // Build gate-shape candidates (TodayTix-shape `venue: { name }`,
  // `displayName`, `subcategories`, `description`) for filtering, then
  // transform the survivors to discovery-pipeline shape (`venue` as
  // string, `title` etc.) before returning.
  const VENUE_PLACEHOLDER = 'TBA';
  const gateShape = entries.map(e => ({
    displayName: e.title,
    name: e.title,
    subcategories: [{ name: 'Off Broadway' }],
    venue: { name: e.venue || VENUE_PLACEHOLDER },
    description: '',
    startDate: e.firstPreview || null,
    // carry-through for the transform:
    _entry: e,
  }));

  const kept = gateShape.filter(c => !isNonTheaterContent(c) && !isOneNightShow(c));
  const dropped = gateShape.length - kept.length;
  console.log(`Playbill OB: ${gateShape.length} candidates, ${kept.length} after gates${dropped > 0 ? ` (${dropped} filtered)` : ''}`);

  const transformed = kept.map(c => {
    const e = c._entry;
    const previewsStart = e.firstPreview || null;
    // A curated Playbill listing rarely omits the venue, but when it does,
    // don't write the placeholder — defer the entry to the next run instead
    // (card #994 S0 remainder: every writer must route through the guard,
    // not just the ones already traced).
    const venue = sanitizeVenueForWrite(e.venue);
    if (!venue) {
      if (verbose) console.log(`  [SKIP] "${e.title}" — Playbill OB venue "${e.venue || ''}" is a placeholder/blob, deferring to next run (card #994)`);
      return null;
    }
    return {
      title: e.title,
      venue,
      slug: e.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: e.opening || null,
      previewsStartDate: previewsStart,
      closingDate: null,
      category: 'off-broadway',
      description: '',
      source: 'playbill-ob',
    };
  });
  return transformed.filter(Boolean);
}

/**
 * Off-Broadway discovery via TheaterMania's WordPress REST API (market 98,
 * BRO-4381). Covers the small/independent houses (HERE, 59E59, Theatre Row,
 * Cherry Lane, Axis, The Cell...) that neither TodayTix nor Playbill's OB
 * schedule carries. Parsing lives in scripts/lib/theatermania-ob.js; rows are
 * run through the same isNonTheaterContent / isOneNightShow gates as every
 * other NYC source, and each candidate is provisional (Playbill cross-check
 * via validate-show-venue.js --all-provisional).
 */
async function fetchShowsFromTheaterManiaOB() {
  console.log('Fetching Off-Broadway shows from TheaterMania API...');
  const { rows, venuesById, genresById, pagesFetched, rawCount } = await fetchTmOffBroadway();
  const parsed = [];
  let skipped = 0;
  for (const row of rows) {
    const r = parseTmOffBroadwayRow(row, { venuesById, genresById });
    if (r.skip) {
      skipped++;
      if (verbose) console.log(`  [SKIP] TheaterMania "${(row.title && row.title.rendered) || row.id}" — ${r.skip}`);
      continue;
    }
    parsed.push(r);
  }
  const kept = parsed.filter(({ gateShape }) => !isNonTheaterContent(gateShape) && !isOneNightShow(gateShape));
  const gated = parsed.length - kept.length;
  console.log(`TheaterMania OB: ${rawCount} rows over ${pagesFetched} page(s), ${rows.length} current, ${parsed.length} parsed${skipped ? ` (${skipped} skipped: venue/date)` : ''}, ${kept.length} after gates${gated ? ` (${gated} filtered)` : ''}`);
  return kept.map(k => k.candidate);
}

/**
 * Broadway discovery + openingDate source via Playbill's "Schedule of
 * Upcoming and Announced Broadway Shows" article (card #1426).
 *
 * TodayTix's Broadway feed only ever carries a first-preview date
 * (openingDate is always null there — IBDB enrichment fills it in later).
 * IBDB enrichment can fail two ways: (1) a show's stored ibdbUrl points at a
 * decades-old prior Broadway production of the same title, and the
 * wrong-production guard correctly refuses to trust it (Awake and Sing!,
 * The Imaginary Invalid); (2) a batch run's commit gets blocked wholesale by
 * an unrelated show's pre-existing validation error (see
 * scripts/lib/validation-setdiff.js attributeErrorsToShowIds). Playbill's
 * article publishes both dates explicitly per-show and only ever lists the
 * current production, so it sidesteps both failure modes — and it's how the
 * 5 shows in card #1426 were found missing from shows.json entirely.
 */
async function fetchShowsFromPlaybillBroadway() {
  console.log('Fetching Broadway shows from Playbill schedule article...');
  const { entries, html } = await scrapePlaybillBroadwayData();
  checkBroadwaySilentRot({ entries, html });
  if (entries.length === 0) {
    console.log('Playbill Broadway: 0 entries');
    return [];
  }

  const VENUE_PLACEHOLDER = 'TBA';
  const gateShape = entries.map(e => ({
    displayName: e.title,
    name: e.title,
    subcategories: [{ name: 'Broadway' }],
    venue: { name: e.venue || VENUE_PLACEHOLDER },
    description: '',
    startDate: e.firstPreview || null,
    _entry: e,
  }));

  const kept = gateShape.filter(c => !isNonTheaterContent(c) && !isOneNightShow(c));
  const dropped = gateShape.length - kept.length;
  console.log(`Playbill Broadway: ${gateShape.length} candidates, ${kept.length} after gates${dropped > 0 ? ` (${dropped} filtered)` : ''}`);

  const transformed = kept.map(c => {
    const e = c._entry;
    // No day-level first-preview date yet ("February 2027") — defer to the
    // next run rather than write a half-confirmed date (same policy as the
    // venue placeholder guard below).
    if (!e.firstPreview && e.firstPreviewApprox) {
      if (verbose) console.log(`  [SKIP] "${e.title}" — only an approximate date published ("${e.firstPreviewApprox}"), deferring to next run`);
      return null;
    }
    const venue = sanitizeVenueForWrite(e.venue);
    if (!venue) {
      if (verbose) console.log(`  [SKIP] "${e.title}" — Playbill Broadway venue "${e.venue || ''}" is a placeholder/blob, deferring to next run`);
      return null;
    }
    return {
      // Canonical normaliser, not the local titleCaseFromAllCaps(): that
      // helper is Latin-1 only, has no venue-suffix handling, and would
      // disagree with the validate-data.js gate. One definition of a correct
      // title, shared by ingestion, the gate and the sweep.
      title: normalizeShowTitle({ title: e.title, venue: e.venue }).title,
      venue,
      slug: e.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: e.opening || null,
      openingDateSource: e.opening ? 'playbill' : null,
      previewsStartDate: e.firstPreview,
      closingDate: null,
      description: '',
      source: 'playbill-broadway',
    };
  });
  return transformed.filter(Boolean);
}

// TodayTix London API - location=2 for London West End
function fetchTodayTixLondonPage(offset = 0, limit = 100) {
  return new Promise((resolve, reject) => {
    const url = `https://api.todaytix.com/api/v2/shows?location=2&limit=${limit}&offset=${offset}`;
    const req = https.get(url, { timeout: 15000 }, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`TodayTix London API HTTP ${response.statusCode}`));
        response.resume();
        return;
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Failed to parse TodayTix London API response')); }
      });
      response.on('error', reject);
    }).on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('TodayTix London API request timed out')); });
  });
}

async function fetchShowsFromTodayTixLondon() {
  console.log('Fetching West End shows from TodayTix London API...');
  const allShows = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await fetchTodayTixLondonPage(offset, limit);
    if (!response.data || response.data.length === 0) break;
    allShows.push(...response.data);
    if (allShows.length >= (response.pagination?.total || 0)) break;
    offset += limit;
  }

  // Filter to West End shows
  // TodayTix tags shows as "West End" OR "Off West End" — many legitimate WE productions
  // (Starlight Express, Into the Woods, Witness for the Prosecution) only have "Off West End".
  // For "Off West End" shows, require either:
  //   1. Top-level category is Plays or Musicals, OR
  //   2. Category is "Immersive Experiences" but has theater subcategories (Drama, Classic, Comedy)
  //      — catches Witness for the Prosecution which TodayTix miscategorizes as immersive
  const WE_THEATER_CATEGORIES = new Set(['Plays', 'Musicals', 'Cabaret']);
  const WE_THEATER_SUBCATEGORIES = new Set(['Drama', 'Classic', 'Comedy']);
  const westEndShows = allShows.filter(s => {
    const subcatNames = (s.subcategories || []).map(sc => sc.name);
    const isWestEnd = subcatNames.includes('West End') || subcatNames.includes('Broadway');
    const isOffWestEnd = subcatNames.includes('Off West End') && !isWestEnd;
    const hasSubcategories = subcatNames.length > 0;

    if (hasSubcategories) {
      // When TodayTix provides subcategories, use them for WE/OWE classification
      if (!isWestEnd && !isOffWestEnd) return false;

      // Off West End shows need category-level filtering to exclude noise
      if (isOffWestEnd) {
        const isTheaterCategory = WE_THEATER_CATEGORIES.has(s.category?.name);
        const hasTheaterSubcats = subcatNames.some(sc => WE_THEATER_SUBCATEGORIES.has(sc));
        if (!isTheaterCategory && !hasTheaterSubcats) return false;
      }
    } else {
      // FALLBACK: TodayTix removed subcategories (detected March 2026).
      // All location=2 shows are London. Filter by top-level category instead.
      const isTheaterCategory = WE_THEATER_CATEGORIES.has(s.category?.name);
      if (!isTheaterCategory) return false;
    }

    // market:'london' — a stadium/arena/concert-hall/cabaret venue or a
    // receiving-house tour stop rejects outright here, with no Plays/Musicals
    // override (docs/show-inclusion-policy.md).
    return !isNonTheaterContent(s, { market: 'london' }) && !isOneNightShow(s);
  });

  const seen = new Set();
  const showsList = [];
  for (const show of westEndShows) {
    const title = (show.displayName || show.name || '').trim();
    if (!title || title.length < 3 || seen.has(title)) continue;

    const titleLower = title.toLowerCase();
    if (WE_EXTRA_PATTERNS.some(p => titleLower.includes(p))) continue;

    seen.add(title);

    // Same class as the Broadway/OB loops: TodayTix's venue field can be a
    // placeholder/blob (card #1060, Broadway/WE sibling of #994). Defer
    // rather than write TBA — TodayTix is polled fresh each run.
    const weVenue = resolveTodayTixVenue(show);
    if (!weVenue) {
      if (verbose) console.log(`  [SKIP] "${title}" — TodayTix venue "${(typeof show.venue === 'string' ? show.venue : show.venue?.name) || ''}" is a placeholder/blob, deferring to next run (card #1060)`);
      continue;
    }

    // TodayTix startDate is first preview for WE shows, NOT press night.
    // Treat as previewsStartDate; openingDate set later by ShowScore or enrichment.
    const weStart = classifyTodayTixStartDate(show.startDate, title);
    const description = show.description || '';
    const genre = classifyGenre({ title, venue: weVenue, description });
    const category = applyGenreCategoryOverride(
      isOffWestEndVenue(weVenue) ? 'off-west-end' : 'west-end',
      genre
    );
    showsList.push({
      title,
      venue: weVenue,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: null,
      previewsStartDate: weStart.previewsStartDate,
      closingDate: show.endDate === 'null' ? null : show.endDate || null,
      ...(genre ? { genre } : {}),
      category,
      description,
      todayTixCategory: show.category?.name || null,
      todaytixId: show.id || null,
      ...unconfirmedStartFlags(weStart.unconfirmedStartDate),
    });
  }

  console.log(`TodayTix London API: ${allShows.length} total London shows, ${westEndShows.length} West End-filtered, ${showsList.length} unique`);

  // GUARD: If TodayTix returned shows but our filter (category + venue guard,
  // card #1060) dropped them all, something is wrong. Checks showsList, not
  // westEndShows — westEndShows is pre-venue-guard, so a TodayTix venue-field
  // regression (the exact class of bug #1060 defends against) would silently
  // empty showsList while westEndShows stayed healthy and this warning never fired.
  if (allShows.length > 20 && showsList.length === 0) {
    console.error(`⚠️  WARNING: TodayTix returned ${allShows.length} London shows but 0 passed WE filter — API may have changed`);
  } else if (allShows.length > 50 && showsList.length < 10) {
    console.error(`⚠️  WARNING: Only ${showsList.length}/${allShows.length} London shows passed WE filter — unusually low`);
  }

  return showsList;
}

// ── London listing fetch (scraper rule) ──
//
// Every London listing page below goes through fetchPage() (scripts/lib/
// scraper.js: Scrapingdog → Bright Data → ScrapingBee → Playwright). The raw
// https.get() this replaced for OLT 403'd on every Actions runner for 23
// consecutive runs (CI log 2026-09-27, run 36322077623: "OLT fetch failed
// (HTTP 403)") while returning ~100 shows locally — the G6 TLS-fingerprint
// class in the scraper-reference skill, and exactly what the provider chain
// exists for (S4-T4, 2026 data audit BRO-4204).
//
// The plain fetch() after it is NOT a scraping tier: fetchPage() has no
// provider-less path (no keys + no Playwright → "All scraping methods
// failed"), so a local run without scraper keys would report every London
// source dark and the source counts could never be verified off-CI. It runs
// only once fetchPage() has thrown or returned a stub, uses undici fetch()
// (never https.get — G6) with an AbortSignal timeout, and in CI is reached
// only after the whole provider chain has already failed.
const LONDON_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-GB,en;q=0.9',
};

async function fetchLondonListingHtml(url, { label = url, minBytes = 3000 } = {}) {
  let why;
  try {
    const result = await fetchPage(url);
    const html = result?.content || '';
    if (html.length >= minBytes) return { html, via: result.source || 'fetchPage' };
    why = `${html.length} bytes (< ${minBytes})`;
  } catch (e) {
    why = e.message;
  }
  console.log(`  ${label}: fetchPage() gave ${why} — trying plain fetch()`);
  // Literal timeout: scripts/discover-new-shows.test.mjs scopes its BRO-108
  // guard to `AbortSignal.timeout(<number>)` at each fetch() site.
  const response = await fetch(url, {
    headers: LONDON_FETCH_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await response.text();
  if (html.length < minBytes) throw new Error(`content suspiciously short (${html.length} bytes)`);
  return { html, via: 'direct-fetch' };
}

// ── Theatremonkey — supplementary WE discovery source (catches shows TodayTix/OLT miss) ──
//
// The index lists titles only; the venue is on each show page. Card #1060
// closed the `venue: 'TBA'` leak by skipping every candidate, which left this
// source contributing 0 for 23 consecutive CI runs ("skipped 78 candidates —
// index has no venue data"). S4-T5 (2026 data audit, BRO-4204) adds the
// per-show-page fetch that comment called for: bounded (--tm-page-budget=N /
// TM_VENUE_PAGE_BUDGET, default 20 pages a run), cached across runs in
// data/audit/theatremonkey-venue-cache.json (keyed by show URL), and index
// titles that are not already a London show in shows.json are fetched first
// — they are the only ones that can become new rows, so the budget lands on
// them even before the cache fills. Venue strings go through
// sanitizeVenueForWrite and the non-theatre / receiving-house gate exactly
// like the OLT and LT paths. Decision logic: scripts/lib/theatremonkey-venue.js.
const TM_VENUE_PAGE_BUDGET = parseVenuePageBudget(process.argv.slice(2), process.env);
const TM_PAGE_DELAY_MS = 500;

async function fetchShowsFromTheatremonkey(existingShows = []) {
  console.log('Fetching West End shows from Theatremonkey...');
  let html;
  try {
    ({ html } = await fetchLondonListingHtml(TM_INDEX_URL, { label: 'Theatremonkey index', minBytes: 10000 }));
  } catch (err) {
    console.log(`  Theatremonkey fetch failed: ${err.message}`);
    return [];
  }

  const indexEntries = parseTheatremonkeyIndex(html);
  console.log(`Theatremonkey: ${indexEntries.length} shows on index`);
  if (indexEntries.length === 0) {
    // A full-size page where the /show/ link selector matched nothing is the
    // HTML-structure regression this warning exists to catch.
    console.error('⚠️  WARNING: Theatremonkey page loaded but 0 candidates found — HTML structure may have changed');
    return [];
  }

  const cache = loadVenueCache();
  const existingLondonTitles = new Set(
    existingShows.filter(s => s && isLondonMarket(s.category)).map(s => titleKey(s.title))
  );
  const plan = planVenueFetches(indexEntries, cache, {
    budget: TM_VENUE_PAGE_BUDGET,
    prioritize: (entry) => !existingLondonTitles.has(titleKey(entry.title)),
  });
  console.log(`  Theatremonkey: ${plan.fromCache.length} venues from cache, ${plan.toFetch.length} show pages to fetch (budget ${TM_VENUE_PAGE_BUDGET}), ${plan.deferred.length} deferred to a later run, ${plan.knownNoVenue} known without a venue`);

  const resolved = plan.fromCache.map(e => ({ ...e, showingFrom: null, showingTo: null }));
  let attempted = 0;
  for (const entry of plan.toFetch) {
    if (timeBudget.exceeded()) {
      console.log(`  ⏱ Time budget reached — stopping Theatremonkey show-page fetches after ${attempted}`);
      break;
    }
    if (attempted > 0) await new Promise(resolve => setTimeout(resolve, TM_PAGE_DELAY_MS));
    attempted++;
    try {
      const { html: pageHtml } = await fetchLondonListingHtml(entry.url, { label: `Theatremonkey ${entry.slug}`, minBytes: 5000 });
      // Sanitize BEFORE caching so a placeholder/blob venue line is cached as
      // 'no-venue' (retried in 7 days) rather than resurfacing every run.
      const rawVenue = extractTheatremonkeyVenue(pageHtml);
      const venue = rawVenue ? sanitizeVenueForWrite(rawVenue) : null;
      if (venue) {
        recordVenueResult(cache, entry, { status: 'ok', venue });
        resolved.push({ ...entry, venue, ...extractTheatremonkeyDates(pageHtml) });
        if (verbose) console.log(`  [TM] "${entry.title}" → ${venue}`);
      } else {
        recordVenueResult(cache, entry, { status: 'no-venue' });
        if (verbose) console.log(`  [TM] "${entry.title}" — show page has no usable venue line ("${rawVenue || ''}"), retry in 7 days`);
      }
    } catch (err) {
      recordVenueResult(cache, entry, { status: /HTTP 404/.test(err.message) ? 'not-found' : 'error', error: err.message });
      console.log(`  Theatremonkey: ${entry.slug} — ${err.message}`);
    }
  }
  if (attempted > 0) {
    try {
      saveVenueCache(cache);
    } catch (e) {
      console.log(`  ⚠️  Theatremonkey venue cache not saved (${e.message})`);
    }
  }

  const showsList = [];
  const seen = new Set();
  let skippedNoVenue = 0;
  let filtered = 0;
  for (const entry of resolved) {
    const title = entry.title;
    const titleLower = title.toLowerCase();
    if (title.length < 3 || seen.has(titleLower)) continue;
    if (londonListingTitleRejected(title)) continue; // substring lists + NON_THEATRE_TITLE_RE (concerts, NT Live, prizes…)

    // Same guards as OLT/LT: a placeholder/blob never reaches shows.json
    // (card #1060), and London paths reject non-theatre venues and
    // receiving-house tour stops outright (BRO-4204).
    const venue = sanitizeVenueForWrite(entry.venue);
    if (!venue) {
      skippedNoVenue++;
      if (verbose) console.log(`  [SKIP] "${title}" — Theatremonkey venue "${entry.venue || ''}" is a placeholder/blob (card #1060)`);
      continue;
    }
    if (isNonTheatreVenue(venue) || isLondonReceivingHouse(venue)) {
      filtered++;
      if (verbose) console.log(`  [FILTERED] "${title}" — Theatremonkey venue "${venue}" is a non-theatre venue or receiving house`);
      continue;
    }

    seen.add(titleLower);
    const genre = classifyGenre({ title, venue });
    // Venue-based classification, as the LT path does: Theatremonkey is a
    // West End index, so only a known Off-West End house that is NOT also a
    // West End house is filed as off-west-end.
    const baseCategory = isOffWestEndVenue(venue) && !isWestEndVenue(venue) ? 'off-west-end' : 'west-end';
    showsList.push({
      title,
      venue,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: null,
      previewsStartDate: entry.showingFrom || null,
      closingDate: entry.showingTo || null,
      ...(genre ? { genre } : {}),
      category: applyGenreCategoryOverride(baseCategory, genre),
      description: '',
    });
  }

  const awaitingFetch = plan.deferred.length + (plan.toFetch.length - attempted);
  console.log(`  Theatremonkey: ${showsList.length} candidates with a venue (${skippedNoVenue} placeholder venues skipped, ${filtered} non-theatre/receiving-house filtered, ${awaitingFetch} awaiting a show-page fetch)`);
  return showsList;
}

// ── Official London Theatre (SOLT) — supplementary WE discovery source ──

const OLT_URL = 'https://officiallondontheatre.com/theatre-tickets/';

async function fetchShowsFromOfficialLondonTheatre() {
  console.log('Fetching West End shows from Official London Theatre (SOLT)...');

  // S4-T4 (2026 data audit, BRO-4204): fetchPage() per the scraper rule. The
  // raw https.get() this replaced ("static HTML, no scraping service needed")
  // was 403'd on every Actions runner — see fetchLondonListingHtml above.
  // A short body (< 3000 bytes) throws there and surfaces as "OLT fetch
  // failed (content suspiciously short …)" in the caller, same outcome as
  // the old inline skip.
  const { html, via } = await fetchLondonListingHtml(OLT_URL, { label: 'OLT', minBytes: 3000 });
  if (verbose) console.log(`  OLT: ${html.length} bytes via ${via}`);

  // Parse JSON-LD TheaterEvent blocks (each is a standalone <script type="application/ld+json">).
  // The reader lives in scripts/lib/olt-enrichment.js (audit S7-T10) so the
  // West End date/age backfill (scripts/enrich-west-end-dates.js) parses the
  // exact same page the exact same way; it also fixes the venue: OLT's
  // `location.name` is the venue's URL and `location.title` the human name
  // on every live entry (verified 2026-09-28), and the inline reader this
  // replaced took `.name`.
  const ldBlockCount = extractJsonLdBlocks(html).length;
  const shows = [];
  const seen = new Set();

  for (const event of parseOltTheaterEvents(html)) {
    const title = event.title;
    if (!title || title.length < 3 || seen.has(title.toLowerCase())) continue;

    // Apply shared filters
    const titleLower = title.toLowerCase();
    if (londonListingTitleRejected(title)) continue; // substring lists + NON_THEATRE_TITLE_RE (concerts, NT Live, prizes…)

    // OLT's JSON-LD location can be missing/blank on a malformed entry —
    // same #994-class leak, guarded here rather than resurrected via
    // `|| 'TBA'` (card #1060).
    const venue = sanitizeVenueForWrite(event.venue);
    if (!venue) {
      if (verbose) console.log(`  [SKIP] "${title}" — OLT venue "${event.venue || ''}" is a placeholder/blob, deferring to next run (card #1060)`);
      continue;
    }
    // London paths reject non-theatre venues and receiving-house tour stops
    // outright (2026 audit, BRO-4204 — docs/show-inclusion-policy.md).
    if (isNonTheatreVenue(venue) || isLondonReceivingHouse(venue)) {
      if (verbose) console.log(`  [FILTERED] "${title}" — OLT venue "${venue}" is a non-theatre venue or receiving house`);
      continue;
    }

    seen.add(titleLower);
    const description = (event.description || '').substring(0, 500);
    const genre = classifyGenre({ title, venue, description });
    shows.push({
      title,
      venue,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: null,
      previewsStartDate: event.startDate,
      closingDate: event.endDate,
      ...(genre ? { genre } : {}),
      // Venue-based like the Theatremonkey loop below (2026-09-29): OLT lists
      // Off-West End houses too, and a hardcoded 'west-end' minted ids such as
      // dick-whittington-and-his-cat-west-end-2026 for the King's Head, which
      // validate-data then re-categorised off-west-end — leaving the id suffix
      // wrong for good (the S8-T1 rename class, 96 rows by the audit's count).
      category: applyGenreCategoryOverride(isOffWestEndVenue(venue) && !isWestEndVenue(venue) ? 'off-west-end' : 'west-end', genre),
      description,
    });
  }

  // Guards
  if (shows.length > 100) {
    console.log(`  ⚠️  OLT returned ${shows.length} shows (expected ~75). Possible data issue — capping at 100.`);
    shows.length = 100;
  }
  if (shows.length < 5 && shows.length > 0) {
    console.log(`  ⚠️  OLT returned only ${shows.length} shows (expected ~75). Possible partial fetch — discarding.`);
    return [];
  }

  console.log(`  OLT: ${ldBlockCount} JSON-LD blocks, ${shows.length} TheaterEvent shows parsed`);
  return shows;
}

// ── LondonTheatre.co.uk — OWE discovery source (catches fringe venues TodayTix misses) ──

const LT_OWE_URL = 'https://www.londontheatre.co.uk/whats-on/off-west-end';

async function fetchShowsFromLondonTheatre() {
  console.log('Fetching Off-West End shows from LondonTheatre.co.uk...');

  // Plain HTTPS — site serves static HTML with JSON-LD, no scraping service needed
  const html = await new Promise((resolve, reject) => {
    const req = https.get(LT_OWE_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      timeout: 20000,
    }, (res) => {
      // Follow one redirect (301/302/307/308)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectReq = https.get(res.headers.location, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
          timeout: 20000,
        }, (res2) => {
          if (res2.statusCode !== 200) { reject(new Error(`HTTP ${res2.statusCode} after redirect`)); res2.resume(); return; }
          let d = '';
          res2.on('data', chunk => d += chunk);
          res2.on('end', () => resolve(d));
        }).on('error', reject);
        redirectReq.on('timeout', () => { redirectReq.destroy(); reject(new Error('Timeout after redirect')); });
        res.resume();
        return;
      }
      if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });

  if (html.length < 3000) {
    console.log(`  LT: content suspiciously short (${html.length} bytes), skipping`);
    return [];
  }

  const dom = new JSDOM(html);
  const ldScripts = dom.window.document.querySelectorAll('script[type="application/ld+json"]');
  const shows = [];
  const seen = new Set();

  for (const script of ldScripts) {
    try {
      const items = parseJsonLd(script.textContent);

      for (const data of items) {
        if (!hasJsonLdType(data, 'TheaterEvent')) continue;
        if (data.subEvent) continue;

        const title = (data.name || '').trim()
          .replace(/&#8217;|&#8216;|[\u2018\u2019]/g, "'")
          .replace(/&#8220;|&#8221;|[\u201C\u201D]/g, '"')
          .replace(/&#8211;|[\u2013]/g, '\u2013').replace(/&#8212;|[\u2014]/g, '\u2014')
          .replace(/&#038;/g, '&').replace(/&amp;/g, '&')
          .replace(/&apos;/g, "'");
        if (!title || title.length < 3 || seen.has(title.toLowerCase())) continue;

        if (londonListingTitleRejected(title)) continue; // substring lists + NON_THEATRE_TITLE_RE

        // Same #994-class leak as OLT above: LT's JSON-LD location can be
        // missing/blank on a malformed entry — guard instead of resurrecting
        // via `|| 'TBA'` (card #1060).
        const rawLocation = typeof data.location === 'object' ? data.location.name : data.location;
        const decodedVenue = rawLocation ? rawLocation.replace(/&apos;/g, "'").replace(/&amp;/g, '&') : rawLocation;
        const venue = sanitizeVenueForWrite(decodedVenue);
        if (!venue) {
          if (verbose) console.log(`  [SKIP] "${title}" — LT venue "${rawLocation || ''}" is a placeholder/blob, deferring to next run (card #1060)`);
          continue;
        }
        // London paths reject non-theatre venues and receiving-house tour
        // stops outright (2026 audit, BRO-4204 — docs/show-inclusion-policy.md).
        if (isNonTheatreVenue(venue) || isLondonReceivingHouse(venue)) {
          if (verbose) console.log(`  [FILTERED] "${title}" — LT venue "${venue}" is a non-theatre venue or receiving house`);
          continue;
        }
        const endDate = data.endDate === 'null' || data.endDate === null ? null : data.endDate || null;

        // Venue-based classification: most are OWE, but reclassify if at a WE venue
        const category = isWestEndVenue(venue) ? 'west-end' : 'off-west-end';

        seen.add(title.toLowerCase());
        shows.push({
          title,
          venue,
          slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
          openingDate: null,
          previewsStartDate: data.startDate || null,
          closingDate: endDate,
          category,
          description: (data.description || '').substring(0, 500),
        });
      }
    } catch (e) {
      // Skip malformed JSON-LD blocks
    }
  }

  if (shows.length > 150) {
    console.log(`  ⚠️  LT returned ${shows.length} shows (expected ~75). Capping at 150.`);
    shows.length = 150;
  }
  if (shows.length < 5 && shows.length > 0) {
    console.log(`  ⚠️  LT returned only ${shows.length} shows (expected ~75). Possible partial fetch — discarding.`);
    return [];
  }

  console.log(`  LT: ${ldScripts.length} JSON-LD blocks, ${shows.length} OWE shows parsed`);
  return shows;
}

// ── Venue Page Discovery ──
// Fetches What's On / Shows pages from venues that don't list on TodayTix /
// OLT / Theatremonkey / LondonTheatre.co.uk. Originally OWE-only; the
// `category` field generalized this for Off-Broadway non-profit subscription
// houses (Atlantic, Vineyard, Signature, MCC) which similarly don't list
// on TodayTix.
//
// Adding a new venue: probe its show page, pick a `linkPattern` that
// matches `/section/<slug>` for individual show URLs, set `category`
// to 'off-west-end' or 'off-broadway'.

const VENUE_LISTING_PAGES = [
  // ── Off-West End ──
  { name: 'Almeida Theatre', url: 'https://almeida.co.uk/whats-on/', linkPattern: /\/whats-on\/[^/]+/, titleFromSlug: true, category: 'off-west-end' },
  // Removed Soho Theatre, King's Head, Theatre503 — tiny OWE venues with near-zero review/aggregator
  // coverage. Shows that matter transfer to bigger houses and get picked up there.
  // Arcola: shows rendered in-page without individual links — needs Playwright (v2)
  { name: 'Theatre Royal Stratford East', url: 'https://www.stratfordeast.com/whats-on', linkPattern: /\/whats-on\/all-shows\/[^/]+/, titleFromSlug: true, category: 'off-west-end' },
  { name: 'New Diorama Theatre', url: 'https://www.newdiorama.com/whats-on', linkPattern: /\/whats-on\/[^/]+/, titleFromSlug: true, category: 'off-west-end' },
  { name: 'Finborough Theatre', url: 'https://www.finboroughtheatre.co.uk/', linkPattern: /\/productions\/[^/]+/, titleFromSlug: true, category: 'off-west-end' },
  // Stuart King email 2026-04-27: Marylebone Theatre is the newest major OWE venue, under new
  // management and getting strong critic coverage (Stuart's Price review 2026-04-27 was the trigger).
  { name: 'Marylebone Theatre', url: 'https://marylebonetheatre.com/', linkPattern: /\/productions\/[^/]+/, titleFromSlug: true, category: 'off-west-end' },
  // Premier Off-West-End venues per Stuart King 2026-04-27: A-list performers, strong critic coverage.
  // Patterns probed 2026-05-01 — only static-HTML venues added here. Donmar (JS-rendered),
  // Regent's Park Open Air (JS-rendered) need Playwright-based discovery — tracked separately.
  // Menier re-probed 2026-07-21: homepage now serves plain /tickets/<slug> links in static
  // HTML (site changed since the 2026-05-01 "ticketing-system-only" assessment, which caused
  // the Midnight at the Never Get miss — reader-reported gap). /tickets/series/* is the
  // booking system, excluded via lookahead.
  // Homepage (not /whats-on/) on purpose: /whats-on/ lists the full past-show archive.
  // Lookahead also pre-excludes ticketing utility slugs the site could add later
  // (none exist as of 2026-07-21 — adversarial-review hardening, not observed noise).
  { name: 'Menier Chocolate Factory', url: 'https://www.menierchocolatefactory.com/', linkPattern: /\/tickets\/(?!(?:series|gift|vouchers?|membership|support|donat[a-z]*|access)\b)[a-z0-9-]+/, titleFromSlug: true, category: 'off-west-end' },
  // Show pages moved from /whats-on/<year>/<slug> to /production/<slug>/
  // (found 2026-09-30, BRO-4398: the old pattern had matched nothing).
  { name: 'Hampstead Theatre', url: 'https://www.hampsteadtheatre.com/whats-on/', linkPattern: /\/production\/[a-z0-9-]+\/?$/, titleFromSlug: true, category: 'off-west-end' },
  { name: 'Kiln Theatre', url: 'https://kilntheatre.com/whats-on/', linkPattern: /\/whats-on\/[^/]+/, titleFromSlug: true, category: 'off-west-end' },
  { name: 'Southwark Playhouse', url: 'https://southwarkplayhouse.co.uk/', linkPattern: /\/productions\/[^/]+/, titleFromSlug: true, category: 'off-west-end' },
  // Added 2026-07-31 (Space Dogs miss, owner-reported): short-run Studio shows never
  // reach TodayTix/OLT/londontheatre, so the venue's own page is the only listing.
  // Show links are absolute single-segment slugs (https://theotherpalace.co.uk/<slug>/);
  // the lookahead excludes the site's utility pages, two-segment URLs self-exclude.
  // NOTE: these three entries use fully-anchored absolute-URL regexes (unlike the
  // unanchored substring patterns above) because their show links are root-level or
  // shallow slugs that substring patterns would confuse with booking-widget/nav URLs.
  { name: 'The Other Palace', url: 'https://theotherpalace.co.uk/whats-on/', linkPattern: /^https:\/\/theotherpalace\.co\.uk\/(?!(?:about|access|basket|blog|careers|comments|contact|events|faq|feed|find-us|food-and-drink|get-involved|jobs|legal-privacy|my-account|news|press|shop|site-map|tickets|top-archive|venue-hire|whats-on|your-visit)\/?$)[a-z0-9-]+\/?$/, titleFromSlug: true, category: 'off-west-end' },
  // Added 2026-07-31 (venue what's-on vs catalog audit after the Space Dogs miss):
  // Orange Tree was missing ALL 4 current productions (Love's Labour's Lost,
  // Much Ado, a small and quiet light, Murder in the Cathedral) and Park Theatre
  // 5 of 8 — neither venue's shows reliably reach TodayTix/OLT/londontheatre.
  // Non-production listings (seminars, youth programmes, screenings) are handled
  // by VENUE_PAGE_EXCLUDE_PATTERNS phrases, corpus-audited for title collisions.
  { name: 'Orange Tree Theatre', url: 'https://www.orangetreetheatre.co.uk/whats-on/', linkPattern: /^https:\/\/(?:www\.)?orangetreetheatre\.co\.uk\/whats-on\/(?!(?:archive|page)\/?$)[a-z0-9-]+\/?$/, titleFromSlug: true, category: 'off-west-end' },
  { name: 'Park Theatre', url: 'https://parktheatre.co.uk/whats-on/', linkPattern: /^https:\/\/(?:www\.)?parktheatre\.co\.uk\/events\/(?!(?:archive|page)\/?$)[a-z0-9-]+\/?$/, titleFromSlug: true, category: 'off-west-end' },

  // ── Off-Broadway non-profit subscription houses ──
  // Live OB venue extraction lives in scripts/lib/venue-listing-discover.js
  // (OB_VENUE_CONFIGS). Candidates write to data/audit/ob-venue-candidates.json
  // and are promoted to shows.json only after cross-validation against
  // Playbill OB / Lortel (scripts/promote-ob-venue-candidates.js, V-T6b).
  // The link-extraction stubs that used to be here returned 0 shows because
  // the venues are bespoke (Elementor for Atlantic, JS-rendered for
  // Vineyard, bot-fingerprinted MCC) — see venue-listing-discover.js for the
  // verified per-venue configs.
];

// Backward-compat alias — old name retained for any external callers/tests.
const OWE_VENUE_PAGES = VENUE_LISTING_PAGES.filter(v => v.category === 'off-west-end');

// Patterns to exclude from venue page scraping (workshops, masterclasses, walking tours, etc.)
const VENUE_PAGE_EXCLUDE_PATTERNS = [
  'masterclass', 'workshop', 'walking tour', 'rapid write',
  // NOT bare 'tour' alone (false-positive: "Armory Public Tours",
  // "September L. Davis: The Apology Tour" — corpus-audited, task BRO-181).
  // 'walking tour' above already covers the literal backstage-tour case.
  'work in progress', 'scratch night', 'open mic', 'poetry slam',
  // Bare 'gala' substring-matches "Via Galactica" (1972 Broadway show) — use the
  // multi-word variants, matching the NON_THEATER_PATTERNS precedent above.
  'fundraiser', 'spring gala', 'annual gala', 'gala benefit', 'gala fundraiser',
  'in conversation', 'q&a', 'meet the',
  // Other Palace Studio one-night tribute concerts ("Big Finish: A Celebration of
  // Shaiman & Wittman", "Songs from the Musicals") — concerts, not productions.
  'celebration of', 'songs from the musicals',
  // Orange Tree non-production listings (seminars, youth programmes, cinema
  // screenings, concerts). Corpus-audited 2026-07-31: zero title collisions.
  'saturday seminar', 'holiday club', 'young company', 'young creatives',
  'directing lab', 'friday company', 'coffee concert', 'on screen',
  'youth theatre', 'writing lab',
  // Orange Tree "Acting Lab" / "Acting Lab Devised Theatre" (BRO-4204
  // S4-T11 promoter dry-run, 2026-09-28) — participation courses listed
  // under the same /whats-on/<slug> pattern as productions. Corpus-audited:
  // zero title collisions across 3,073 shows.json rows. NOT a bare
  // 'conference' for "Sat Conference 2026": "Conference of the Birds" is a
  // real, staged play.
  'acting lab',
  // Orange Tree / Marylebone recitals and talks the S4-T11 promoter dry-run
  // (2026-09-28) would otherwise have confirmed from the venue page:
  // "Schubert Winterreise", "Schubert Die Schöne Müllerin", "Impressions from
  // Debussy to Coltrane", "The Sound of Shakespeare", "Solace of Pilgrims: A
  // Lenten Journey", "David Owen Norris: Made in England", "SAT Conference
  // 2026". Owner rule (D3): keep what gets or might get reviewed — recitals
  // and conferences do not. Corpus-audited: zero hits across 3,073 titles.
  'schubert', 'debussy', 'winterreise', 'lieder', 'song cycle', 'recital',
  'lenten', 'sat conference', 'the sound of shakespeare', 'david owen norris',
];

// Per-venue candidate cap (mirrors OB_VENUE_CAP below) — one bad parser
// regression on a venue page can't flood staging with garbage. A dated
// reader (BRO-4398) reads the venue's whole box-office account, so it gets
// the OB cap instead.
const OWE_VENUE_CAP = 30;
const OWE_DATED_VENUE_CAP = 60;

/**
 * Off-West End candidates from one of OWE_VENUE_CONFIGS' dated readers
 * (scripts/lib/venue-listing-discover.js, BRO-4398), in the staging shape
 * parseVenueListingPage produces plus the listing* fields the promoter's
 * dated rule reads. Titles come from box-office/structured data, so they
 * skip cleanVenueTitle's card-text heuristics (which would cut "Miss
 * Bennet: Christmas at Pemberley" at " at "); the venue-page exclusions
 * (shouldExcludeVenueShow) still apply.
 *
 * @param {{name: string}} cfg an OWE_VENUE_CONFIGS entry
 * @param {Array<object>} rows parseVenueListingHtml / scrapeVenueListing output
 * @returns {Array<object>}
 */
function oweCandidatesFromDatedListing(cfg, rows) {
  const out = [];
  const seen = new Set();
  for (const r of Array.isArray(rows) ? rows : []) {
    const title = String((r && r.title) || '').replace(/\s+/g, ' ').trim();
    if (title.length < 2 || seen.has(title.toLowerCase())) continue;
    if (shouldExcludeVenueShow(title)) continue;
    seen.add(title.toLowerCase());
    const listing = {};
    for (const k of ['listingFirstDate', 'listingLastDate', 'listingPerformanceCount', 'listingUrl', 'listingFirstDateIsNext', 'listingLastDateIsHorizon', 'listingEvidence', 'listingGenre']) {
      if (r[k] !== undefined) listing[k] = r[k];
    }
    out.push({
      title,
      venue: cfg.name,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: null,
      closingDate: null,
      category: isWestEndVenue(cfg.name) ? 'west-end' : 'off-west-end',
      description: '',
      provisional: true,
      discoverySource: `venue-page:${cfg.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      ...listing,
    });
  }
  return out;
}

/**
 * One venue's candidates: its dated reader when it has one (BRO-4398),
 * falling back to its VENUE_LISTING_PAGES link reader when the dated read
 * throws or comes back empty (a feed outage must not blank a venue that
 * the old reader still covers).
 */
async function fetchOneVenueListing(linkVenue, datedCfg) {
  if (datedCfg) {
    try {
      // Feeds (Spektrix JSON, Ticketsolve XML) go through the lib's own
      // fetcher; dated HTML pages through the same plain-fetch-first path
      // as the link readers.
      const listing = FEED_STRATEGIES.has(datedCfg.strategy)
        ? await scrapeVenueListing(datedCfg)
        : parseVenueListingHtml(datedCfg, await fetchVenueHtml(datedCfg));
      const rows = oweCandidatesFromDatedListing(datedCfg, listing);
      if (rows.length > 0 || !linkVenue) return { rows, dated: true };
      console.log(`  ${datedCfg.name}: dated reader returned 0 rows — falling back to the venue page`);
    } catch (e) {
      if (!linkVenue) throw e;
      console.log(`  ${datedCfg.name}: dated reader failed (${e.message}) — falling back to the venue page`);
    }
  }
  return { rows: await fetchSingleVenuePage(linkVenue), dated: false };
}

async function fetchShowsFromVenueListings(category) {
  const venues = VENUE_LISTING_PAGES.filter(v => v.category === category);
  const datedConfigs = category === 'off-west-end' ? OWE_VENUE_CONFIGS : [];
  const linkNames = new Set(venues.map(v => v.name));
  const units = [
    ...venues.map(v => ({ name: v.name, link: v, dated: datedConfigs.find(d => d.name === v.name) || null })),
    ...datedConfigs.filter(d => !linkNames.has(d.name)).map(d => ({ name: d.name, link: null, dated: d })),
  ];
  const label = category === 'off-broadway' ? 'Off-Broadway' : 'Off-West End';
  console.log(`Fetching shows from ${label} venue pages (${units.filter(u => u.dated).length} with a dated reader)...`);

  const results = await Promise.allSettled(units.map(u => fetchOneVenueListing(u.link, u.dated)));

  const allShows = [];
  let successCount = 0;

  for (let i = 0; i < results.length; i++) {
    const venue = units[i];
    const result = results[i];
    const rows = result.status === 'fulfilled' ? result.value.rows : [];
    if (result.status === 'fulfilled' && rows.length > 0) {
      const cap = result.value.dated ? OWE_DATED_VENUE_CAP : OWE_VENUE_CAP;
      if (rows.length > cap) {
        console.error(`::error::Venue ${venue.name} returned ${rows.length} candidates (cap: ${cap}) — likely parser regression. Skipping this venue's candidates.`);
        process.exitCode = 1;
        continue;
      }
      // Per-venue rolling-median anomaly gate (same lib the OB path uses).
      // Fail-soft: warns + sets exitCode but keeps discovering other venues.
      // The dated reader returns a venue's whole account, the link reader a
      // page of slugs: separate baselines, or a fallback day trips the gate.
      checkVenueAnomaly(result.value.dated ? `${venue.name} (dated)` : venue.name, rows.length);
      successCount++;
      allShows.push(...rows);
      const dated = rows.filter(r => r.listingFirstDate && r.listingLastDate).length;
      console.log(`  ${venue.name}: ${rows.length} shows${result.value.dated ? ` (dated reader, ${dated} dated)` : ''}`);
    } else if (result.status === 'rejected') {
      console.log(`  ${venue.name}: failed (${result.reason?.message})`);
    } else {
      console.log(`  ${venue.name}: 0 shows`);
    }
  }

  console.log(`${label} venue pages: ${successCount}/${units.length} venues responded, ${allShows.length} total shows`);
  return allShows;
}

// Backward-compat shim for any caller still using the OWE-specific entrypoint.
async function fetchShowsFromOweVenues() {
  return fetchShowsFromVenueListings('off-west-end');
}

async function fetchSingleVenuePage(venue) {
  return parseVenueListingPage(venue, await fetchVenueHtml(venue));
}

/**
 * A venue page's HTML: a plain request with browser headers first (free,
 * and what these sites serve), the fetchPage proxy chain only on a non-2xx
 * or for a preferPlaywright venue. Shared by the link readers and the dated
 * HTML readers in OWE_VENUE_CONFIGS (BRO-4398).
 */
async function fetchVenueHtml(venue) {
  // Use fetch() instead of https.get() — CDN-protected sites TLS-fingerprint block Node's http module
  let html;
  // Venues that need JS rendering bypass the plain fetch() entirely and go
  // straight to Playwright via fetchPage({preferPlaywright: true}). Before
  // this gate the venue.preferPlaywright flag was dead code — plain fetch()
  // ran first, returned a 200 with empty/partial content, html was used as-is,
  // and the flag never reached scraper.js.
  if (venue.preferPlaywright) {
    const result = await fetchPage(venue.url, { preferPlaywright: true });
    if (!result || !result.content) throw new Error(`Playwright fetch returned empty for ${venue.url}`);
    html = result.content;
  } else {
    const resp = await fetch(venue.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(15000),
    });
    if (resp.ok) {
      html = await resp.text();
    } else {
      // Fallback to fetchPage (Bright Data / ScrapingBee proxy) for CDN-blocked sites
      const result = await fetchPage(venue.url);
      if (!result || !result.content) throw new Error(`HTTP ${resp.status} (proxy also failed)`);
      html = result.content;
    }
  }
  return html;
}

/**
 * Pure parse of a VENUE_LISTING_PAGES venue's what's-on HTML into candidate
 * rows — the second half of fetchSingleVenuePage, split out (BRO-4204
 * S4-T11) so scripts/promote-owe-venue-candidates.js can re-fetch a venue
 * page through fetchPage() and ask "is this staged title still listed?"
 * with the SAME link pattern, title derivation and exclusion rules that
 * staged the candidate in the first place (CLAUDE.md §15: one parser, never
 * a copy in the promoter). Returns [] for a page too short to be a real
 * listing (a soft-404 / interstitial), which callers treat as "nothing
 * parsed", never as "the venue lists nothing".
 *
 * @param {{name: string, url: string, linkPattern: RegExp, titleFromSlug?: boolean, hasJsonLd?: boolean, category: string}} venue
 * @param {string} html
 * @returns {Array<object>} candidate rows in the staging shape
 */
function parseVenueListingPage(venue, html) {
  if (typeof html !== 'string' || html.length < 1000) return [];

  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const shows = [];
  const seen = new Set();

  // Strategy 1: JSON-LD TheaterEvent extraction (Arcola, future-proofing)
  if (venue.hasJsonLd) {
    const ldScripts = doc.querySelectorAll('script[type="application/ld+json"]');
    for (const script of ldScripts) {
      try {
        const parsed = JSON.parse(script.textContent);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item['@type'] !== 'TheaterEvent') continue;
          const title = cleanVenueTitle(item.name || '');
          if (!title || seen.has(title.toLowerCase())) continue;
          if (shouldExcludeVenueShow(title)) continue;

          seen.add(title.toLowerCase());
          // OLT startDate is first performance, not press night — same as TodayTix
          shows.push({
            title,
            venue: venue.name,
            slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
            openingDate: null,
            previewsStartDate: item.startDate || null,
            closingDate: item.endDate === 'null' ? null : item.endDate || null,
            category: venue.category === 'off-broadway' ? 'off-broadway' : (isWestEndVenue(venue.name) ? 'west-end' : 'off-west-end'),
            description: (item.description || '').substring(0, 500),
            // Venue-page adds have no cross-source corroboration — route through
            // validate-show-venue.js --all-provisional (CLAUDE.md rule 3).
            provisional: true,
            discoverySource: `venue-page:${venue.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
          });
        }
      } catch {}
    }
  }

  // Strategy 2: Link-based extraction (all venues, including JSON-LD as supplement)
  const links = doc.querySelectorAll('a[href]');
  for (const link of links) {
    const href = link.getAttribute('href') || '';
    if (!venue.linkPattern.test(href)) continue;
    // Skip navigation/category pages and online/virtual content
    if (/\/(past-shows|access|participation|account|login|logout|search|tag|category|page\/|online|virtual|digital)/i.test(href)) continue;

    // For venues with noisy link text (cards with concatenated content), extract title from URL slug or heading
    let title;
    if (venue.titleFromSlug) {
      const slug = href.split('#')[0].split('/').filter(Boolean).pop() || '';
      title = slug.replace(/-/g, ' ').replace(/^\w/, c => c.toUpperCase()).replace(/ \w/g, c => c.toUpperCase());
    } else {
      title = cleanVenueTitle(link.textContent || '');
    }
    if (!title || title.length < 3 || title.length > 60) continue;
    if (seen.has(title.toLowerCase())) continue;
    if (shouldExcludeVenueShow(title)) continue;
    // Skip generic link text and single-word category labels
    if (/^(read more|book now|buy tickets|find out more|view|details|more info|back|next|previous|more|book|drama|comedy|musical|theatre|cabaret|main house|later|all shows|past shows|participation)/i.test(title)) continue;
    if (/^stand.?up/i.test(title)) continue;

    seen.add(title.toLowerCase());
    shows.push({
      title,
      venue: venue.name,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: null,
      closingDate: null,
      category: isWestEndVenue(venue.name) ? 'west-end' : 'off-west-end',
      description: '',
      // Venue-page adds have no cross-source corroboration — route through
      // validate-show-venue.js --all-provisional (CLAUDE.md rule 3).
      provisional: true,
      discoverySource: `venue-page:${venue.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    });
  }

  return shows;
}

function cleanVenueTitle(raw) {
  let title = (raw || '').trim()
    .replace(/#\w+$/g, '')            // Strip URL fragment anchors (e.g., "#schedules")
    .replace(/&#8217;|&#8216;|[\u2018\u2019]/g, "'")
    .replace(/&#8220;|&#8221;|[\u201C\u201D]/g, '"')
    .replace(/&#8211;|[\u2013]/g, '\u2013').replace(/&#8212;|[\u2014]/g, '\u2014')
    .replace(/&#038;|&amp;/g, '&').replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ');
  // Strip leading venue-space labels (Soho Theatre uses "Soho " / "Walthamstow " prefixes)
  title = title.replace(/^(Soho|Walthamstow|Dean Street|Upstairs|Downstairs)\s+/i, '');
  // Strip trailing date patterns (e.g., "Show Name 3 - 24 March 2026")
  title = title.replace(/\s+\d{1,2}\s*[-–]\s*\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{4}\s*$/i, '');
  // Strip trailing "21 Apr - 9 May 2026" format
  title = title.replace(/\s+\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s*[-–]\s*\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s*\d{0,4}\s*$/i, '');
  // Strip "By Author Name..." FIRST — most common noise in venue card text
  // Capital "By" = attribution, not part of title (e.g., "BLINK By Phil Porter")
  title = title.replace(/\s+By\s+[A-Z].*$/, '');
  // Lowercase "by FirstName LastName..." (e.g., "Foalby Titas Halder" after concatenation)
  title = title.replace(/\bby\s+[A-Z][a-z]+\s+[A-Z][a-z].*$/, '');
  title = title.replace(/\s*(Written|Translated|Directed|Created|Adapted)\s+by\b.*$/i, '');
  // Strip trailing venue/presenter info
  title = title.replace(/\s+(presents?|at |Greenwich|Polka|West End|Broadway|Productions?).*$/i, '');
  // Strip "More Info" / "Book Now" / dates that got concatenated
  title = title.replace(/\s*(More Info|Book Now|Book Tickets|Find Out More)\s*$/i, '');
  title = title.replace(/\d{1,2}\s*[-–]\s*\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec).*$/i, '');
  // Strip trailing date like "Tue 17 Mar - Sat 21 Mar" or "Tue 31 Mar 21:00"
  title = title.replace(/\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s+\w+.*$/i, '');
  // Strip trailing "Tue 17 –" or "Thu 19 –" fragments
  title = title.replace(/\s+(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+\d{1,2}\s*[-–]?\s*$/i, '');
  return title.trim();
}

function shouldExcludeVenueShow(title) {
  // londonListingTitleRejected = the two substring lists + NON_THEATRE_TITLE_RE
  // (2026-09-29: "Bar Events" and "Stiles + Drewe Best New Song Prize" reached
  // shows.json through venue pages because only the substring lists ran here).
  if (londonListingTitleRejected(title)) return true;
  const lower = String(title || '').toLowerCase();
  if (VENUE_PAGE_EXCLUDE_PATTERNS.some(p => lower.includes(p))) return true;
  // A venue-page title ending in "Concert" is a one-off concert ("Scribbles
  // Concert", The Other Palace, promoted 2026-09-30, BRO-4398). Corpus-audited
  // 2026-09-30: no shows.json title ends in "concert" ("... in Concert" was
  // already refused by londonListingTitleRejected above).
  if (/\bconcerts?\W*$/.test(lower.trim())) return true;
  return false;
}

// ── Cross-source divergence logging ──

function logLTSourceDivergence(todayTixShows, oltShows, ltShows) {
  if (ltShows.length === 0) return;
  const normalize = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/^(the|a|an) /, '').trim();
  const otherTitles = new Set([
    ...todayTixShows.map(s => normalize(s.title)),
    ...oltShows.map(s => normalize(s.title)),
  ]);
  const ltOnly = ltShows.filter(s => !otherTitles.has(normalize(s.title)));
  console.log(`  LT OWE: ${ltShows.length} total, ${ltOnly.length} unique (not in TodayTix/OLT)`);
  if (ltOnly.length > 0) {
    const display = ltOnly.slice(0, 10).map(s => s.title);
    console.log(`  LT-only shows: ${display.join(', ')}${ltOnly.length > 10 ? ` ...+${ltOnly.length - 10} more` : ''}`);
  }
}

function logWESourceDivergence(todayTixShows, oltShows) {
  if (todayTixShows.length === 0 || oltShows.length === 0) return; // Can't compare

  const normalize = (t) => t.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/^(the|a|an) /, '').trim();
  const ttTitles = new Set(todayTixShows.map(s => normalize(s.title)));
  const oltTitles = new Set(oltShows.map(s => normalize(s.title)));

  const oltOnly = [...oltTitles].filter(t => !ttTitles.has(t));
  const ttOnly = [...ttTitles].filter(t => !oltTitles.has(t));
  const overlap = [...oltTitles].filter(t => ttTitles.has(t)).length;

  console.log(`  WE source overlap: ${overlap} shared, ${oltOnly.length} OLT-only, ${ttOnly.length} TodayTix-only`);
  if (oltOnly.length > 0) {
    const display = oltOnly.slice(0, 10);
    console.log(`  OLT-only shows: ${display.join(', ')}${oltOnly.length > 10 ? ` ...+${oltOnly.length - 10} more` : ''}`);
  }
  if (ttOnly.length > 0) {
    const display = ttOnly.slice(0, 10);
    console.log(`  TodayTix-only shows: ${display.join(', ')}${ttOnly.length > 10 ? ` ...+${ttOnly.length - 10} more` : ''}`);
  }
}

// ── TodayTix search for ShowScore candidate validation ──

function searchTodayTixByTitle(title, location = 1) {
  const query = encodeURIComponent(cleanSearchTitle(title));
  const url = `https://api.todaytix.com/api/v2/shows?query=${query}&location=${location}`;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (response) => {
      if (response.statusCode !== 200) {
        resolve(null);
        response.resume();
        return;
      }
      let data = '';
      response.on('data', chunk => data += chunk);
      response.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.data || json.data.length === 0) { resolve(null); return; }

          // Normalize for matching
          const normTitle = title.toLowerCase()
            .replace(/['']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

          // Exact match first
          const exact = json.data.find(s => {
            const n = (s.displayName || s.name || '').toLowerCase()
              .replace(/['']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
            return n === normTitle;
          });
          if (exact) { resolve(exact); return; }

          // Fuzzy match with containment check to prevent venue-based false matches
          // (e.g., searching "Beetlejuice" and getting "Mary Poppins" at same venue)
          const ourWords = normTitle.split(' ').filter(w => w.length > 2);
          for (const show of json.data) {
            const apiName = (show.displayName || show.name || '').toLowerCase()
              .replace(/['']/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
            const ourInTheirs = ourWords.filter(w => apiName.includes(w)).length;
            const ourRatio = ourWords.length > 0 ? ourInTheirs / ourWords.length : 0;
            if (ourRatio < 0.6) continue;

            // If all our words match AND we have >1 significant word, accept
            // (our title is contained in theirs, e.g., "Beetlejuice" → "Beetlejuice The Musical")
            // Single-word titles need exact match to avoid "Chicago" → "Chicago Fire"
            if (ourRatio >= 1.0 && ourWords.length > 1) {
              resolve(show);
              return;
            }
            // Single significant word: only match if API name has <=3 significant
            // words (prevents "Chicago" → "Chicago Fire" but allows "Cats" → "Cats The Musical")
            if (ourRatio >= 1.0 && ourWords.length === 1) {
              const theirWords = apiName.split(' ').filter(w => w.length > 2);
              const unmatched = theirWords.filter(w => !normTitle.includes(w));
              // Allow common suffixes (the, musical, show) but reject titles with
              // unrelated content words
              const theatreFluff = new Set(['the', 'musical', 'show', 'play', 'new', 'disneys', 'disney']);
              const realUnmatched = unmatched.filter(w => !theatreFluff.has(w));
              if (realUnmatched.length === 0) {
                resolve(show);
                return;
              }
              continue;
            }

            // Partial forward match: also require reverse containment to prevent
            // short-word overlap false positives
            const theirWords = apiName.split(' ').filter(w => w.length > 2);
            const theirsInOurs = theirWords.filter(w => normTitle.includes(w)).length;
            const theirRatio = theirWords.length > 0 ? theirsInOurs / theirWords.length : 0;
            if (theirRatio >= 0.4) {
              resolve(show);
              return;
            }
          }
          resolve(null);
        } catch { resolve(null); }
      });
      response.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

/**
 * Fetch a ShowScore page and extract status/dates from the info-top-line element.
 * Returns { ssStatus, openingDate, closingDate, venue, runtime } or null on failure.
 *
 * Status line formats:
 *   "Opens Mar 08"    → previews, openingDate = current year Mar 08
 *   "Open run"        → open
 *   "Ends Mar 28"     → open, closingDate = current year Mar 28
 *   "Ends May 2026"   → open, closingDate = 2026-05-31 (approx)
 *   "Closed"          → closed
 */
async function fetchShowScoreStatus(showScoreUrl) {
  try {
    const result = await fetchPage(showScoreUrl);
    if (!result || !result.content) return null;

    const dom = new JSDOM(result.content);
    const doc = dom.window.document;

    // Extract info-top-line content
    const topLine = doc.querySelector('.show-page-v2__info-top-line');
    if (!topLine) return null;

    // First text node contains the status
    const statusText = topLine.childNodes[0]?.textContent?.trim() || '';
    if (!statusText) return null;

    // Venue: shared chain in lib/show-score-status.js (old venue link, the
    // survey modal's venue-name attribute, then a known-venue <title>
    // parenthetical). A copy of that chain lived here and missed the
    // venue-name fallback, so every Show Score-only candidate deferred on
    // "no verified venue" (BRO-4432: The Tank's Falls for Jodie).
    const venue = venueFromShowScoreDoc(doc, topLine);

    // Extract runtime from second segment (between delimiters)
    const delimiters = topLine.querySelectorAll('.show-page-v2__info-top-line-delimiter');
    let runtime = null;
    if (delimiters.length >= 1) {
      const afterFirst = delimiters[0].nextSibling;
      if (afterFirst && afterFirst.nodeType === 3) { // text node
        const rtText = afterFirst.textContent.trim();
        if (/^\d+h\s*\d*m?$/.test(rtText)) runtime = rtText;
      }
    }

    let ssStatus = null;
    let openingDate = null;
    let closingDate = null;

    if (statusText.startsWith('Opens ')) {
      ssStatus = 'previews';
      openingDate = parseShortDate(statusText.replace('Opens ', ''));
    } else if (statusText === 'Open run') {
      ssStatus = 'open';
    } else if (statusText.startsWith('Ends ')) {
      ssStatus = 'open';
      closingDate = parseShortDate(statusText.replace('Ends ', ''));
    } else if (statusText === 'Closed') {
      ssStatus = 'closed';
    }

    return { ssStatus, openingDate, closingDate, venue, runtime };
  } catch (e) {
    console.warn(`  [SS] Failed to fetch ShowScore status for ${showScoreUrl}: ${e.message}`);
    return null;
  }
}

/**
 * Load and validate ShowScore candidates, converting them into the same shape
 * as TodayTix-discovered shows for the dedup pipeline.
 *
 * Tiered validation:
 *   Tier 1: Found on TodayTix → full metadata + all filters
 *   Tier 2: Not on TodayTix → ShowScore page scrape for status/dates
 *   Tier 3: ShowScore fetch fails → title-based filter only, null dates
 */
async function consumeShowScoreCandidatesFile() {
  let candidatesData;
  try {
    candidatesData = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.log('No ShowScore candidates file found, skipping');
    } else {
      console.warn(`Warning: could not parse ${CANDIDATES_PATH}: ${e.message}`);
    }
    return [];
  }

  const allCandidates = candidatesData.candidates || [];
  if (allCandidates.length === 0) {
    console.log('ShowScore candidates file is empty');
    return [];
  }

  // Only consume OB and WE candidates (Broadway is well-covered by TodayTix)
  const candidates = allCandidates.filter(c =>
    c.category === 'off-broadway' || isLondonMarket(c.category)
  );

  if (candidates.length === 0) {
    console.log('No OB/WE ShowScore candidates to process');
    return [];
  }

  console.log(`Processing ${candidates.length} ShowScore candidates (${allCandidates.length - candidates.length} Broadway skipped)...`);

  const validated = [];
  let ttConfirmed = 0;
  let ttMissing = 0;
  let filteredNonTheater = 0;
  let filteredOneNight = 0;

  for (const candidate of candidates) {
    const titleLower = candidate.title.toLowerCase();

    // Gate 1: Title-based non-theater filter (always applied)
    if (NON_THEATER_PATTERNS.some(pattern => titleLower.includes(pattern))) {
      filteredNonTheater++;
      if (verbose) console.log(`  [FILTERED] "${candidate.title}" — non-theater pattern`);
      continue;
    }
    if (EXCLUDED_TITLES.some(excluded => titleLower.includes(excluded))) {
      filteredNonTheater++;
      if (verbose) console.log(`  [FILTERED] "${candidate.title}" — excluded title`);
      continue;
    }
    // WE extra patterns
    if (isLondonMarket(candidate.category) && WE_EXTRA_PATTERNS.some(p => titleLower.includes(p))) {
      filteredNonTheater++;
      if (verbose) console.log(`  [FILTERED] "${candidate.title}" — WE extra pattern`);
      continue;
    }

    // Gate 2: Try TodayTix search for enrichment (optional, not required)
    const location = isLondonMarket(candidate.category) ? 2 : 1;
    let ttShow = null;
    try {
      ttShow = await searchTodayTixByTitle(candidate.title, location);
      await new Promise(r => setTimeout(r, 300)); // Rate limit
    } catch { /* TodayTix search failed — proceed without */ }

    if (ttShow) {
      // Full TodayTix validation: all gates apply (London candidates get the
      // outright non-theatre-venue rejection, NYC the Plays/Musicals override)
      if (isNonTheaterContent(ttShow, { market: isLondonMarket(candidate.category) ? 'london' : 'nyc' })) {
        filteredNonTheater++;
        if (verbose) console.log(`  [FILTERED] "${candidate.title}" — TT non-theater content`);
        continue;
      }
      if (isOneNightShow(ttShow)) {
        filteredOneNight++;
        if (verbose) console.log(`  [FILTERED] "${candidate.title}" — one-night event`);
        continue;
      }

      // Category cross-validation: ShowScore category should match TodayTix subcategories
      const subcatNames = (ttShow.subcategories || []).map(sc => sc.name);
      let categoryMatch = false;
      if (candidate.category === 'off-broadway') {
        categoryMatch = subcatNames.includes('Off Broadway') ||
          (subcatNames.includes('Broadway') && !subcatNames.includes('Off Broadway')); // Some OB shows tagged as Broadway on TT
      } else if (isLondonMarket(candidate.category)) {
        categoryMatch = subcatNames.includes('West End') || subcatNames.includes('Off West End');
      }
      if (!categoryMatch) {
        if (verbose) console.log(`  [SKIP] "${candidate.title}" — category mismatch (SS: ${candidate.category}, TT: ${subcatNames.join(',')})`);
        continue;
      }

      ttConfirmed++;
      const title = (ttShow.displayName || ttShow.name || candidate.title).trim();

      // For WE/OB shows, TodayTix startDate is first preview, NOT press night.
      // Scrape Show Score for the actual press night ("Opens Mar 09") date.
      // If ShowScore has no "Opens" date, leave openingDate null — don't guess.
      let openingDate = null;
      let openingDateSource = null;
      // TodayTix returns the literal string "null" (not JSON null) for shows
      // without confirmed dates — same quirk the closingDate guard 40 lines
      // below already handles. Fix #2 (Gap B, card #1446) now lets these
      // candidates reach this branch (previously always filtered out by
      // isOneNightShow's own "null" === "null" false-positive), so this raw
      // assignment needs the same guard or it writes the string "null" into
      // shows.json (adversarial ship-check finding).
      let previewsStartDate = ttShow.startDate === 'null' ? null : ttShow.startDate || null;
      // Hoisted so the venue fallback below can reuse this fetch instead of
      // discarding it — see the venueName resolution just after this block.
      let ssData = null;
      if (isLondonMarket(candidate.category) || candidate.category === 'off-broadway') {
        try {
          ssData = await fetchShowScoreStatus(candidate.showScoreUrl);
          await new Promise(r => setTimeout(r, 500));
        } catch { /* ShowScore fetch failed */ }
        if (ssData?.openingDate) {
          // Show Score "Opens X" = press night = true opening date
          openingDate = ssData.openingDate;
          openingDateSource = 'showscore';
          console.log(`    Date correction: TT startDate ${previewsStartDate} → previewsStart, SS "Opens" ${openingDate} → openingDate`);
        }
      } else {
        // Broadway: TodayTix startDate is used as openingDate until IBDB enrichment
        openingDate = ttShow.startDate === 'null' ? null : ttShow.startDate || null;
        openingDateSource = openingDate ? 'todaytix' : null;
      }

      // This branch previously wrote ttShow.venue straight through with no
      // guard at all (unlike the ShowScore-only branch below, which already
      // routed through sanitizeVenueForWrite). TodayTix's own venue field
      // can be a neighbourhood blob too — that's exactly how
      // jest-to-impress-off-broadway-2026 landed with venue:"Soho/Tribeca"
      // (card #994 S0 remainder). Route through the same guard and defer
      // (don't consume the candidate) rather than write a placeholder.
      //
      // Fall back to the ShowScore venue (already fetched above for the
      // opening date, and already guard-clean via fetchShowScoreStatus) when
      // TodayTix's own field is the one that's bad — otherwise a show whose
      // TodayTix venue is PERMANENTLY a blob (not a transient scrape glitch;
      // that's TodayTix's own stored data) re-enters this exact branch every
      // day, resolveTodayTixVenue(ttShow) rejects it every time, and it
      // skip-loops forever instead of the "deferred, retried next run" the
      // comment above promises (ship-check finding).
      const venueName = resolveTodayTixVenue(ttShow) || sanitizeVenueForWrite(ssData?.venue);
      if (!venueName) {
        console.log(`  [SKIP] "${candidate.title}" — no verified venue from TodayTix or ShowScore, deferring to next run (card #994)`);
        continue;
      }
      // Genre: tag non-play/musical performance types (dance/magic/comedy/cabaret/
      // concert/circus) so the WE/OWE routing keeps them off the West End
      // plays/musicals listing and on the Off-West End hub (see src/lib/genre.ts).
      // Conservative classifier — returns null unless a venue/title signal is
      // unambiguous, so plays/musicals are never mislabelled.
      const genre = classifyGenre({ title, venue: venueName, description: ttShow.description || '' });
      // Apply the genre-overrides-venue category rule at intake too, so a
      // non-theatrical show (dance at Sadler's Wells, etc.) never ships with
      // category="west-end" even momentarily — see applyGenreCategoryOverride.
      const category = applyGenreCategoryOverride(candidate.category, genre);
      validated.push({
        title,
        venue: venueName,
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        openingDate,
        openingDateSource,
        previewsStartDate,
        ...(genre ? { genre } : {}),
        closingDate: ttShow.endDate === 'null' ? null : ttShow.endDate || null,
        category,
        description: ttShow.description || '',
        todayTixCategory: ttShow.category?.name || null,
        _showScoreUrl: candidate.showScoreUrl,
        _source: 'showScore+todayTix',
      });
      console.log(`  [TT+SS] "${candidate.title}" → confirmed on TodayTix`);
    } else {
      // Not on TodayTix — scrape ShowScore page for status/dates.
      // ShowScore itself validates it's a real show (they curate listings).
      ttMissing++;

      let ssData = null;
      try {
        ssData = await fetchShowScoreStatus(candidate.showScoreUrl);
        await new Promise(r => setTimeout(r, 500)); // Rate limit
      } catch { /* ShowScore fetch failed — proceed with nulls */ }

      // Skip closed shows from ShowScore
      if (ssData?.ssStatus === 'closed') {
        if (verbose) console.log(`  [SKIP] "${candidate.title}" — ShowScore says Closed`);
        continue;
      }

      // ssData.venue is already sanitized (null when unknown/placeholder —
      // see fetchShowScoreStatus). Don't resurrect 'TBA' here: writing the
      // show now with a placeholder venue is exactly the S0 leak (card
      // #994, isla-off-broadway-2026). Defer instead — the candidate stays
      // unconsumed in show-score-candidates.json and gets retried on the
      // next daily run, once ShowScore/TodayTix can supply a real venue.
      const venue = ssData?.venue || null;
      if (!venue) {
        console.log(`  [SKIP] "${candidate.title}" — no verified venue yet (ShowScore ${ssData ? 'venue is a placeholder/blob' : 'fetch failed'}), deferring to next run (card #994)`);
        continue;
      }
      // Same London rule as the TodayTix-confirmed branch above: a
      // stadium/arena/concert-hall/cabaret venue or a receiving-house tour
      // stop rejects outright (2026 audit, BRO-4204). The aggregator
      // promoters remain the route in for anything critics actually review.
      if (isLondonMarket(candidate.category) && (isNonTheatreVenue(venue) || isLondonReceivingHouse(venue))) {
        filteredNonTheater++;
        if (verbose) console.log(`  [FILTERED] "${candidate.title}" — ShowScore venue "${venue}" is a non-theatre venue or receiving house`);
        continue;
      }
      const openingDate = ssData?.openingDate || null;
      const openingDateSource = openingDate ? 'showscore' : null;
      const closingDate = ssData?.closingDate || null;
      const source = ssData ? 'showScore+scraped' : 'showScore';

      validated.push({
        title: candidate.title,
        venue,
        slug: candidate.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        openingDate,
        openingDateSource,
        closingDate,
        category: candidate.category,
        description: '',
        todayTixCategory: null,
        _showScoreUrl: candidate.showScoreUrl,
        _showScoreStatus: ssData?.ssStatus || null,
        _source: source,
      });
      const dateInfo = openingDate ? ` (opens ${openingDate})` : ssData?.ssStatus ? ` (${ssData.ssStatus})` : '';
      console.log(`  [SS] "${candidate.title}" → not on TodayTix, adding from ShowScore${dateInfo}`);
    }
  }

  console.log(`ShowScore candidates: ${validated.length} validated (${ttConfirmed} TT-confirmed, ${ttMissing} SS-only), ${filteredNonTheater} non-theater, ${filteredOneNight} one-night`);
  return validated;
}

function loadShows() {
  const data = showsWriteGuard.loadShows();
  return data;
}

function saveShows(data) {
  if (!data._meta) data._meta = {};
  data._meta.lastUpdated = new Date().toISOString();

  // Dedup guard: parallel runs can both pass pre-insertion checks, creating duplicates.
  // Keep last occurrence (later entries have richer data from enrichment).
  const seen = new Set();
  const before = data.shows.length;
  for (let i = data.shows.length - 1; i >= 0; i--) {
    if (seen.has(data.shows[i].id)) {
      data.shows.splice(i, 1);
    } else {
      seen.add(data.shows[i].id);
    }
  }
  const removed = before - data.shows.length;
  if (removed > 0) {
    console.log(`⚠️  Dedup guard: removed ${removed} duplicate show(s) before saving`);
  }

  showsWriteGuard.saveShows(data);
}

// BRO-102 follow-up (task #1863): this is the first-write path for every
// newly-discovered Broadway show's creative team — the highest-risk of the
// IBDB creativeTeam consumers, since a bad write here ships before
// auto-fix-show-data.js's own IBDB step ever sees the show (that step only
// fires when the team is empty/1-entry, which won't be true once this
// write lands). Splits combined credits first so each individual name gets
// its own SERP query (a combined "John Doe & Jane Smith" name would never
// match a "directed by John Doe" snippet). Mutates show.creativeTeam only
// when at least one member survives verification — leaves it unset
// otherwise so a later enrichment pass can retry.
async function applyVerifiedIbdbCreativeTeam(show, ibdbCreativeTeam) {
  const { result } = splitCombinedCredits(ibdbCreativeTeam);
  const year = show.openingDate?.slice(0, 4) || 'upcoming';
  const verified = await verifyCreativeTeamViaSerp(show, result, year, 'serp-verified-ibdb-discovery');
  if (verified.length > 0) {
    show.creativeTeam = verified;
  } else {
    console.log(`    ⚠️  "${show.title}": No IBDB creative-team members passed SERP verification — leaving unset`);
  }
}

async function discoverShows() {
  console.log('='.repeat(60));
  console.log(includeWestEnd ? 'BROADWAY + WEST END SHOW DISCOVERY' : 'BROADWAY SHOW DISCOVERY');
  console.log('='.repeat(60));
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log('');

  const data = loadShows();

  console.log(`Existing shows in database: ${data.shows.length}`);
  console.log('');

  // Per-source candidate counts for this run, written to
  // data/audit/discovery-source-coverage.json at the end (card #1445). Every
  // source that runs records its count here, INCLUDING zero and INCLUDING a
  // source that threw — a source going silent is a defect signal, not noise
  // we swallow in a catch block.
  const sourceCounts = {};

  // Broadway union: TodayTix API + Playbill schedule article both run every
  // pass — no source is gated behind another returning zero (card #1445; the
  // prior Broadway.org fallback was dead code for exactly that reason).
  let discoveredShows;
  try {
    discoveredShows = tagSource(await fetchShowsFromTodayTix(), 'todaytix');
    sourceCounts.todaytix = discoveredShows.length;
    console.log(`Found ${discoveredShows.length} shows via TodayTix API`);
  } catch (e) {
    console.log(`TodayTix API failed (${e.message})`);
    sourceCounts.todaytix = 0;
    discoveredShows = [];
  }
  console.log('');

  // Broadway: Playbill schedule article — supplements TodayTix with a
  // source that publishes real openingDate values and covers a
  // subscription-house-style gap dedicated venue pages don't (card #1426).
  // Flat-pushed into discoveredShows so the existing checkForDuplicate /
  // findSameTitleTwinIfNoOpeningDate path adjudicates dups — no custom dedup
  // layer, same reasoning as the OB block below.
  // BRO-3123: this cap breach used to `return { newShows: [], count: 0 }`,
  // which discarded EVERY source's results for the whole run — including
  // TodayTix, fetched successfully just above — not just this one. That
  // silently zeroed discovery fleet-wide for 2.5+ weeks once real OB volume
  // (see OB_VENUE_CAP below) started tripping the equivalent OB check daily.
  // Now a cap breach skips only this source; other sources still land.
  const BROADWAY_SCHEDULE_CAP = 60;
  try {
    const playbillBroadwayShows = await fetchShowsFromPlaybillBroadway();
    sourceCounts.playbillBroadway = playbillBroadwayShows.length;
    if (playbillBroadwayShows.length > BROADWAY_SCHEDULE_CAP) {
      console.error(`::error::Playbill Broadway returned ${playbillBroadwayShows.length} candidates (cap: ${BROADWAY_SCHEDULE_CAP}) — likely parser regression. Skipping this source only.`);
      process.exitCode = 1;
    } else {
      discoveredShows.push(...tagSource(playbillBroadwayShows, 'playbill-broadway'));
    }
  } catch (e) {
    sourceCounts.playbillBroadway = 0;
    console.log(`⚠️  Playbill Broadway schedule failed (${e.message}), continuing with other sources`);
  }
  console.log('');

  // Off-Broadway: Playbill OB schedule article + non-profit venue pages.
  // Subscription houses (Atlantic, Vineyard, Signature, MCC) don't list on
  // TodayTix; Playbill covers most of them and each venue's own season page
  // covers the rest. Flat-pushed into discoveredShows so the existing
  // checkForDuplicate / findSameTitleTwinIfNoOpeningDate path adjudicates
  // dups — no custom dedup layer.
  //
  // Per-source candidate cap (OB_VENUE_CAP): one bad parser regression
  // can't flood shows.json. If a single source returns >cap candidates we
  // skip THAT source only (exitCode=1 for visibility) — see BRO-3123 above:
  // this used to `return` and discard every other source's results too,
  // which is how a real OB count of 38 (routine growth, not a regression)
  // silently zeroed the entire day's Broadway/OB/West End discovery.
  const OB_VENUE_CAP = 60;
  if (includeOffBroadway) {
    try {
      const playbillOBShows = await fetchShowsFromPlaybillOB();
      sourceCounts.playbillOB = playbillOBShows.length;
      if (playbillOBShows.length > OB_VENUE_CAP) {
        console.error(`::error::Playbill OB returned ${playbillOBShows.length} candidates (cap: ${OB_VENUE_CAP}) — likely parser regression. Skipping this source only.`);
        process.exitCode = 1;
      } else {
        discoveredShows.push(...tagSource(playbillOBShows, 'playbill-ob'));
      }
    } catch (e) {
      sourceCounts.playbillOB = 0;
      console.log(`⚠️  Playbill OB schedule failed (${e.message}), continuing with other sources`);
    }
    // TheaterMania OB listings (BRO-4381) — flat-pushed like Playbill OB, so
    // checkForDuplicate / the twin guard / the pending-fix guard adjudicate.
    try {
      const tmOBShows = await fetchShowsFromTheaterManiaOB();
      sourceCounts.theatermaniaOB = tmOBShows.length;
      // The live feed carries ~90 current rows before gates; twice the
      // per-venue cap leaves room for a busy season while still stopping a
      // parser regression that admits the historical 7,900-row market.
      const TM_OB_CAP = OB_VENUE_CAP * 2;
      if (tmOBShows.length > TM_OB_CAP) {
        console.error(`::error::TheaterMania OB returned ${tmOBShows.length} candidates (cap: ${TM_OB_CAP}) — likely parser regression. Skipping this source only.`);
        process.exitCode = 1;
      } else {
        discoveredShows.push(...tagSource(tmOBShows, 'theatermania-ob'));
      }
    } catch (e) {
      sourceCounts.theatermaniaOB = 0;
      console.log(`⚠️  TheaterMania OB failed (${e.message}), continuing with other sources`);
    }
    // OB venue listings — fan out to scrapeVenueListing per venue, capture
    // results to staging (NOT directly to shows.json). The promotion script
    // (scripts/promote-ob-venue-candidates.js, V-T6b) is what eventually
    // moves staged candidates to shows.json — gated by cross-validation
    // against Playbill OB / Lortel within 72h. This staging gate prevents
    // a venue-page redesign from accidentally firing premature broadcasts
    // to real subscribers (see /plan-review v2 P0 User Impact finding).
    try {
      // 6 readers at a time; the OvationTix orgs share one lane (one caller
      // on that API at a time: back-to-back calls drew 403s).
      const results = await settledWithConcurrency(OB_VENUE_CONFIGS, 6, v => scrapeVenueListing(v), {
        laneOf: v => (v.strategy === 'ovationtix' ? 'ovationtix' : null),
      });
      const all = [];
      for (let i = 0; i < results.length; i++) {
        const v = OB_VENUE_CONFIGS[i];
        const r = results[i];
        if (r.status === 'fulfilled') {
          if (r.value.length > OB_VENUE_CAP) {
            // Skip only this venue's candidates (BRO-3123) — matches the
            // OWE per-venue cap below, which already got this right.
            console.error(`::error::Venue ${v.name} returned ${r.value.length} candidates (cap: ${OB_VENUE_CAP}) — likely parser regression. Skipping this venue's candidates.`);
            process.exitCode = 1;
            continue;
          }
          // Per-venue rolling-median anomaly gate. Fail-soft (warns + sets
          // exitCode but discovery continues for other venues).
          // anomalyKey: a venue whose reader changed (BRO-4396: SoHo Playhouse
          // moved to OvationTix, ~15 → ~32 rows) starts a fresh baseline
          // instead of tripping the 2x-median gate for a week.
          checkVenueAnomaly(v.anomalyKey || v.name, r.value.length);
          console.log(`  ${v.name}: ${r.value.length} candidates → staging`);
          all.push(...r.value);
        } else {
          console.log(`  ${v.name}: failed (${r.reason?.message})`);
        }
      }
      sourceCounts.obVenueListings = all.length;
      if (all.length > 0 && !dryRun) writeStagingCandidates(all);
      else if (dryRun) console.log(`  (dry-run: would stage ${all.length} candidates)`);
    } catch (e) {
      sourceCounts.obVenueListings = 0;
      console.log(`⚠️  OB venue scraping failed (${e.message}), continuing with other sources`);
    }
    console.log('');
  }

  // West End discovery via TodayTix London API + Official London Theatre (SOLT)
  if (includeWestEnd && timeBudget.exceeded()) {
    console.log(`⏱ Time budget (${timeBudget.minutes} min) reached — skipping West End discovery this run.`);
  } else if (includeWestEnd) {
    // Fetch all five sources in parallel
    const [todayTixResult, oltResult, tmResult, ltResult, venueResult] = await Promise.allSettled([
      fetchShowsFromTodayTixLondon(),
      fetchShowsFromOfficialLondonTheatre(),
      fetchShowsFromTheatremonkey(data.shows),
      fetchShowsFromLondonTheatre(),
      fetchShowsFromOweVenues()
    ]);

    const todayTixWEShows = todayTixResult.status === 'fulfilled' ? todayTixResult.value : [];
    const oltShows = oltResult.status === 'fulfilled' ? oltResult.value : [];
    const tmShows = tmResult.status === 'fulfilled' ? tmResult.value : [];
    const ltShows = ltResult.status === 'fulfilled' ? ltResult.value : [];
    const venueShows = venueResult.status === 'fulfilled' ? venueResult.value : [];

    if (todayTixResult.status === 'rejected') {
      console.log(`⚠️  TodayTix London API failed (${todayTixResult.reason?.message}), continuing with other sources`);
    } else {
      console.log(`Found ${todayTixWEShows.length} West End shows via TodayTix London API`);
      if (todayTixWEShows.length > 0 && todayTixWEShows.length < 20) {
        console.log(`⚠️  WARNING: TodayTix London returned unusually few shows (${todayTixWEShows.length}). Expected 50+.`);
      }
    }

    if (oltResult.status === 'rejected') {
      console.log(`⚠️  OLT fetch failed (${oltResult.reason?.message}), continuing with other sources`);
    } else {
      console.log(`Found ${oltShows.length} West End shows via Official London Theatre`);
    }

    if (tmResult.status === 'rejected') {
      console.log(`⚠️  Theatremonkey fetch failed (${tmResult.reason?.message}), continuing with other sources`);
    } else {
      console.log(`Found ${tmShows.length} West End shows via Theatremonkey`);
    }

    // S4-T5 (2026 data audit, BRO-4204): per-source last-success markers,
    // data/audit/<source>-last-success.json, written on EVERY parse — a
    // non-empty parse stamps `at`/`count`; a rejection or an empty parse
    // bumps the marker's empty streak, and three in a row logs the soft-404
    // warning (scripts/lib/source-last-success.js). Deliberately NOT gated
    // on --dry-run like the coverage telemetry further down: a dry run still
    // fetched and parsed the page, and "when did this source last work" is a
    // fact about the source, not about what we did with the result.
    recordParseResult('olt', oltShows.length);
    recordParseResult('theatremonkey', tmShows.length);

    if (ltResult.status === 'rejected') {
      console.log(`⚠️  LondonTheatre.co.uk fetch failed (${ltResult.reason?.message}), continuing with other sources`);
    } else {
      console.log(`Found ${ltShows.length} OWE shows via LondonTheatre.co.uk`);
    }

    // OWE venue-page candidates are staged, NOT pushed into discoveredShows
    // (BRO-182 — these are unvalidated scrapes of venue what's-on pages,
    // which list one-night talks/tribute concerts alongside real productions.
    // Mirrors the Off-Broadway venue-listing gate above: candidates land in
    // data/audit/owe-venue-candidates.json and only reach shows.json via
    // scripts/promote-owe-venue-candidates.js).
    if (venueResult.status === 'rejected') {
      console.log(`⚠️  OWE venue pages failed (${venueResult.reason?.message}), continuing with other sources`);
    } else if (venueShows.length > 0) {
      console.log(`Found ${venueShows.length} candidates via OWE venue pages → staging`);
      if (!dryRun) writeOweStagingCandidates(venueShows);
      else console.log(`  (dry-run: would stage ${venueShows.length} candidates)`);
    }

    if (todayTixWEShows.length === 0 && oltShows.length === 0 && tmShows.length === 0 && ltShows.length === 0) {
      console.log(`⚠️  CRITICAL: All four London sources returned 0 shows — check API/scraper health`);
    }

    // Cross-source divergence logging (diagnostic)
    logWESourceDivergence(todayTixWEShows, oltShows);
    logLTSourceDivergence(todayTixWEShows, oltShows, ltShows);

    sourceCounts.todaytixWE = todayTixWEShows.length;
    sourceCounts.olt = oltShows.length;
    sourceCounts.theatremonkey = tmShows.length;
    sourceCounts.londonTheatre = ltShows.length;
    sourceCounts.oweVenues = venueShows.length;

    // TodayTix first (richer metadata), OLT second, TM third, LT fourth —
    // venue-page candidates are staged above, not merged here. Dedup prefers
    // earlier entries among the sources that DO write directly.
    // tagSource() mutates in place and is called for its side effect, not its
    // return value, so the discoveredShows.push(...) line right below stays
    // byte-for-byte the literal pattern
    // tests/unit/discover-new-shows-owe.test.mjs regex-matches to prove
    // venueShows never joins this call (BRO-182).
    tagSource(todayTixWEShows, 'todaytix-we');
    tagSource(oltShows, 'olt');
    tagSource(tmShows, 'theatremonkey');
    tagSource(ltShows, 'londontheatre');
    discoveredShows.push(...todayTixWEShows, ...oltShows, ...tmShows, ...ltShows);
    console.log('');
  }

  // ShowScore candidates: validated OB/WE shows from ShowScore listings
  // that aren't in our DB yet. Joins the same dedup pipeline as TodayTix shows.
  const consumedCandidateUrls = []; // ShowScore URLs for newly added shows
  const processedCandidateUrls = new Set(); // ALL processed URLs (for pruning)
  if (consumeShowScoreCandidates && timeBudget.exceeded()) {
    console.log(`⏱ Time budget (${timeBudget.minutes} min) reached — skipping ShowScore candidate processing this run.`);
  } else if (consumeShowScoreCandidates) {
    console.log('');
    console.log('🔍 Processing ShowScore candidates...');
    try {
      // Load all candidates to track which ones we processed
      try {
        const candidatesData = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
        for (const c of (candidatesData.candidates || [])) {
          if (c.category === 'off-broadway' || isLondonMarket(c.category)) {
            processedCandidateUrls.add(c.showScoreUrl);
          }
        }
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`Warning: could not parse ${CANDIDATES_PATH}: ${e.message}`);
      }

      const ssValidated = await consumeShowScoreCandidatesFile();
      sourceCounts.showScoreCandidates = ssValidated.length;
      if (ssValidated.length > 0) {
        // Track ShowScore URLs for post-save assignment
        for (const s of ssValidated) {
          if (s._showScoreUrl) consumedCandidateUrls.push({ title: s.title, url: s._showScoreUrl });
        }
        discoveredShows.push(...tagSource(ssValidated, 'showscore'));
        console.log(`Added ${ssValidated.length} ShowScore candidates to discovery pipeline`);
      }
    } catch (e) {
      sourceCounts.showScoreCandidates = 0;
      console.log(`⚠️  ShowScore candidate processing failed (continuing without): ${e.message}`);
    }
    console.log('');
  }

  // Per-source contribution telemetry (card #1445): record this run's
  // candidate counts, including zero, so a source going silent for
  // consecutive runs is a detected defect instead of quiet rot (the
  // TodayTix-only-for-months incident this guards against). Fail-soft —
  // telemetry writing itself must never block discovery. Gated on !dryRun
  // (same contract as check-broadway-source-coverage.js's --dry-run) so a
  // dry-run invocation can't advance the real zeroStreak/totalRuns state.
  if (!dryRun) {
    try {
      const { recordDiscoveryRun } = require('./lib/discovery-source-coverage');
      const { silentSources } = recordDiscoveryRun(sourceCounts);
      if (silentSources.length > 0) {
        console.error(`::error::Discovery source(s) contributing 0 for ${silentSources.map(s => `${s.name} (${s.zeroStreak} runs)`).join(', ')} — possible source outage.`);
        process.exitCode = 1;
        const { sendAlert } = require('./lib/discord-notify');
        await sendAlert({
          severity: 'error',
          title: `Discovery source coverage: ${silentSources.length} source(s) gone silent`,
          description: silentSources.map(s => `**${s.name}**: 0 candidates for ${s.zeroStreak} consecutive runs (last non-zero: ${s.lastNonZeroAt || 'never'})`).join('\n'),
        });
      }
    } catch (e) {
      console.log(`⚠️  Source-coverage telemetry failed (${e.message}), continuing`);
    }
  }

  // Find new shows not in our database using improved duplicate detection
  const newShows = [];
  const skippedDuplicates = [];
  // S0-T3 (2026 data audit): candidates refused because the id they would
  // mint, or their normalized title+venue, is in data/retired-show-ids.json.
  // Kept apart from skippedDuplicates: a duplicate has an existing row to
  // point at, a retired id has a deletion that must stay deleted.
  const retiredSkipped = [];
  // Gap C (card #1446): shows discovery correctly re-matches to an existing
  // shows.json entry, but the entry's stale preview/opening date and venue
  // are never refreshed from the live source. reconciledShows tracks the
  // patches applied below so the summary/save logic knows there's something
  // to write even when zero brand-new shows were found this run.
  const reconciledShows = [];
  const existingSlugs = new Set(data.shows.map(s => s.slug));
  const existingIds = new Set(data.shows.map(s => s.id));

  // BRO-3863 — oracle 2 of the venue-suffix detector (see
  // scripts/lib/title-venue-suffix.js): the set of venue names the corpus
  // already knows about, so a title ending in "(Soho Playhouse)" is
  // recognised even when THIS row's own venue field says something else.
  // Built once from the pre-existing corpus rather than per candidate.
  const discoveryVenueVocabulary = buildVenueVocabulary(data.shows);

  // Shows queued by pending-fix add-show plans (BRO-4381) — see the guard in
  // the candidate loop below.
  const pendingAddShows = loadPendingAddShows();

  // Build todaytixId index for fast dedup
  const existingTodaytixIds = new Map();
  for (const s of data.shows) {
    if (s.todaytixId) existingTodaytixIds.set(s.todaytixId, s);
  }

  // Records candidate patches keyed by existing show id (BRO-2072) instead of
  // applying immediately — resolveReconciliationProposals() below decides,
  // once every discoveredShows candidate in this run has been matched,
  // whether each field is corroborated by >=2 independent sources before
  // touching shows.json. `existing` objects are references into data.shows,
  // so the eventual Object.assign in the resolver is what saveShows(data)
  // persists.
  //
  // Gated to HIGH-CONFIDENCE match reasons only (adversarial ship-check
  // finding, card #1446): checkForDuplicate() also returns fuzzy/containment/
  // slug-prefix matches, which exist specifically to catch messy title
  // variants — exactly the cases where "these are definitely the same show"
  // is least certain. Mutating shows.json on a fuzzy match risk writing one
  // show's live-source data onto a DIFFERENT show that merely has a similar
  // title. Reconciliation only fires for reasons that assert real identity
  // equality (exact title/slug, ID base) — todaytixId matches (Step 0 below)
  // are separately high-confidence and always eligible.
  const HIGH_CONFIDENCE_REASON_PREFIXES = ['Exact title match', 'Exact slug match', 'ID base match'];
  // existingId -> { existing, fields: {
  //   openingDate?: Map<dateValue, { sources: Set<sourceLabel>, openingDateSource }>,
  //   previewsStartDate?: Map<value, Set<sourceLabel>>,
  //   venue?: Map<value, Set<sourceLabel>>,
  // } }
  // openingDate keys its own openingDateSource per proposed VALUE (not as an
  // independently-resolved field) so a winning date's provenance always
  // comes from a candidate that actually proposed that date — resolving
  // date and source-label as two separately-voted fields could pair a
  // majority-popular source LABEL with a date that label never proposed
  // (ship-check finding on the first version of this fix).
  const reconciliationProposals = new Map();
  function reconcileMatchedShow(existing, candidate, reason) {
    if (reason && !HIGH_CONFIDENCE_REASON_PREFIXES.some(p => reason.startsWith(p))) return;
    const patch = computeShowReconciliation(existing, candidate);
    if (!patch) return;
    let proposal = reconciliationProposals.get(existing.id);
    if (!proposal) {
      proposal = { existing, fields: {} };
      reconciliationProposals.set(existing.id, proposal);
    }
    const sourceLabel = candidate._discoverySource || 'unknown';
    if (patch.openingDate) {
      if (!proposal.fields.openingDate) proposal.fields.openingDate = new Map();
      const byDate = proposal.fields.openingDate;
      if (!byDate.has(patch.openingDate)) {
        byDate.set(patch.openingDate, { sources: new Set(), openingDateSource: patch.openingDateSource });
      }
      byDate.get(patch.openingDate).sources.add(sourceLabel);
    }
    for (const field of ['previewsStartDate', 'venue']) {
      if (!patch[field]) continue;
      if (!proposal.fields[field]) proposal.fields[field] = new Map();
      const byValue = proposal.fields[field];
      if (!byValue.has(patch[field])) byValue.set(patch[field], new Set());
      byValue.get(patch[field]).add(sourceLabel);
    }
  }

  // Resolves every accumulated proposal (BRO-2072 gap #1) via the pure
  // resolveReconciliationFields (scripts/lib/discovery-reconcile.js): picks
  // the value with the most agreeing independent sources per field, then
  // gates application through evaluateReconciliationSafety — a value seen
  // from >=2 sources this run is trusted outright; a single source is only
  // trusted for a small date nudge (the original card #1446 drift-repair
  // case), never a venue change, a date fill with no existing baseline to
  // sanity-check against, or a large date jump.
  //
  // A circuit breaker (mirrors change-stability-guard.js, used the same way
  // by enrich-off-broadway-dates.js) sits in front of applying ANY patch
  // this run: 2+ sources suffering a correlated failure (shared upstream
  // outage/cache) could otherwise sail past the per-field agreement check
  // above and rewrite every matched show's date/venue in one run. Tripping
  // it holds every proposed patch for manual review instead of aborting the
  // whole discovery run (reconciliation is one of several things this
  // script does per run).
  function resolveReconciliationProposals() {
    const decisions = [];
    for (const { existing, fields } of reconciliationProposals.values()) {
      const { patch, heldFields } = resolveReconciliationFields(existing, fields);
      decisions.push({ existing, patch, heldFields });
    }

    const toApply = decisions.filter(d => Object.keys(d.patch).length > 0);
    const stability = validateChangeStability({
      name: 'discover-new-shows-reconciliation',
      changes: toApply.map(d => ({ id: d.existing.id })),
      candidateCount: reconciliationProposals.size,
      thresholds: { absoluteChanges: 15, changePercent: 0.5 },
    });

    const auditEntries = [];
    if (!stability.ok) {
      console.error(`::error::Reconciliation circuit breaker tripped (${stability.reason}) — holding all ${toApply.length} proposed patch(es) this run for manual review.`);
      process.exitCode = 1;
      for (const { existing, patch } of toApply) {
        console.log(`  ⏸️  "${existing.title}" (${existing.id}): held ALL field(s) — circuit breaker (${stability.reason})`);
        auditEntries.push({ kind: 'held', id: existing.id, title: existing.title, field: Object.keys(patch).join(','), value: patch, agreeingSourceCount: null, reason: `circuit-breaker: ${stability.reason}` });
      }
    } else {
      for (const { existing, patch } of toApply) {
        const before = {};
        for (const field of Object.keys(patch)) before[field] = existing[field] ?? null;
        reconciledShows.push({ id: existing.id, title: existing.title, patch });
        console.log(`  🔄 "${existing.title}" (${existing.id}): refreshing stale field(s) from live source — ${Object.keys(patch).join(', ')}`);
        if (!dryRun) Object.assign(existing, patch);
        auditEntries.push({ kind: 'applied', id: existing.id, title: existing.title, before, after: patch });
      }
    }

    for (const { existing, heldFields } of decisions) {
      for (const held of heldFields) {
        console.log(`  ⏸️  "${existing.title}" (${existing.id}): held reconciliation of ${held.field} (${held.reason}) — needs a 2nd corroborating source`);
        auditEntries.push({ kind: 'held', id: existing.id, title: existing.title, ...held });
      }
    }
    appendReconciliationAudit(auditEntries, { mode: { dryRun } });
  }

  // BRO-3863 — normalise every candidate title BEFORE anything reads it.
  //
  // Show-Score's listing pages disambiguate same-title productions in their
  // own UI by appending the venue ("The Cherry Orchard (Park Avenue
  // Armory)"), and the Show-Score branch above takes that display string as
  // the title verbatim. Left in place it propagates into `slug` and `id`,
  // which is why the corpus carries rows literally named
  // the-cherry-orchard-park-avenue-armory-off-broadway-2026.
  //
  // This runs HERE, ahead of the dedup/twin loop below, not next to
  // slugify() further down. deduplication.js's ordinary matcher already
  // strips parentheticals, but its no-opening-date twin guard compares
  // LITERAL titles — so a venue-qualified candidate slipped past that one
  // specific protection and only acquired the existing show's title
  // afterwards, minting a duplicate row. Normalising first means every
  // downstream comparison sees the title the row will actually have
  // (adversarial review finding).
  // BRO-3920 — a shouted title is no longer auto-corrected (guessing from
  // the shouted string alone already shipped wrong titles), so it must not
  // reach shows.json unlabeled either: validate-data.js's gate would only
  // catch it AFTER this run has already written it, failing CI for the
  // whole batch instead of just holding the one bad candidate. Quarantine
  // here — same shape as the circuit-breaker "held" path below.
  const heldForTitleReview = [];
  discoveredShows = discoveredShows.filter(show => {
    const titleFix = normalizeShowTitle(show, { venueVocabulary: discoveryVenueVocabulary });
    if (titleFix.changed) {
      console.log(`  [TITLE] "${show.title}" -> "${titleFix.title}" (${titleFix.steps.map(st => st.kind).join(' + ')})`);
      show.title = titleFix.title;
    }
    if (titleFix.manualReview) {
      console.log(`  [TITLE] ⏸️  "${show.title}" held — looks shouted, needs a human to check the source's structured metadata (see scripts/lib/title-display-case.js)`);
      heldForTitleReview.push({ title: show.title, venue: show.venue, source: show._discoverySource || show.source || null });
      return false;
    }
    return true;
  });
  if (heldForTitleReview.length) {
    console.log(`${heldForTitleReview.length} candidate(s) held this run for shouted-title review — not promoted, not written.`);
  }

  for (const show of discoveredShows) {
    // S0-T3 (2026 data audit): a retired id never comes back. This runs
    // BEFORE every dedup check because none of them can see a deleted row —
    // the phantom "?tab=dates" row was deleted by hand and re-minted by the
    // next run for exactly that reason. Match on the id this iteration would
    // mint OR on the archived row's exact normalized title+venue (a re-slugged
    // title or a different id-year still names the same retired listing).
    const minted = mintCandidateId(show);
    // Venue goes through sanitizeVenueForWrite so a placeholder ("TBA", "West End")
    // can never match a retired title+venue pair; matchesRetired normalizes the rest.
    const candidateVenue = sanitizeVenueForWrite(show.venue);
    const retiredHit = matchesRetired({ id: minted.showId, title: show.title, venue: sanitizeVenueForWrite(show.venue) });
    if (retiredHit) {
      console.log(`  retired-skip: ${minted.showId} ("${show.title}" @ ${candidateVenue || 'no venue'}) matched retired ${retiredHit.id} by ${retiredHit.matchedBy}`);
      retiredSkipped.push({
        title: show.title,
        venue: sanitizeVenueForWrite(show.venue),
        candidateId: minted.showId,
        retiredId: retiredHit.id,
        matchedBy: retiredHit.matchedBy,
      });
      continue;
    }

    // Step 0: TodayTix ID dedup — most reliable, catches name mismatches
    if (show.todaytixId && existingTodaytixIds.has(show.todaytixId)) {
      const existing = existingTodaytixIds.get(show.todaytixId);
      reconcileMatchedShow(existing, show, null);
      skippedDuplicates.push({
        title: show.title,
        reason: `Same TodayTix ID (${show.todaytixId}) as existing show`,
        existingId: existing.id
      });
      continue;
    }

    // Use the new comprehensive duplicate check
    const duplicateCheck = checkForDuplicate(show, data.shows);

    if (duplicateCheck.isDuplicate) {
      if (duplicateCheck.existingShow) reconcileMatchedShow(duplicateCheck.existingShow, show, duplicateCheck.reason);
      skippedDuplicates.push({
        title: show.title,
        reason: duplicateCheck.reason,
        existingId: duplicateCheck.existingShow?.id
      });
      continue;
    }

    // BRO-4381 ship-check: TheaterMania's coarse venue names defeat the venue
    // half of checkForDuplicate; an exact title in the NYC pool, still
    // running or within a year, is the same production.
    if (show._discoverySource === 'theatermania-ob') {
      const twin = findTmSameTitleShow(show, data.shows) || findTmSameTitleShow(show, pendingAddShows);
      if (twin) {
        skippedDuplicates.push({
          title: show.title,
          reason: `TheaterMania same-title match (venue "${show.venue}" vs "${twin.venue}")${twin._pendingFix ? `, queued by pending-fix plan ${twin._pendingFix}` : ''}`,
          existingId: twin.id,
        });
        continue;
      }
    }

    // BRO-4381: a show queued by a pending-fix add-show plan (e.g. BRO-4377's
    // 16 OB shows) is not in shows.json until execute-approved-fix applies it.
    // Minting a discovery row first would leave two rows once the plan
    // applies (add-show refuses an existing id, not a same-show row under a
    // different id).
    const pendingCheck = checkForDuplicate(show, pendingAddShows);
    if (pendingCheck.isDuplicate) {
      skippedDuplicates.push({
        title: show.title,
        reason: `Queued by pending-fix plan ${pendingCheck.existingShow?._pendingFix || '?'}: ${pendingCheck.reason}`,
        existingId: pendingCheck.existingShow?.id,
      });
      continue;
    }

    // Globe-incident guard (2026-05-09) — see findSameTitleTwinIfNoOpeningDate.
    const titleTwin = findSameTitleTwinIfNoOpeningDate(show, data.shows);
    if (titleTwin) {
      skippedDuplicates.push({
        title: show.title,
        reason: `Same-title twin in same market pool with no openingDate to confirm separate production: ${titleTwin.id}`,
        existingId: titleTwin.id,
      });
      continue;
    }

    // Intra-batch dedup: also check against shows already accepted in this batch
    // This catches cases where TodayTix and ShowScore discover the same show
    const batchDuplicateCheck = checkForDuplicate(show, newShows);
    if (batchDuplicateCheck.isDuplicate) {
      skippedDuplicates.push({
        title: show.title,
        reason: `Duplicate within discovery batch: ${batchDuplicateCheck.reason}`,
        existingId: batchDuplicateCheck.existingShow?.id || batchDuplicateCheck.existingShow?.title
      });
      continue;
    }

    // Apply the Globe-incident guard intra-batch too — two same-title/no-date
    // candidates in one run could otherwise both land via the venue escape
    // hatch in checkForDuplicate.
    const batchTitleTwin = findSameTitleTwinIfNoOpeningDate(show, newShows);
    if (batchTitleTwin) {
      skippedDuplicates.push({
        title: show.title,
        reason: `Same-title twin within discovery batch with no openingDate: ${batchTitleTwin.id || batchTitleTwin.title}`,
        existingId: batchTitleTwin.id || batchTitleTwin.title,
      });
      continue;
    }

    // ISO dates, id-year, market slug and the id itself all come from the
    // ONE mintCandidateId() call at the top of this iteration (S0-T3) — see
    // that helper for the id-year rule (2027-Encores! chain) and the
    // market-suffix idempotency note (BRO-3237). Nothing between there and
    // here mutates `show`, so this is byte-for-byte the id the retired-id
    // check just cleared.
    const { openingDate, closingDate, previewsStartDate, idYear, idYearProvisional, marketSlug, showId } = minted;

    // Guard: skip if generated ID collides with existing DB or batch.
    if (existingIds.has(showId)) {
      skippedDuplicates.push({ title: show.title, reason: `ID collision: ${showId} already exists`, existingId: showId });
      continue;
    }

    // The market slug carries NO year, so it fits exactly one production per
    // title per market — forever. Every later production of the same title
    // was dropped here as a "Slug collision" rather than disambiguated, which
    // is the fourth and last link in the 2027-Encores! chain: "You're a Good
    // Man, Charlie Brown" cleared the twin guard and the ID guard and still
    // died on `youre-a-good-man-charlie-brown-off-broadway` (held by the March
    // 2026 92NY run).
    //
    // Disambiguate with the year instead. Suffix the NEW show, so the existing
    // entry keeps its bare slug and its live URL.
    //
    // Note this is the SAFE choice, not the ideal one. shows.json's convention
    // is the opposite: the CURRENT production holds the bare slug and earlier
    // ones carry a year (death-of-a-salesman / -2022 / -2012 / -1999). Honouring
    // that here would mean renaming an existing row's slug and adding a
    // redirect, i.e. changing a live URL from inside the daily discovery cron —
    // too blunt for this path. So the bare slug can end up pointing at a closed
    // predecessor until someone re-canonicalizes it deliberately (carried as its
    // own card; adversarial review 2026-08-12). A year-suffixed page that exists
    // still beats the show being dropped entirely, which is what happened before.
    let slug = marketSlug;
    if (existingSlugs.has(slug)) {
      const yearScoped = `${marketSlug}-${idYear}`;
      if (existingSlugs.has(yearScoped)) {
        skippedDuplicates.push({ title: show.title, reason: `Slug collision: ${slug} and ${yearScoped} both already exist`, existingId: yearScoped });
        continue;
      }
      console.log(`  ↳ "${show.title}": slug "${marketSlug}" taken by an earlier production → using "${yearScoped}"`);
      slug = yearScoped;
    }

    // Track to prevent intra-batch slug/ID collisions
    existingIds.add(showId);
    existingSlugs.add(slug);

    newShows.push({
      ...show,
      slug: slug,
      id: showId,
      openingDate,
      previewsStartDate,
      closingDate,
      // S5-T4: only stamped when the id year is the current-year fallback —
      // see mintCandidateId. A dated row carries no flag at all.
      ...(idYearProvisional ? { idYearProvisional: true } : {}),
    });
  }

  // Every discoveredShows candidate has now been matched or accepted as new —
  // resolve the accumulated reconciliation proposals (BRO-2072) before any
  // save/summary logic below reads reconciledShows.
  resolveReconciliationProposals();

  // IBDB date enrichment: get accurate preview/opening/closing dates
  // Skip off-Broadway and London shows — IBDB only covers Broadway
  const broadwayNewShows = newShows.filter(s => s.category !== 'off-broadway' && !isLondonMarket(s.category));
  const offBroadwayNewShows = newShows.filter(s => s.category === 'off-broadway');
  const westEndNewShows = newShows.filter(s => isLondonMarket(s.category));
  if (offBroadwayNewShows.length > 0) {
    console.log(`⏭️  Skipping IBDB enrichment for ${offBroadwayNewShows.length} off-Broadway shows (IBDB is Broadway-only)`);
  }
  if (westEndNewShows.length > 0) {
    console.log(`⏭️  Skipping IBDB enrichment for ${westEndNewShows.length} West End shows (IBDB is Broadway-only)`);
  }
  if (broadwayNewShows.length > 0) {
    console.log('');
    console.log('🔎 Enriching dates from IBDB...');
    try {
      const lookupList = broadwayNewShows.map(s => ({
        title: s.title,
        // 2026-05-26: was `|| new Date().getFullYear()` — a fabricated year
        // could partially pass the IBDB year-gate against a wrong production.
        // Better to pass undefined so lookupIBDBDates clears creativeTeam.
        openingYear: s.openingDate ? parseInt(s.openingDate.split('-')[0]) : undefined,
        venue: s.venue
      }));

      const ibdbResults = await batchLookupIBDBDates(lookupList);

      for (const show of broadwayNewShows) {
        const ibdb = ibdbResults.get(show.title);
        if (!ibdb || !ibdb.found) {
          // IBDB lookup failed: treat Broadway.org "Begins:" as previewsStartDate
          // since it's often the preview start, not the true opening
          if (show.openingDate) {
            show.previewsStartDate = show.openingDate;
            show.openingDate = null;
            show.openingDateSource = null;
            console.log(`  ℹ️  "${show.title}": No IBDB data, treating Begins date as previewsStartDate`);
          }
          continue;
        }

        // Wrong-production guard: IBDB matches by title, so a newly-discovered revival can
        // match its ORIGINAL staging and get stamped its decades-old dates (a-few-good-men-2026
        // got 1989-11-15 + openingDateSource:ibdb this way, 2026-06-28). If the IBDB opening
        // year is implausible for this production, treat it as a no-IBDB match: keep the
        // Broadway.org "Begins:" as previewsStartDate and leave openingDate null.
        if (ibdb.openingDate && ibdbYearMismatch(show, ibdb.openingDate)) {
          console.log(`  ⛔ "${show.title}": IBDB opening ${ibdb.openingDate} implausible (expected ~${expectedShowYear(show)}) — wrong-production match, not applying IBDB dates`);
          if (show.openingDate) {
            show.previewsStartDate = show.openingDate;
            show.openingDate = null;
            show.openingDateSource = null;
          }
          continue;
        }

        // IBDB opening date is authoritative - overwrite Broadway.org "Begins:"
        if (ibdb.openingDate) {
          show.openingDate = ibdb.openingDate;
          show.openingDateSource = 'ibdb';
        }

        // Fill in preview start date
        if (ibdb.previewsStartDate) {
          show.previewsStartDate = ibdb.previewsStartDate;
        }

        // Fill in closing date if available — route through guard so any
        // existing humanCorrectedClosingDate=true is honored.
        if (ibdb.closingDate && !show.closingDate) {
          writeClosingDate(show, ibdb.closingDate, 'IBDB enrichment (discovery)');
        }

        // Store IBDB URL for reference
        if (ibdb.ibdbUrl) {
          show.ibdbUrl = ibdb.ibdbUrl;
        }

        // Populate creative team only when show has none. 2026-05-26: was
        // unconditional — could silently overwrite a manual or SERP-verified
        // team on rediscovery. Mirror the auto-fix Step 1 "skip if non-empty"
        // pattern.
        if (ibdb.creativeTeam && ibdb.creativeTeam.length > 0
            && (!show.creativeTeam || show.creativeTeam.length === 0)) {
          await applyVerifiedIbdbCreativeTeam(show, ibdb.creativeTeam);
        }

        // Use IBDB show type classification if available
        if (ibdb.showType) {
          show.ibdbShowType = ibdb.showType;
        }
      }
    } catch (e) {
      console.log(`⚠️  IBDB enrichment failed (continuing without): ${e.message}`);
    }
    console.log('');
  }

  // Log skipped duplicates for debugging
  if (skippedDuplicates.length > 0) {
    console.log(`⏭️  Skipped ${skippedDuplicates.length} duplicate(s):`);
    for (const skip of skippedDuplicates) {
      console.log(`   - "${skip.title}" (${skip.reason}) → existing: ${skip.existingId}`);
    }
    console.log('');
  }

  // S0-T3 run summary: retired ids refused this run (see retired-skip lines
  // above for the per-candidate detail). A non-zero count is expected while
  // the retired listing is still live at its source; it is NOT a defect.
  if (retiredSkipped.length > 0) {
    console.log(`Skipped ${retiredSkipped.length} retired id(s) — never re-discovered (data/retired-show-ids.json):`);
    for (const r of retiredSkipped) {
      console.log(`   - "${r.title}" → ${r.candidateId} (matched ${r.retiredId} by ${r.matchedBy})`);
    }
    console.log('');
  }

  if (newShows.length === 0) {
    if (reconciledShows.length > 0) {
      if (!dryRun) {
        saveShows(data);
        console.log(`✅ No new shows discovered — refreshed ${reconciledShows.length} stale existing show(s)`);
      } else {
        console.log(`✅ No new shows discovered — dry-run would refresh ${reconciledShows.length} stale existing show(s)`);
      }
    } else {
      console.log('✅ No new shows discovered - database is up to date');
    }
    return { newShows: [], count: 0, reconciledCount: reconciledShows.length, retiredSkippedCount: retiredSkipped.length };
  }

  console.log(`🎭 Found ${newShows.length} NEW show(s):`);
  console.log('-'.repeat(40));

  // Build title index from existing shows for cross-reference revival detection
  const existingTitleMap = buildExistingTitleMap(data.shows);

  // Analyze shows for revival detection
  const revivalDetection = newShows.map(show => {
    const knownCheck = checkKnownShow(show.title);
    const isPlay = detectPlayFromTitle(show.title);

    let detectedType = 'play'; // default to play (safer — musicals are more obvious)
    let isRevival = false;
    let confidence = 'low';

    if (knownCheck.isKnown) {
      // Known classic - likely a revival, preserve original type (play vs musical)
      detectedType = knownCheck.type || 'play';
      isRevival = true;
      confidence = 'high';
    } else {
      const xref = detectRevivalByTitleCrossReference(show, existingTitleMap);
      if (xref.isRevival) {
        isRevival = true;
        detectedType = xref.detectedType || detectedType;
        confidence = xref.confidence;
        console.log(`  📋 Revival detected via cross-reference: "${show.title}" matches existing "${xref.match.title}" (${xref.match.id})`);
      } else if (xref.isTransfer) {
        console.log(`  ↔️  Cross-market title match (not revival): "${show.title}" (${show.category || 'broadway'}) vs existing "${xref.match.title}" (${xref.match.category || 'broadway'}, ${xref.match.id}) — treating as transfer`);
      }
    }

    // Type detection (independent of revival status)
    if (show.todayTixCategory) {
      // TodayTix category is reliable for OB/WE (no IBDB available)
      if (show.todayTixCategory === 'Musicals') {
        detectedType = 'musical';
        if (confidence === 'low') confidence = 'high';
      } else if (show.todayTixCategory === 'Plays') {
        detectedType = 'play';
        if (confidence === 'low') confidence = 'high';
      } else if (['Dance', 'Cabaret', 'Immersive Experiences', 'Opera', 'Circus and Magic', 'Concerts'].includes(show.todayTixCategory)) {
        // Non-musical/play categories → 'special' (avoids misclassifying ballet as musical, etc.)
        detectedType = 'special';
        if (confidence === 'low') confidence = 'high';
      }
    } else if (show.ibdbShowType) {
      // IBDB classification is authoritative (from the production page itself)
      detectedType = show.ibdbShowType;
      confidence = 'high';
    } else if (titleSaysMusical(show.title)) {
      // Title suffix like "Dog Man - The Musical", "Show: A New Musical" or
      // "Death Note The Musical" (lib/title-says-musical.js); avoids false
      // positives like "The Musical Comedy Murders of 1940".
      detectedType = 'musical';
      confidence = 'medium';
    } else if (isPlay) {
      detectedType = 'play';
      confidence = 'medium';
    }

    return { show, detectedType, isRevival, confidence, revivalSource: isRevival ? (knownCheck.isKnown ? 'known-show' : 'title-crossref') : null };
  });

  // Playbill's market tag ("Broadway"/"Off-Broadway"/"London") vs a show's
  // shows.json category — belt-and-suspenders cross-check for Stage 2 below.
  function playbillMarketMatchesCategory(pbMarket, category) {
    const m = pbMarket.toLowerCase();
    if (m === 'broadway') return isBroadwayCategory({ category });
    if (m === 'off-broadway') return category === 'off-broadway';
    if (m === 'london') return isLondonMarket(category);
    return true; // unrecognized label (e.g. "Tour") — don't block on it
  }

  // Stage 2: Playbill tag-line check (BRO-2023). Playbill prints "Revival" or
  // "Original" on every production page it has classified — authoritative,
  // not a title heuristic — so unlike Stage 1's cross-reference it resolves a
  // prior production this corpus never recorded (e.g. Gloria's 2015
  // Off-Broadway run at the Vineyard, absent from shows.json, silently read
  // as isRevival:false before this check existed). Runs for every
  // not-yet-special show, not just undetected ones, so it also catches a
  // Stage-1 false positive (a same-title cross-market transfer wrongly
  // flagged, since Playbill would print "Original" for both productions).
  const playbillCandidates = revivalDetection.filter(d => d.detectedType !== 'special');
  if (playbillCandidates.length > 0 && !dryRun) {
    console.log(`\n🔍 Stage 2: Checking Playbill production pages for ${playbillCandidates.length} show(s)...`);
    for (let i = 0; i < playbillCandidates.length; i++) {
      if (timeBudget.exceeded()) {
        console.log(`  ⏱ Time budget (${timeBudget.minutes} min) reached — ${playbillCandidates.length - i} show(s) left unchecked against Playbill, will retry next run.`);
        break;
      }
      const det = playbillCandidates[i];
      try {
        // det.show.isRevival is never set at this point in discovery (Stage 1's
        // call is tracked on the `det` wrapper, not the raw show object) — so
        // without this, compareShow()'s isRevival check always compares
        // Playbill against `undefined` and reports a spurious mismatch for
        // every revival, regardless of what Stage 1 actually found
        // (ship-check finding).
        det.show.isRevival = det.isRevival;
        const result = await validatePlaybillProduction(det.show, () => {});
        const tagLine = result?.parsed?.tagLine;
        // Ship-check finding: findPlaybillUrl's SERP match is scored, not
        // exact — a venue/opening-year mismatch means the page validateOne
        // fetched is probably the WRONG production (a different staging of
        // the same title), so its tag line must not be trusted here.
        const wrongPage = (result?.mismatches || []).some(m => m.field === 'venue' || m.field === 'opening-year');
        // Cross-check Playbill's own market label against the show's market
        // — belt-and-suspenders against the same wrong-page risk when the
        // venue/year happen to coincide.
        const marketMismatch = tagLine?.market && !playbillMarketMatchesCategory(tagLine.market, det.show.category);
        if (wrongPage || marketMismatch) {
          console.log(`  ⚠️  Playbill page for "${det.show.title}" looks like a different production (${wrongPage ? (result.mismatches.map(m => m.field).join('/') + ' mismatch') : `market ${tagLine.market} vs ${det.show.category || 'broadway'}`}) — ignoring its tag line`);
        } else if (tagLine && tagLine.revivalStatus !== 'unknown') {
          const playbillIsRevival = tagLine.revivalStatus === 'revival';
          if (det.isRevival !== playbillIsRevival) {
            console.log(`  📋 Playbill override: "${det.show.title}" isRevival ${det.isRevival} → ${playbillIsRevival} (${tagLine.tags.join(' | ')})`);
          }
          det.isRevival = playbillIsRevival;
          det.confidence = 'high';
          det.revivalSource = 'playbill-tag';
          det.revivalSourceUrl = result.playbillUrl || null;
          if (tagLine.showType) det.detectedType = tagLine.showType;
        } else if (result?.playbillUrl) {
          console.log(`  ℹ️  Playbill page found for "${det.show.title}" but no genre tag line parsed (markup may have changed) — ${result.playbillUrl}`);
        }
      } catch (e) {
        console.log(`  ⚠️  Playbill tag-line check failed for "${det.show.title}": ${e.message}`);
      }
      if (i < playbillCandidates.length - 1) {
        await new Promise(r => setTimeout(r, 400));
      }
    }
    console.log('');
  }

  // Stage 3: IBDB revival detection for shows Playbill didn't resolve
  // (no cached/discoverable Playbill page yet, e.g. announced-but-unbuilt
  // production pages) and that aren't already flagged as revivals.
  const undetected = revivalDetection.filter(d => !d.isRevival && d.detectedType !== 'special' && d.revivalSource !== 'playbill-tag');
  if (undetected.length > 0 && !dryRun) {
    console.log(`\n🔍 Stage 3: Checking IBDB for prior productions of ${undetected.length} undetected show(s)...`);
    const RATE_LIMIT_MS = 1500;
    for (let i = 0; i < undetected.length; i++) {
      if (timeBudget.exceeded()) {
        console.log(`  ⏱ Time budget (${timeBudget.minutes} min) reached — ${undetected.length - i} show(s) left unchecked for IBDB revival status, will retry next run.`);
        break;
      }
      const det = undetected[i];
      const showYear = det.show.openingDate ? parseInt(det.show.openingDate.split('-')[0]) :
                       det.show.previewsStartDate ? parseInt(det.show.previewsStartDate.split('-')[0]) : null;
      const result = await checkIBDBForPriorProductions(det.show.title, { currentYear: showYear, showCategory: det.show.category || 'off-broadway' });
      if (result.isRevival && !shouldAcceptIbdbRevival(result, det.show)) {
        // IBDB matched on title only; the show's own copy says "new musical"
        // (Soon 2026 vs the unrelated 1971 Broadway Soon).
        console.log(`  ➡️  IBDB title match for "${det.show.title}" ignored: listing describes a new work`);
      } else if (result.isRevival) {
        det.isRevival = true;
        if (result.confidence === 'high') det.confidence = 'high';
        det.revivalSource = 'ibdb';
        console.log(`  🔄 IBDB revival confirmed: "${det.show.title}" (${result.priorProductionCount} prior productions)`);
      }
      // Mark as checked so nightly runs don't re-query
      det.show._ibdbRevivalChecked = true;
      if (i < undetected.length - 1) {
        await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
      }
    }
    console.log('');
  }

  // Tri-state marker (BRO-2023): a show with no signal from ANY of the three
  // stages above is a genuine unknown, not a confirmed "new production" — the
  // structural defect the issue named ("a missing prior record produces a
  // CONFIDENT false, not an 'unknown'"). Downstream Tony-eligibility review
  // can filter on this flag instead of trusting a silent isRevival:false.
  for (const det of revivalDetection) {
    if (!det.isRevival && !det.revivalSource && det.detectedType !== 'special') {
      det.show.revivalStatusUnconfirmed = true;
    }
  }

  for (const { show, detectedType, isRevival, confidence } of revivalDetection) {
    const typeLabel = isRevival ? '🔄 REVIVAL' : detectedType === 'play' ? '🎭 PLAY' : '🎵 MUSICAL';
    const confidenceLabel = confidence === 'high' ? '✓' : confidence === 'medium' ? '~' : '?';
    console.log(`  ${confidenceLabel} ${show.title} → ${typeLabel} (${show.venue})`);
  }
  console.log('');

  // --- Runtime + age enrichment from Broadway.com ---
  let runtimeEnrichments = {};
  if (!dryRun && newShows.length > 0 && timeBudget.exceeded()) {
    console.log(`⏱ Time budget (${timeBudget.minutes} min) reached — skipping Broadway.com runtime/age enrichment this run.`);
  } else if (!dryRun && newShows.length > 0) {
    try {
      console.log('⏱️  Looking up runtimes + age recommendations from Broadway.com...');
      const runtimeEntries = await scrapeCurrentRuntimes();
      const allShows = [...data.shows, ...newShows];
      runtimeEnrichments = matchRuntimesToShows(runtimeEntries, allShows);
      // Also scrape individual pages for age recommendations
      await batchScrapeAgeRecommendations(runtimeEntries, allShows, runtimeEnrichments, timeBudget);
    } catch (e) {
      console.log(`⚠️  Runtime/age lookup failed (continuing without): ${e.message}`);
    }
    console.log('');
  }

  if (!dryRun) {
    // Add new shows to database
    for (let i = 0; i < newShows.length; i++) {
      const show = newShows[i];
      const detection = revivalDetection[i];

      // Determine status based on opening date
      let openingDate;
      let status;

      // ShowScore status is more reliable than TodayTix dates for OB/WE shows.
      // "Opens Mar 08" = real opening date. "Open run" = confirmed open.
      const ssStatus = show._showScoreStatus;

      if (ssStatus === 'open' || ssStatus === 'previews') {
        // ShowScore has authoritative status — use it directly
        if (ssStatus === 'open') {
          status = 'open';
          openingDate = show.openingDate || null;
        } else {
          // "Opens Mar 08" — usually press night, but for a show that hasn't
          // started it can be the first performance (PHYL's "Opens Oct 03"
          // was its first preview; press night Oct 22, BRO-4377). Either
          // way a future date is no evidence previews have begun.
          openingDate = show.openingDate;
          status = decidePrematurePreviews(
            { status: 'previews', openingDate, openingDateSource: 'showscore', previewsStartDate: show.previewsStartDate || null },
            new Date().toISOString().slice(0, 10),
          ) ? 'upcoming' : 'previews';
        }
      } else if (show.openingDate) {
        openingDate = show.openingDate;
        const openingDateObj = new Date(openingDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (openingDateObj > today) {
          status = 'upcoming';
        } else if (show.category === 'off-broadway' && !show.ibdbUrl &&
                   !(show.previewsStartDate && show.previewsStartDate < openingDate)) {
          // Skipped when the source gave a distinct, earlier first preview
          // (TheaterMania, Playbill OB): then openingDate is a real press
          // night, and overwriting previewsStartDate with it loses the
          // first-preview date (BRO-4381).
          // OB shows without IBDB-confirmed dates: TodayTix startDate is the first
          // performance (previews), not press night. Default to 'previews' to avoid
          // prematurely marking shows as 'open' and collecting wrong-production reviews.
          // (Lesson from March 2026 audit: 10 OB shows had preview dates as opening dates.)
          status = 'previews';
          show.previewsStartDate = show.openingDate;
          show.openingDate = null;
          show.openingDateSource = null;
          openingDate = null;
        } else {
          status = 'open';
        }
      } else if (show.previewsStartDate) {
        // No opening date but have preview date — only mark previews if date has been reached
        openingDate = null;
        const previewsDateObj = new Date(show.previewsStartDate);
        const todayForPreviews = new Date();
        todayForPreviews.setHours(0, 0, 0, 0);
        status = previewsDateObj > todayForPreviews ? 'upcoming' : 'previews'; // ≥ today = in previews
      } else {
        // No opening date or preview date — show is announced but not yet scheduled
        openingDate = null;
        status = 'announced';
      }

      // Build tags based on detection
      const tags = (status === 'previews' || status === 'upcoming' || status === 'announced') ? ['upcoming'] : [];
      if (detection.isRevival) {
        tags.push('revival');
      } else if (detection.confidence === 'low') {
        tags.push('new'); // Flag for manual verification
      }

      const showEntry = {
        id: show.id,
        title: show.title,
        slug: show.slug,
        venue: show.venue,
        openingDate: openingDate || null,
        closingDate: show.closingDate || null,
        status: status,
        type: (detection.detectedType || 'play').toLowerCase(), // Auto-detected with revival logic
        isRevival: detection.isRevival || false,
        runtime: (runtimeEnrichments[show.id] && runtimeEnrichments[show.id].runtime) || null,
        intermissions: runtimeEnrichments[show.id] != null ? runtimeEnrichments[show.id].intermissions : null,
        images: {},
        synopsis: (() => {
          const text = show.description ? truncateAtSentence(show.description.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim(), 500) : '';
          // Producer copy: keep it only if it passes the shared shape + award-claim gate (BRO-4853).
          return text && gateScrapedSynopsis({ id: show.id, status }, text, { showsById: {} }).ok ? text : '';
        })(),
        ageRecommendation: (runtimeEnrichments[show.id] && runtimeEnrichments[show.id].ageRecommendation) || null,
        previewsStartDate: show.previewsStartDate || null,
        openingDateSource: show.openingDateSource || null,
        tags: tags,
        theaterAddress: getTheaterAddress(show.venue) || null,
        ticketLinks: [],
        cast: [],
        creativeTeam: show.creativeTeam || [],
        // BRO-2023: no stage (title cross-reference, Playbill tag-line, IBDB)
        // produced ANY revival evidence — isRevival:false here is a genuine
        // unknown, not a confirmed "new production". Flagged for manual
        // review rather than silently rendered as new.
        ...(show.revivalStatusUnconfirmed ? { revivalStatusUnconfirmed: true } : {}),
        // Provenance for the isRevival call above (ship-check finding: a
        // future bad Playbill parse/page match needs to be selectively
        // findable and revertable, not silently indistinguishable from a
        // title-crossref or known-show call).
        ...(detection.revivalSource ? { revivalSource: detection.revivalSource } : {}),
        ...(detection.revivalSourceUrl ? { revivalSourceUrl: detection.revivalSourceUrl } : {}),
        // BRO-4381: the provisional flag + discoverySource that the TodayTix
        // venue fallback and TheaterMania set on a candidate were dropped
        // here (showEntry is built field-by-field), so the Playbill
        // cross-check (validate-show-venue.js --all-provisional) never saw
        // those rows. Same for the quarantined TodayTix start date.
        ...(show.provisional === true ? { provisional: true } : {}),
        ...(show.discoverySource ? { discoverySource: show.discoverySource } : {}),
        ...(show.unconfirmedStartDate ? { unconfirmedStartDate: show.unconfirmedStartDate } : {}),
      };

      // Persist TodayTix category for future type detection (backfill on re-runs)
      if (show.todayTixCategory) {
        showEntry.todayTixCategory = show.todayTixCategory;
      }

      // Cache IBDB revival check to prevent re-querying on future runs
      if (show._ibdbRevivalChecked) {
        showEntry.ibdbRevivalChecked = true;
      }

      // Single source of truth for category+market — see scripts/lib/classify-show.js.
      // Extracted after Schmigadoon / Beaches / Rocky Horror / Joe Turner / Lost Boys
      // all shipped with null category+market because the creator had no explicit
      // Broadway branch. Do NOT inline this logic again; keep it require()-able so
      // tests/unit/discover-new-shows-category.test.mjs can assert the real function.
      Object.assign(showEntry, classifyShow(show));

      data.shows.push(showEntry);
    }

    saveShows(data);
    console.log(`✅ Added ${newShows.length} shows to shows.json${reconciledShows.length > 0 ? `, refreshed ${reconciledShows.length} stale existing show(s)` : ''}`);

    // Show detection summary
    const revivalsDetected = revivalDetection.filter(d => d.isRevival).length;
    const playsDetected = revivalDetection.filter(d => d.detectedType === 'play' && !d.isRevival).length;
    const needsReview = revivalDetection.filter(d => d.confidence === 'low').length;

    console.log('');
    console.log('📊 Detection Summary:');
    if (revivalsDetected > 0) console.log(`   🔄 ${revivalsDetected} revival(s) auto-detected`);
    if (playsDetected > 0) console.log(`   🎭 ${playsDetected} play(s) auto-detected`);
    if (needsReview > 0) console.log(`   ⚠️  ${needsReview} show(s) need manual type verification`);
    console.log('');

    // Save pending shows for review (strip internal fields)
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
      discoveredAt: new Date().toISOString(),
      shows: newShows.map(s => {
        const { _showScoreUrl, _source, _ibdbRevivalChecked, _discoverySource, ...clean } = s;
        return clean;
      }),
    }, null, 2));
    console.log(`📋 Saved pending shows to ${OUTPUT_FILE}`);

    // Post-save: assign ShowScore URLs + prune consumed candidates
    if (consumeShowScoreCandidates && consumedCandidateUrls.length > 0) {
      try {
        // Assign ShowScore URLs to newly created shows
        const urlData = JSON.parse(fs.readFileSync(URLS_PATH, 'utf8'));
        if (!urlData.shows) urlData.shows = {};
        let urlsAssigned = 0;
        for (const { title, url } of consumedCandidateUrls) {
          // Find the newly created show by matching title
          const addedShow = newShows.find(s => s.title === title);
          if (addedShow && !urlData.shows[addedShow.id]) {
            // BRO-4055: a candidate URL can already belong to an unrelated
            // existing show (e.g. a same-title earlier production) — refuse
            // rather than silently creating a new wrong-production mapping.
            const conflictId = findConflictingShowId(urlData.shows, addedShow.id, url);
            if (conflictId) {
              console.log(`  [SKIP] ${url} already assigned to ${conflictId} — refusing to also assign it to ${addedShow.id}`);
            } else {
              urlData.shows[addedShow.id] = url;
              urlsAssigned++;
            }
          }
        }
        if (urlsAssigned > 0) {
          urlData._meta = urlData._meta || {};
          urlData._meta.lastUpdated = new Date().toISOString();
          fs.writeFileSync(URLS_PATH, JSON.stringify(urlData, null, 2) + '\n');
          console.log(`Assigned ${urlsAssigned} ShowScore URLs to new shows`);
        }
      } catch (e) {
        console.log(`⚠️  ShowScore URL assignment failed (non-fatal): ${e.message}`);
      }
    }

    // Prune ALL processed candidates (added, filtered, or deduped) from candidates file
    if (consumeShowScoreCandidates && processedCandidateUrls.size > 0) {
      try {
        const candidatesData = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
        const before = (candidatesData.candidates || []).length;
        candidatesData.candidates = (candidatesData.candidates || []).filter(c =>
          !processedCandidateUrls.has(c.showScoreUrl)
        );
        const pruned = before - candidatesData.candidates.length;
        if (pruned > 0) {
          candidatesData._meta = candidatesData._meta || {};
          candidatesData._meta.lastUpdated = new Date().toISOString();
          candidatesData._meta.totalCandidates = candidatesData.candidates.length;
          fs.writeFileSync(CANDIDATES_PATH, JSON.stringify(candidatesData, null, 2) + '\n');
          console.log(`Pruned ${pruned} processed candidates from show-score-candidates.json`);
        }
      } catch (e) {
        if (e.code !== 'ENOENT') console.warn(`Warning: could not parse ${CANDIDATES_PATH}: ${e.message}`);
      }
    }
  }

  // GitHub Actions outputs
  if (process.env.GITHUB_OUTPUT) {
    const outputFile = process.env.GITHUB_OUTPUT;
    fs.appendFileSync(outputFile, `new_shows_count=${newShows.length}\n`);
    fs.appendFileSync(outputFile, `new_shows=${newShows.map(s => s.title).join(', ')}\n`);
    fs.appendFileSync(outputFile, `new_slugs=${newShows.map(s => s.slug).join(',')}\n`);
    // WE-specific output for downstream triggers (includes off-west-end)
    const weNewShows = newShows.filter(s => isLondonMarket(s.category));
    fs.appendFileSync(outputFile, `we_new_count=${weNewShows.length}\n`);
  }

  return { newShows, count: newShows.length, reconciledCount: reconciledShows.length, retiredSkippedCount: retiredSkipped.length };
}

if (require.main === module) {
  let discoveryFailed = false;
  discoverShows()
    .catch(e => {
      console.error('Discovery failed:', e);
      discoveryFailed = true;
    })
    .finally(async () => {
      // Clean up scraper resources. cleanup() (scripts/lib/scraper.js) now
      // has its own hard timeout on browser.close(), but as a last-resort
      // backstop — task #438: the process hung 44 min past its real work
      // finishing because an unawaited, untimed close() call kept a dangling
      // Playwright handle open — force-exit here so no future gap in that
      // chain can leave this specific entrypoint hanging again.
      try {
        await cleanup();
      } catch (e) {
        console.error(e);
      }
      process.exit(discoveryFailed ? 1 : 0);
    });
}

// Exports for unit tests — keep gate predicates next to the data arrays
// they consult so changes stay co-located.
module.exports = {
  isNonTheaterContent,
  londonListingTitleRejected,
  isOneNightShow,
  obFallbackFlags,
  bwayFallbackFlags,
  isBroadwayHouse,
  resolveTodayTixVenue,
  EXCLUDED_TITLES,
  NON_THEATER_PATTERNS,
  NON_THEATRE_TITLE_RE,
  NON_THEATRE_TODAYTIX_CATEGORIES,
  STAGED_PRODUCTION_CATEGORIES,
  WE_EXTRA_PATTERNS,
  VENUE_PAGE_EXCLUDE_PATTERNS,
  VENUE_LISTING_PAGES,
  fetchSingleVenuePage,
  parseVenueListingPage,
  oweCandidatesFromDatedListing,
  fetchOneVenueListing,
  fetchShowsFromVenueListings,
  shouldExcludeVenueShow,
  applyVerifiedIbdbCreativeTeam,
  mintCandidateId,
};
