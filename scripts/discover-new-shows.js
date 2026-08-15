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
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { JSDOM } = require('jsdom');
const { fetchPage, cleanup } = require('./lib/scraper');
const { parseShortDate } = require('./lib/show-score-status');
const { checkKnownShow, detectPlayFromTitle } = require('./lib/known-shows');
const { writeClosingDate } = require('./lib/closing-date-guard');
const { slugify, checkForDuplicate, findSameTitleTwinIfNoOpeningDate } = require('./lib/deduplication');
const { computeShowReconciliation } = require('./lib/discovery-reconcile');
const { classifyTodayTixStartDate, unconfirmedStartFlags, productionIdYear } = require('./lib/todaytix-dates');
const { batchLookupIBDBDates, checkIBDBForPriorProductions } = require('./lib/ibdb-dates');
const { ibdbYearMismatch, expectedShowYear } = require('./lib/ibdb-year-guard');
const { getTheaterAddress } = require('./lib/venue-addresses');
const { cleanSearchTitle } = require('./lib/title-normalization');
const { splitCombinedCredits } = require('./lib/credit-splitting');
const { scrapeCurrentRuntimes, matchRuntimesToShows, batchScrapeAgeRecommendations } = require('./lib/broadway-com-runtimes');
const { classifyGenre, applyGenreCategoryOverride } = require('./lib/genre-classification');
const { isLondonMarket, isOffWestEndVenue, isWestEndVenue, isKnownOffBroadwayVenue, isBroadwayCategory, sanitizeVenueForWrite } = require('./lib/venue-classification');
const { BROADWAY_THEATERS, normalizeVenueName: normalizeBroadwayVenue } = require('./lib/broadway-theaters');
const showsWriteGuard = require('./lib/shows-write-guard');

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
const { scrapePlaybillOBData, checkSilentRot } = require('./lib/playbill-ob-schedule');
const { scrapePlaybillBroadwayData, checkSilentRot: checkBroadwaySilentRot, titleCaseFromAllCaps } = require('./lib/playbill-broadway-schedule');
const {
  OB_VENUE_CONFIGS,
  scrapeVenueListing,
  writeStagingCandidates,
} = require('./lib/venue-listing-discover');
const { checkVenueAnomaly } = require('./lib/venue-anomaly');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

const { hasHelpFlag } = require('./lib/cli-help.js');

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
  'quartet', 'quintet', 'ensemble',
  'the metropolitan opera', // Met Opera productions (Turandot, La Boheme, etc.)
  'royal opera', 'opera house', // London opera
  'selected shorts', 'book club', 'in conversation with',
  'nt live:', 'london\'s west end:',
  'dance company', 'dance +', 'ballet',
  'lottery', 'accessible lottery',
  'meet the music', 'lyrics & lyricists',
  'uptown showdown', 'amateur night',
  'flamenco festival', 'circus',
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

// West End-specific additional patterns — shared by TodayTix London, OLT, and ShowScore candidate processing
const WE_EXTRA_PATTERNS = [
  'dining experience', 'candlelight', 'by candlelight',
  'discovering dinosaurs', 'prehistoric planet',
  'classic penguins', // comedy fringe acts
];
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
  if (show.startDate === 'null' || show.endDate === 'null') return false;
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

function isNonTheaterContent(show) {
  const title = (show.displayName || show.name || '').toLowerCase();
  if (EXCLUDED_TITLES.some(excluded => title.includes(excluded))) return true;
  if (NON_THEATER_PATTERNS.some(pattern => title.includes(pattern))) return true;
  const subcatNames = (show.subcategories || []).map(sc => sc.name);
  if (subcatNames.includes('Classical')) return true; // Opera

  // Gate 2: Venue blocklist — categorically non-theater venues
  const venue = (typeof show.venue === 'string' ? show.venue : show.venue?.name || '').toLowerCase();
  if (NON_THEATER_VENUES.some(v => venue.includes(v))) return true;

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
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`TodayTix API HTTP ${response.statusCode}`));
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
      title: titleCaseFromAllCaps(e.title),
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
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`TodayTix London API HTTP ${response.statusCode}`));
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

    return !isNonTheaterContent(s) && !isOneNightShow(s);
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
    showsList.push({
      title,
      venue: weVenue,
      slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
      openingDate: null,
      previewsStartDate: weStart.previewsStartDate,
      closingDate: show.endDate === 'null' ? null : show.endDate || null,
      category: isOffWestEndVenue(weVenue) ? 'off-west-end' : 'west-end',
      description: show.description || '',
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

// ── Theatremonkey — supplementary WE discovery source (catches shows TodayTix/OLT miss) ──

const TM_INDEX_URL = 'https://www.theatremonkey.com/shows/';

async function fetchShowsFromTheatremonkey() {
  console.log('Fetching West End shows from Theatremonkey...');
  try {
    const response = await fetch(TM_INDEX_URL, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)', Accept: 'text/html' },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.log(`  Theatremonkey returned HTTP ${response.status}`);
      return [];
    }
    const html = await response.text();
    const cheerio = require('cheerio');
    const $ = cheerio.load(html);
    const seen = new Set();
    const showsList = [];
    let skippedNoVenue = 0;

    $('a[href*="/show/"]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const match = href.match(/\/show\/([^/]+)\/?$/);
      if (!match) return;
      const slug = match[1];
      if (slug === 'shows' || seen.has(slug)) return;
      const title = $(el).text().trim();
      if (title.length < 2 || /^(Read more|Show Details|Reviews)/i.test(title)) return;
      seen.add(slug);

      // Clean Disney's prefix for consistency
      const cleanedTitle = title.replace(/^Disney's\s+/i, '');
      // The TM index genuinely carries no venue data (it's on each show's own
      // page, which this scraper doesn't fetch) — unlike every other source
      // in this file, there is no real value to fall back to here, only a
      // fabricated one. Writing 'TBA' was exactly the #994-class leak this
      // card (#1060) exists to close, so skip instead of writing a
      // placeholder. This makes TM contribute 0 shows going forward — an
      // accepted coverage tradeoff (design decision, not a guess): TM is a
      // supplementary source layered under TodayTix/OLT in the dedup
      // priority order, so titles it alone would have caught are lost until
      // someone adds a per-show-page fetch for venue.
      skippedNoVenue++;
    });
    if (skippedNoVenue > 0) {
      console.log(`  Theatremonkey: skipped ${skippedNoVenue} candidates — index has no venue data (card #1060)`);
    }

    console.log(`Theatremonkey: ${showsList.length} shows on index`);
    // showsList is always empty now (card #1060 — TM has no venue data, so
    // every candidate is skipped, never pushed). The old "0 shows parsed"
    // check would fire on every successful run. seen.size === 0 means the
    // /show/ link selector itself matched nothing — the real HTML-structure
    // regression this warning exists to catch.
    if (html.length > 10000 && seen.size === 0) {
      console.error('⚠️  WARNING: Theatremonkey page loaded but 0 candidates found — HTML structure may have changed');
    }
    return showsList;
  } catch (err) {
    console.log(`  Theatremonkey fetch failed: ${err.message}`);
    return [];
  }
}

// ── Official London Theatre (SOLT) — supplementary WE discovery source ──

const OLT_URL = 'https://officiallondontheatre.com/theatre-tickets/';

async function fetchShowsFromOfficialLondonTheatre() {
  console.log('Fetching West End shows from Official London Theatre (SOLT)...');

  // Plain HTTPS — site serves static HTML with JSON-LD, no scraping service needed
  const html = await new Promise((resolve, reject) => {
    const req = https.get(OLT_URL, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-GB,en;q=0.9',
      },
      timeout: 20000,
    }, (res) => {
      // Follow one redirect (301/302/307/308)
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
          timeout: 20000,
        }, (res2) => {
          if (res2.statusCode !== 200) { reject(new Error(`HTTP ${res2.statusCode} after redirect`)); res2.resume(); return; }
          let d = '';
          res2.on('data', chunk => d += chunk);
          res2.on('end', () => resolve(d));
        }).on('error', reject);
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
    console.log(`  OLT: content suspiciously short (${html.length} bytes), skipping`);
    return [];
  }

  // Parse JSON-LD TheaterEvent blocks (each is a standalone <script type="application/ld+json">)
  const dom = new JSDOM(html);
  const ldScripts = dom.window.document.querySelectorAll('script[type="application/ld+json"]');
  const shows = [];
  const seen = new Set();

  for (const script of ldScripts) {
    try {
      const data = JSON.parse(script.textContent);
      // Only accept objects where @type is exactly "TheaterEvent" (string, not array)
      if (typeof data['@type'] !== 'string' || data['@type'] !== 'TheaterEvent') continue;
      // Skip any with subEvent nesting (season containers)
      if (data.subEvent) continue;

      const title = (data.name || '').trim()
        .replace(/&#8217;|&#8216;|[\u2018\u2019]/g, "'")  // Curly quotes → straight
        .replace(/&#8220;|&#8221;|[\u201C\u201D]/g, '"')  // Curly double quotes → straight
        .replace(/&#8211;|[\u2013]/g, '–').replace(/&#8212;|[\u2014]/g, '—')
        .replace(/&#038;/g, '&').replace(/&amp;/g, '&');
      if (!title || title.length < 3 || seen.has(title.toLowerCase())) continue;

      // Apply shared filters
      const titleLower = title.toLowerCase();
      if (NON_THEATER_PATTERNS.some(p => titleLower.includes(p))) continue;
      if (WE_EXTRA_PATTERNS.some(p => titleLower.includes(p))) continue;

      // OLT's JSON-LD location can be missing/blank on a malformed entry —
      // same #994-class leak, guarded here rather than resurrected via
      // `|| 'TBA'` (card #1060).
      const rawVenue = typeof data.location === 'object' ? data.location.name : data.location;
      const venue = sanitizeVenueForWrite(rawVenue);
      if (!venue) {
        if (verbose) console.log(`  [SKIP] "${title}" — OLT venue "${rawVenue || ''}" is a placeholder/blob, deferring to next run (card #1060)`);
        continue;
      }
      const endDate = data.endDate === 'null' || data.endDate === null ? null : data.endDate || null;

      seen.add(titleLower);
      shows.push({
        title,
        venue,
        slug: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        openingDate: null,
        previewsStartDate: data.startDate || null,
        closingDate: endDate,
        category: 'west-end',
        description: (data.description || '').substring(0, 500),
      });
    } catch (e) {
      // Skip malformed JSON-LD blocks
    }
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

  console.log(`  OLT: ${ldScripts.length} JSON-LD blocks, ${shows.length} TheaterEvent shows parsed`);
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
        https.get(res.headers.location, {
          headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
          timeout: 20000,
        }, (res2) => {
          if (res2.statusCode !== 200) { reject(new Error(`HTTP ${res2.statusCode} after redirect`)); res2.resume(); return; }
          let d = '';
          res2.on('data', chunk => d += chunk);
          res2.on('end', () => resolve(d));
        }).on('error', reject);
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
      const parsed = JSON.parse(script.textContent);
      // Handle both single objects and arrays of TheaterEvent (LT uses an array)
      const items = Array.isArray(parsed) ? parsed : [parsed];

      for (const data of items) {
        if (typeof data['@type'] !== 'string' || data['@type'] !== 'TheaterEvent') continue;
        if (data.subEvent) continue;

        const title = (data.name || '').trim()
          .replace(/&#8217;|&#8216;|[\u2018\u2019]/g, "'")
          .replace(/&#8220;|&#8221;|[\u201C\u201D]/g, '"')
          .replace(/&#8211;|[\u2013]/g, '\u2013').replace(/&#8212;|[\u2014]/g, '\u2014')
          .replace(/&#038;/g, '&').replace(/&amp;/g, '&')
          .replace(/&apos;/g, "'");
        if (!title || title.length < 3 || seen.has(title.toLowerCase())) continue;

        const titleLower = title.toLowerCase();
        if (NON_THEATER_PATTERNS.some(p => titleLower.includes(p))) continue;
        if (WE_EXTRA_PATTERNS.some(p => titleLower.includes(p))) continue;

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
        const endDate = data.endDate === 'null' || data.endDate === null ? null : data.endDate || null;

        // Venue-based classification: most are OWE, but reclassify if at a WE venue
        const category = isWestEndVenue(venue) ? 'west-end' : 'off-west-end';

        seen.add(titleLower);
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
  { name: 'Hampstead Theatre', url: 'https://www.hampsteadtheatre.com/whats-on/', linkPattern: /\/whats-on\/\d{4}\/[^/]+/, titleFromSlug: true, category: 'off-west-end' },
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

// Patterns to exclude from venue page scraping (workshops, masterclasses, tours, etc.)
const VENUE_PAGE_EXCLUDE_PATTERNS = [
  'masterclass', 'workshop', 'tour', 'walking tour', 'rapid write',
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
];

async function fetchShowsFromVenueListings(category) {
  const venues = VENUE_LISTING_PAGES.filter(v => v.category === category);
  const label = category === 'off-broadway' ? 'Off-Broadway' : 'Off-West End';
  console.log(`Fetching shows from ${label} venue pages...`);

  const results = await Promise.allSettled(
    venues.map(venue => fetchSingleVenuePage(venue))
  );

  const allShows = [];
  let successCount = 0;

  for (let i = 0; i < results.length; i++) {
    const venue = venues[i];
    const result = results[i];
    if (result.status === 'fulfilled' && result.value.length > 0) {
      successCount++;
      allShows.push(...result.value);
      console.log(`  ${venue.name}: ${result.value.length} shows`);
    } else if (result.status === 'rejected') {
      console.log(`  ${venue.name}: failed (${result.reason?.message})`);
    } else {
      console.log(`  ${venue.name}: 0 shows`);
    }
  }

  console.log(`${label} venue pages: ${successCount}/${venues.length} venues responded, ${allShows.length} total shows`);
  return allShows;
}

// Backward-compat shim for any caller still using the OWE-specific entrypoint.
async function fetchShowsFromOweVenues() {
  return fetchShowsFromVenueListings('off-west-end');
}

async function fetchSingleVenuePage(venue) {
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

  if (html.length < 1000) return [];

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
  const lower = title.toLowerCase();
  if (NON_THEATER_PATTERNS.some(p => lower.includes(p))) return true;
  if (WE_EXTRA_PATTERNS.some(p => lower.includes(p))) return true;
  if (VENUE_PAGE_EXCLUDE_PATTERNS.some(p => lower.includes(p))) return true;
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
    https.get(url, (response) => {
      if (response.statusCode !== 200) {
        resolve(null);
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

    // Extract venue from the link in info-top-line. The first <a> here is
    // sometimes ShowScore's neighbourhood-filter link ("Midtown E",
    // "Soho/Tribeca") rather than the venue link — sanitizeVenueForWrite
    // fails closed on those rather than writing the blob (card #994).
    const venueLink = topLine.querySelector('a');
    const venueFull = venueLink?.textContent?.trim() || '';
    // Strip "NYC: " or "London: " prefix
    const venueRaw = venueFull.replace(/^(NYC|London|Chicago|LA):\s*/i, '').trim() || null;
    // null (never the literal string 'TBA') when rejected — a caller that
    // resurrects the placeholder via `|| 'TBA'` reopens the exact leak this
    // guard exists to close (S0 remainder, card #994: isla-off-broadway-2026
    // landed with venue:'TBA' via this exact `|| 'TBA'` fallback).
    const venue = sanitizeVenueForWrite(venueRaw);

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
      // Full TodayTix validation: all gates apply
      if (isNonTheaterContent(ttShow)) {
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
    discoveredShows = await fetchShowsFromTodayTix();
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
  const BROADWAY_SCHEDULE_CAP = 30;
  try {
    const playbillBroadwayShows = await fetchShowsFromPlaybillBroadway();
    sourceCounts.playbillBroadway = playbillBroadwayShows.length;
    if (playbillBroadwayShows.length > BROADWAY_SCHEDULE_CAP) {
      console.error(`::error::Playbill Broadway returned ${playbillBroadwayShows.length} candidates (cap: ${BROADWAY_SCHEDULE_CAP}) — likely parser regression. Aborting.`);
      process.exitCode = 1;
      return { newShows: [], count: 0 };
    }
    discoveredShows.push(...playbillBroadwayShows);
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
  // abort the commit (exit 1) instead of pushing garbage.
  const OB_VENUE_CAP = 30;
  if (includeOffBroadway) {
    try {
      const playbillOBShows = await fetchShowsFromPlaybillOB();
      sourceCounts.playbillOB = playbillOBShows.length;
      if (playbillOBShows.length > OB_VENUE_CAP) {
        console.error(`::error::Playbill OB returned ${playbillOBShows.length} candidates (cap: ${OB_VENUE_CAP}) — likely parser regression. Aborting.`);
        process.exitCode = 1;
        return { newShows: [], count: 0 };
      }
      discoveredShows.push(...playbillOBShows);
    } catch (e) {
      sourceCounts.playbillOB = 0;
      console.log(`⚠️  Playbill OB schedule failed (${e.message}), continuing with other sources`);
    }
    // OB venue listings — fan out to scrapeVenueListing per venue, capture
    // results to staging (NOT directly to shows.json). The promotion script
    // (scripts/promote-ob-venue-candidates.js, V-T6b) is what eventually
    // moves staged candidates to shows.json — gated by cross-validation
    // against Playbill OB / Lortel within 72h. This staging gate prevents
    // a venue-page redesign from accidentally firing premature broadcasts
    // to real subscribers (see /plan-review v2 P0 User Impact finding).
    try {
      const results = await Promise.allSettled(
        OB_VENUE_CONFIGS.map(v => scrapeVenueListing(v))
      );
      const all = [];
      for (let i = 0; i < results.length; i++) {
        const v = OB_VENUE_CONFIGS[i];
        const r = results[i];
        if (r.status === 'fulfilled') {
          if (r.value.length > OB_VENUE_CAP) {
            console.error(`::error::Venue ${v.name} returned ${r.value.length} candidates (cap: ${OB_VENUE_CAP}) — likely parser regression. Aborting.`);
            process.exitCode = 1;
            return { newShows: [], count: 0 };
          }
          // Per-venue rolling-median anomaly gate. Fail-soft (warns + sets
          // exitCode but discovery continues for other venues).
          checkVenueAnomaly(v.name, r.value.length);
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
      fetchShowsFromTheatremonkey(),
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

    if (ltResult.status === 'rejected') {
      console.log(`⚠️  LondonTheatre.co.uk fetch failed (${ltResult.reason?.message}), continuing with other sources`);
    } else {
      console.log(`Found ${ltShows.length} OWE shows via LondonTheatre.co.uk`);
    }

    if (venueResult.status === 'rejected') {
      console.log(`⚠️  OWE venue pages failed (${venueResult.reason?.message}), continuing with other sources`);
    } else if (venueShows.length > 0) {
      console.log(`Found ${venueShows.length} shows via OWE venue pages`);
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

    // TodayTix first (richer metadata), OLT second, TM third, LT fourth, venue pages last — dedup prefers earlier entries
    discoveredShows.push(...todayTixWEShows, ...oltShows, ...tmShows, ...ltShows, ...venueShows);
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
        discoveredShows.push(...ssValidated);
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
  // Gap C (card #1446): shows discovery correctly re-matches to an existing
  // shows.json entry, but the entry's stale preview/opening date and venue
  // are never refreshed from the live source. reconciledShows tracks the
  // patches applied below so the summary/save logic knows there's something
  // to write even when zero brand-new shows were found this run.
  const reconciledShows = [];
  const existingSlugs = new Set(data.shows.map(s => s.slug));
  const existingIds = new Set(data.shows.map(s => s.id));

  // Build todaytixId index for fast dedup
  const existingTodaytixIds = new Map();
  for (const s of data.shows) {
    if (s.todaytixId) existingTodaytixIds.set(s.todaytixId, s);
  }

  // Applies computeShowReconciliation's patch (if any) directly onto the
  // matched shows.json entry — `existing` is a reference into data.shows, so
  // this mutation is what saveShows(data) below persists. Always logged (even
  // in dry-run) so --dry-run output demonstrates the refresh; only mutated
  // when actually writing.
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
  function reconcileMatchedShow(existing, candidate, reason) {
    if (reason && !HIGH_CONFIDENCE_REASON_PREFIXES.some(p => reason.startsWith(p))) return;
    const patch = computeShowReconciliation(existing, candidate);
    if (!patch) return;
    reconciledShows.push({ id: existing.id, title: existing.title, patch });
    console.log(`  🔄 "${existing.title}" (${existing.id}): refreshing stale field(s) from live source — ${Object.keys(patch).join(', ')}`);
    if (!dryRun) Object.assign(existing, patch);
  }

  for (const show of discoveredShows) {
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

    // Convert date strings to ISO format
    let openingDate = null;
    if (show.openingDate) {
      const parsed = new Date(show.openingDate);
      if (!isNaN(parsed.getTime())) {
        openingDate = parsed.toISOString().split('T')[0];
      }
    }

    let closingDate = null;
    if (show.closingDate) {
      const parsed = new Date(show.closingDate);
      if (!isNaN(parsed.getTime())) {
        closingDate = parsed.toISOString().split('T')[0];
      }
    }

    let previewsStartDate = null;
    if (show.previewsStartDate) {
      const parsed = new Date(show.previewsStartDate);
      if (!isNaN(parsed.getTime())) {
        previewsStartDate = parsed.toISOString().split('T')[0];
      }
    }

    // Use the production's own year for the ID. Order matters: openingDate,
    // then previewsStartDate, then the quarantined unconfirmedStartDate, and
    // only then fall back to "now".
    //
    // The `new Date().getFullYear()` fallback is the third link in the
    // 2027-Encores! chain (2026-08-12). A season announced 6-10 months out
    // reaches here with openingDate null (see classifyTodayTixStartDate), so
    // every 2027 show was minted as `<slug>-off-broadway-2026`. That is both
    // wrong on its face and self-blocking: "You're a Good Man, Charlie Brown"
    // (Feb 2027) generated the SAME id as the 92NY production that ran in
    // March 2026, so the ID-collision guard below dropped it even after the
    // twin guard was taught to let it through. A date we don't trust enough
    // to gate reviews on is still plenty good enough to name a row.
    const idYear = productionIdYear({ openingDate, previewsStartDate, unconfirmedStartDate: show.unconfirmedStartDate })
      || String(new Date().getFullYear());
    const baseSlug = slugify(show.title);

    // Market-aware slug and ID generation
    const marketSlug = show.category === 'west-end' ? `${baseSlug}-west-end`
               : show.category === 'off-west-end' ? `${baseSlug}-off-west-end`
               : show.category === 'off-broadway' ? `${baseSlug}-off-broadway`
               : baseSlug;
    const showId = show.category === 'west-end' ? `${baseSlug}-west-end-${idYear}`
                 : show.category === 'off-west-end' ? `${baseSlug}-off-west-end-${idYear}`
                 : show.category === 'off-broadway' ? `${baseSlug}-off-broadway-${idYear}`
                 : `${baseSlug}-${idYear}`;

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
    });
  }

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
          const { result } = splitCombinedCredits(ibdb.creativeTeam);
          show.creativeTeam = result;
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
    return { newShows: [], count: 0, reconciledCount: reconciledShows.length };
  }

  console.log(`🎭 Found ${newShows.length} NEW show(s):`);
  console.log('-'.repeat(40));

  // Build title index from existing shows for cross-reference revival detection
  // Use full normalized title (no subtitle stripping) to avoid false positives
  // e.g. "Seagull: True Story" should NOT match "The Seagull"
  const normalizeTitle = (t) => t.toLowerCase()
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/['']/g, "'")
    .replace(/[^a-z0-9' ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const existingTitleMap = new Map(); // normalized title → { type, id, category }
  for (const s of data.shows) {
    const norm = normalizeTitle(s.title);
    if (norm.length < 4) continue; // skip very short titles to avoid false matches (art, bug, etc.)
    if (!existingTitleMap.has(norm)) {
      existingTitleMap.set(norm, { type: s.type, id: s.id, category: s.category, title: s.title });
    }
  }

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
      // Cross-reference against existing shows in shows.json
      // Try full normalized title first, then base title (before colon/parens) for 5+ char bases
      const norm = normalizeTitle(show.title);
      let match = existingTitleMap.get(norm);
      if (!match || match.id === show.id) {
        // Try base title (before colon, dash, or parens) — only if 5+ chars to avoid false positives
        const base = show.title.replace(/\s*[:(\-–—].*/g, '').trim();
        const normBase = normalizeTitle(base);
        if (normBase.length >= 5 && normBase !== norm) {
          match = existingTitleMap.get(normBase);
        }
      }
      // A same-title match in a DIFFERENT market (e.g. a West End production
      // transferring to Broadway, like Inter Alia 2026) is a transfer, not a
      // revival — only same-market matches are real revival evidence.
      // (Inter Alia Broadway shipped isRevival:true 2026-08-14 solely because
      // the West End "Inter Alia" entry already existed in shows.json.)
      // Broadway is stored 3 ways in shows.json (absent key / null / 'broadway'
      // string, per isBroadwayCategory's own doc comment) — compare via that
      // predicate rather than raw === so a match against a null/'broadway'
      // legacy entry isn't wrongly treated as cross-market (2026-08-14 review).
      const normMarket = (cat) => isBroadwayCategory({ category: cat }) ? 'broadway' : cat;
      const sameMarket = match && normMarket(match.category) === normMarket(show.category);
      if (match && match.id !== show.id && sameMarket) {
        isRevival = true;
        detectedType = match.type || detectedType;
        confidence = 'high';
        console.log(`  📋 Revival detected via cross-reference: "${show.title}" matches existing "${match.title}" (${match.id})`);
      } else if (match && match.id !== show.id) {
        console.log(`  ↔️  Cross-market title match (not revival): "${show.title}" (${show.category || 'broadway'}) vs existing "${match.title}" (${match.category || 'broadway'}, ${match.id}) — treating as transfer`);
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
    } else if (/[-–—:]\s*the\s+musical\b|:\s*a\s+(new\s+)?musical\b/i.test(show.title)) {
      // Title suffix like "Dog Man - The Musical" or "Show: A New Musical"
      // Avoids false positives like "The Musical Comedy Murders of 1940"
      detectedType = 'musical';
      confidence = 'medium';
    } else if (isPlay) {
      detectedType = 'play';
      confidence = 'medium';
    }

    return { show, detectedType, isRevival, confidence };
  });

  // Stage 3: IBDB revival detection for shows not yet identified as revivals
  // Only for OB/WE shows where known-shows and cross-reference didn't find a match
  const undetected = revivalDetection.filter(d => !d.isRevival && d.detectedType !== 'special');
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
      if (result.isRevival) {
        det.isRevival = true;
        if (result.confidence === 'high') det.confidence = 'high';
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
          // "Opens Mar 08" — the date IS the opening date (not preview date)
          status = 'previews';
          openingDate = show.openingDate; // ShowScore "Opens" date = press night
        }
      } else if (show.openingDate) {
        openingDate = show.openingDate;
        const openingDateObj = new Date(openingDate);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        if (openingDateObj > today) {
          status = 'upcoming';
        } else if (show.category === 'off-broadway' && !show.ibdbUrl) {
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
        synopsis: show.description ? show.description.replace(/<[^>]*>/g, '').replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().substring(0, 500) : '',
        ageRecommendation: (runtimeEnrichments[show.id] && runtimeEnrichments[show.id].ageRecommendation) || null,
        previewsStartDate: show.previewsStartDate || null,
        openingDateSource: show.openingDateSource || null,
        tags: tags,
        theaterAddress: getTheaterAddress(show.venue) || null,
        ticketLinks: [],
        cast: [],
        creativeTeam: show.creativeTeam || [],
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
        const { _showScoreUrl, _source, ...clean } = s;
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
            urlData.shows[addedShow.id] = url;
            urlsAssigned++;
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

  return { newShows, count: newShows.length, reconciledCount: reconciledShows.length };
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
  isOneNightShow,
  obFallbackFlags,
  bwayFallbackFlags,
  isBroadwayHouse,
  resolveTodayTixVenue,
  EXCLUDED_TITLES,
  NON_THEATER_PATTERNS,
  VENUE_LISTING_PAGES,
  fetchSingleVenuePage,
  shouldExcludeVenueShow,
};
