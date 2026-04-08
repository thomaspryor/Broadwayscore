#!/usr/bin/env node
/**
 * Tests for opening night fixes #12, #13, #14
 * Run: node scripts/test-opening-night-fixes.js
 * No API calls — pure logic verification.
 *
 * RULE: Never copy logic into this file — always require() the real function.
 * Pure decision functions live in scripts/lib/review-guards.js.
 * If production code changes, update review-guards.js; the tests will break and
 * force you to verify the new behavior. That's the point.
 * See: scripts/lib/review-guards.js
 */

const { shouldSkipScoredReview, pickBestDtliSlug, applyTemporalOverrides } = require('./lib/review-guards');

let passed = 0;
let failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ============================================================
// FIX #12 — Selection guard in collect-review-texts.js
// Guard: skip re-fetch if assignedScore>=1 AND textLen>=100 AND reviewFilter empty
// Real function: shouldSkipScoredReview() from scripts/lib/review-guards.js
// ============================================================
console.log('\n=== FIX #12: assignedScore guard (selection-time skip) ===\n');

// Normal: scored + long text → skip (guard fires)
assert(
  shouldSkipScoredReview({ assignedScore: 75, fullText: 'a'.repeat(500) }) === true,
  'Scored review with 500-char text is skipped (guard fires)'
);

// Short text: scored but textLen < 100 → do NOT skip (needs re-fetch)
assert(
  shouldSkipScoredReview({ assignedScore: 75, fullText: 'short' }) === false,
  'Scored review with 5-char text is NOT skipped (needs re-fetch)'
);

// score=0: not scored → do NOT skip
assert(
  shouldSkipScoredReview({ assignedScore: 0, fullText: 'a'.repeat(500) }) === false,
  'Score=0 review is NOT skipped (0 < 1 fails guard)'
);

// No score field: not scored → do NOT skip
assert(
  shouldSkipScoredReview({ fullText: 'a'.repeat(500) }) === false,
  'Review with no assignedScore is NOT skipped'
);

// Text is null (was nulled due to wrongFullText): textLen=0 → do NOT skip
assert(
  shouldSkipScoredReview({ assignedScore: 75, fullText: null }) === false,
  'Scored review with null fullText is NOT skipped (will be re-fetched)'
);

// score=100: boundary — still a valid score → skip
assert(
  shouldSkipScoredReview({ assignedScore: 100, fullText: 'a'.repeat(100) }) === true,
  'Score=100 review with exactly 100-char text is skipped (boundary)'
);

// textLen=100: boundary → skip
assert(
  shouldSkipScoredReview({ assignedScore: 50, fullText: 'a'.repeat(100) }) === true,
  'Score=50 review with exactly 100-char text is skipped (boundary)'
);

// textLen=99: just below boundary → do NOT skip
assert(
  shouldSkipScoredReview({ assignedScore: 50, fullText: 'a'.repeat(99) }) === false,
  'Score=50 review with 99-char text is NOT skipped (99 < 100)'
);

// reviewFilter override: when reviewFilter.size > 0, guard does NOT fire
assert(
  shouldSkipScoredReview({ assignedScore: 75, fullText: 'a'.repeat(500) }, 1) === false,
  'Explicit reviewFilter bypasses guard (reviewFilter.size=1)'
);

// score=101: above max (101 > 100) → do NOT skip (guard: <= 100)
assert(
  shouldSkipScoredReview({ assignedScore: 101, fullText: 'a'.repeat(500) }) === false,
  'Score=101 is NOT skipped (above max 100)'
);

// ============================================================
// FIX #12 — heuristic guards (post-scrape)
// These are in the fetch-processing path — verify the alreadyScored logic
// ============================================================
console.log('\n=== FIX #12: post-scrape guards (alreadyScored path) ===\n');

function simulateShowNotMentioned(data) {
  const alreadyScored = !!(data.assignedScore && data.assignedScore >= 1 && data.assignedScore <= 100);
  if (alreadyScored) {
    return { action: 'flag', field: 'needsReview' };
  } else {
    return { action: 'null', field: 'fullText' };
  }
}

assert(
  simulateShowNotMentioned({ assignedScore: 75 }).action === 'flag',
  'Scored review: showNotMentioned fires flag (not null)'
);

assert(
  simulateShowNotMentioned({}).action === 'null',
  'Unscored review: showNotMentioned nulls fullText'
);

assert(
  simulateShowNotMentioned({ assignedScore: 0 }).action === 'null',
  'Score=0: not alreadyScored → nulls fullText'
);

// ============================================================
// FIX #14 — temporal override in content-verifier.js
// wrongProduction: confidence downgraded to 'low' within 30 days
// isFilmTv: flag cleared entirely within 30 days
// Real function: applyTemporalOverrides() from scripts/lib/review-guards.js
// ============================================================
console.log('\n=== FIX #14: temporal overrides for wrongProduction and isFilmTv ===\n');

const openingDate = '2026-03-23'; // Giant opening night

// Helper: wraps applyTemporalOverrides and adds willNullFullText for assertion convenience
// (willNullFullText = downstream consequence; not part of the guard itself)
function callTemporalOverride({ wpFlag, filmTvFlag, publishDate }) {
  const r = applyTemporalOverrides(wpFlag, filmTvFlag, 'high', openingDate, publishDate);
  const willNullFullText = wpFlag && (r.wpConfidence === 'high' || r.wpConfidence === 'medium');
  return { ...r, willNullFullText };
}

// Day 0 (opening night): should override
{
  const r = callTemporalOverride({ wpFlag: true, filmTvFlag: false, publishDate: '2026-03-23' });
  assert(r.wpConfidence === 'low', 'wrongProduction on opening night (day 0): confidence downgraded to low');
  assert(!r.willNullFullText, 'wrongProduction on opening night: will NOT null fullText');
}

// Day 15 (within 30d): should override
{
  const r = callTemporalOverride({ wpFlag: true, filmTvFlag: false, publishDate: '2026-04-07' });
  assert(r.wpConfidence === 'low', 'wrongProduction at day 15: confidence downgraded to low');
  assert(!r.willNullFullText, 'wrongProduction at day 15: will NOT null fullText');
}

// Day 30 (boundary): should STILL override (daysDiff <= 30 is inclusive)
{
  const r = callTemporalOverride({ wpFlag: true, filmTvFlag: false, publishDate: '2026-04-22' });
  assert(r.wpConfidence === 'low', 'wrongProduction at day 30 (boundary): confidence downgraded to low');
  assert(!r.willNullFullText, 'wrongProduction at day 30: will NOT null fullText');
}

// Day 31 (outside window): should NOT override
{
  const r = callTemporalOverride({ wpFlag: true, filmTvFlag: false, publishDate: '2026-04-23' });
  assert(r.wpConfidence === 'high', 'wrongProduction at day 31: confidence stays high (no override)');
  assert(r.willNullFullText, 'wrongProduction at day 31: WILL null fullText (expected behavior)');
}

// isFilmTv: cleared entirely within 30 days
{
  const r = callTemporalOverride({ wpFlag: false, filmTvFlag: true, publishDate: '2026-03-25' });
  assert(r.filmTvFlag === false, 'isFilmTv at day 2: cleared entirely');
}

// isFilmTv: NOT cleared after 31 days
{
  const r = callTemporalOverride({ wpFlag: false, filmTvFlag: true, publishDate: '2026-04-24' });
  assert(r.filmTvFlag === true, 'isFilmTv at day 32: NOT cleared (outside 30d window)');
}

// Review published BEFORE opening (abs value handles pre-opening reviews)
{
  const r = callTemporalOverride({ wpFlag: true, filmTvFlag: false, publishDate: '2026-03-10' });
  // 13 days before opening: abs(daysDiff) = 13, within window
  assert(r.wpConfidence === 'low', 'wrongProduction 13 days BEFORE opening: still overridden (abs covers previews)');
}

// No openingDate: no override (can't compute diff) — call real function directly
{
  const r = applyTemporalOverrides(true, false, 'high', null, '2026-03-23');
  assert(r.wpConfidence === 'high', 'wrongProduction with no openingDate: no override (high stays)');
}

// No publishDate: no override
{
  const r = applyTemporalOverrides(true, false, 'high', openingDate, null);
  assert(r.wpConfidence === 'high', 'wrongProduction with no publishDate: no override (high stays)');
}

// Both flags false: no damage
{
  const r = applyTemporalOverrides(false, false, 'high', openingDate, '2026-03-23');
  assert(r.filmTvFlag === false && !r.wpConfidence !== 'low', 'Neither flag set: no overrides needed, no damage');
}

// ============================================================
// FIX #14 — isValid interaction with downstream null logic
// Verify that low-confidence wrongProduction does NOT null fullText
// ============================================================
console.log('\n=== FIX #14: isHighConfidence gate prevents fullText nulling ===\n');

function simulateWrongProductionAction({ wrongProduction, confidence, alreadyScored, showCat }) {
  const isHighConfidence = confidence === 'high' || confidence === 'medium';
  if (wrongProduction && isHighConfidence && showCat !== 'off-broadway') {
    if (alreadyScored) return 'flag';
    return 'null';
  }
  return 'keep';
}

assert(
  simulateWrongProductionAction({ wrongProduction: true, confidence: 'high', alreadyScored: false, showCat: 'play' }) === 'null',
  'wrongProduction + high confidence + unscored → nulls fullText'
);

assert(
  simulateWrongProductionAction({ wrongProduction: true, confidence: 'low', alreadyScored: false, showCat: 'play' }) === 'keep',
  'wrongProduction + LOW confidence (temporal override) → keeps fullText'
);

assert(
  simulateWrongProductionAction({ wrongProduction: true, confidence: 'high', alreadyScored: true, showCat: 'play' }) === 'flag',
  'wrongProduction + high confidence + ALREADY SCORED → flags for review (not null)'
);

assert(
  simulateWrongProductionAction({ wrongProduction: true, confidence: 'high', alreadyScored: false, showCat: 'off-broadway' }) === 'keep',
  'wrongProduction + off-broadway show → exempt, keeps fullText'
);

// ============================================================
// FIX #13 — Revival preference logic
// Real function: pickBestDtliSlug() from scripts/lib/review-guards.js
// ============================================================
console.log('\n=== FIX #13: Revival slug preference ===\n');

// Giant: bare vs numbered → should pick numbered
assert(
  pickBestDtliSlug('giant-2026', ['giant', 'giant-2']) === 'giant-2',
  'giant-2026 with [giant, giant-2] picks giant-2 (revival preference)'
);

// Multiple suffixes: picks highest number
assert(
  pickBestDtliSlug('company-2022', ['company', 'company-2', 'company-3']) === 'company-3',
  'company-2022 with 3 candidates picks highest suffix (company-3)'
);

// No year in showId: no revival preference, first wins
assert(
  pickBestDtliSlug('hamilton', ['hamilton', 'hamilton-2']) === 'hamilton',
  'show without year suffix: first candidate wins (no revival preference)'
);

// Only bare slug available: revival show falls back to bare
assert(
  pickBestDtliSlug('giant-2026', ['giant']) === 'giant',
  'revival show with only bare slug: uses bare slug (no numbered candidates)'
);

// Single candidate: trivially returns it
assert(
  pickBestDtliSlug('wicked-2024', ['wicked-2']) === 'wicked-2',
  'single candidate: always returns it regardless'
);

// Year suffix show with only numbered (no bare): picks highest
assert(
  pickBestDtliSlug('annie-2024', ['annie-2', 'annie-3']) === 'annie-3',
  'revival show with multiple numbered slugs (no bare): picks highest'
);

// Non-revival show with ambiguous slugs: picks first (existing behavior preserved)
assert(
  pickBestDtliSlug('cabaret', ['cabaret', 'cabaret-at-the-kit-kat-club']) === 'cabaret',
  'non-revival show with ambiguous slugs: first wins'
);

// ============================================================
// FIX — isWithinOpeningWindow (rss-discovery.js)
// Date-window helper for narrow Broadway theater feeds.
// ============================================================
console.log('\n=== isWithinOpeningWindow: date window logic ===\n');

const { isWithinOpeningWindow } = require('./lib/rss-discovery');

const OPENING = '2026-03-23';

// Opening night itself
assert(
  isWithinOpeningWindow(new Date('2026-03-23'), OPENING, 2),
  'Day 0 (opening night): within window'
);

// Boundary: exactly ±2 days
assert(
  isWithinOpeningWindow(new Date('2026-03-25'), OPENING, 2),
  'Day +2 (boundary): within window (inclusive)'
);
assert(
  isWithinOpeningWindow(new Date('2026-03-21'), OPENING, 2),
  'Day -2 (preview boundary): within window (inclusive)'
);

// Outside boundary
assert(
  !isWithinOpeningWindow(new Date('2026-03-26'), OPENING, 2),
  'Day +3: outside window'
);
assert(
  !isWithinOpeningWindow(new Date('2026-03-20'), OPENING, 2),
  'Day -3: outside window'
);

// Fail-open cases
assert(
  isWithinOpeningWindow(null, OPENING, 2),
  'null pubDate: fail-open (no date = include)'
);
assert(
  isWithinOpeningWindow(undefined, OPENING, 2),
  'undefined pubDate: fail-open'
);
assert(
  isWithinOpeningWindow(new Date('2026-03-23'), null, 2),
  'null openingDate: fail-open'
);
assert(
  isWithinOpeningWindow(new Date('2026-03-23'), 'not-a-date', 2),
  'invalid openingDate string: fail-open'
);
assert(
  isWithinOpeningWindow(new Date('invalid'), OPENING, 2),
  'invalid pubDate (NaN): fail-open'
);

// Custom window size
assert(
  isWithinOpeningWindow(new Date('2026-03-20'), OPENING, 3),
  'Day -3 within window=3: included'
);
assert(
  !isWithinOpeningWindow(new Date('2026-03-19'), OPENING, 3),
  'Day -4 within window=3: excluded'
);

// ============================================================
// FIX — openingWindow feed flag (rss-discovery.js)
// Only narrow Broadway feeds get date-window; WE feeds always title-match.
// ============================================================
console.log('\n=== openingWindow: only narrow Broadway feeds flagged ===\n');

const { ALL_FEEDS, titleMatchesShow } = require('./lib/rss-discovery');

const varietyFeed = ALL_FEEDS.find(f => f.name === 'Variety Legit');
const nytFeed = ALL_FEEDS.find(f => f.name === 'NYT Theater');
const wosFeed = ALL_FEEDS.find(f => f.name === 'WhatsOnStage');
const standardFeed = ALL_FEEDS.find(f => f.name === 'Evening Standard Theatre');
const thrFeed = ALL_FEEDS.find(f => f.name === 'THR');
const guardianFeed = ALL_FEEDS.find(f => f.name === 'Guardian Stage');

assert(varietyFeed && varietyFeed.openingWindow === true, 'Variety Legit: openingWindow=true');
assert(varietyFeed && varietyFeed.market === 'broadway', 'Variety Legit: market=broadway');
assert(nytFeed && nytFeed.openingWindow === true, 'NYT Theater: openingWindow=true');
assert(nytFeed && nytFeed.market === 'broadway', 'NYT Theater: market=broadway');
assert(wosFeed && !wosFeed.openingWindow, 'WhatsOnStage: no openingWindow (WE feed — always title-matches)');
assert(wosFeed && wosFeed.market === 'west-end', 'WhatsOnStage: market=west-end');
assert(standardFeed && !standardFeed.openingWindow, 'Evening Standard: no openingWindow (WE feed)');
assert(standardFeed && standardFeed.market === 'west-end', 'Evening Standard: market=west-end');
assert(thrFeed && !thrFeed.openingWindow, 'THR: no openingWindow (entertainment feed, has needsFilter)');
assert(!thrFeed.market, 'THR: no market restriction (covers both BW and WE)');
assert(!guardianFeed, 'Guardian Stage: removed from ALL_FEEDS entirely (too broad)');

// ============================================================
// Section pages use urlLooksLikeReview for show-title filtering.
// skipUrlFilter removed from Variety and Vulture — was causing all section-page
// reviews to be written as files for the polled show regardless of actual content.
// ============================================================
console.log('\n=== URL filtering: all endpoints use urlLooksLikeReview for show matching ===\n');

const { SITE_SEARCH_ENDPOINTS } = require('./lib/site-search-discovery');

assert(
  SITE_SEARCH_ENDPOINTS.variety && !SITE_SEARCH_ENDPOINTS.variety.skipUrlFilter,
  'variety: no skipUrlFilter (urlLooksLikeReview filters to polled show)'
);
assert(
  SITE_SEARCH_ENDPOINTS.theatermania && !SITE_SEARCH_ENDPOINTS.theatermania.skipUrlFilter,
  'theatermania: no skipUrlFilter (date-windowed API still needs title filtering)'
);
assert(
  SITE_SEARCH_ENDPOINTS.guardian && !SITE_SEARCH_ENDPOINTS.guardian.skipUrlFilter,
  'guardian: no skipUrlFilter (unchanged)'
);
assert(
  SITE_SEARCH_ENDPOINTS.independent && !SITE_SEARCH_ENDPOINTS.independent.skipUrlFilter,
  'independent: no skipUrlFilter (unchanged)'
);
assert(
  SITE_SEARCH_ENDPOINTS['times-uk'] && !SITE_SEARCH_ENDPOINTS['times-uk'].skipUrlFilter,
  'times-uk: no skipUrlFilter (unchanged)'
);

// ============================================================
// urlLooksLikeReview (site-search-discovery.js → review-guards.js)
// URL-based filter: rejects tag/author/search pages, matches show title words.
// Real function: urlLooksLikeReview() from scripts/lib/review-guards.js
// ============================================================
console.log('\n=== urlLooksLikeReview: URL title-match and rejection logic ===\n');

const { urlLooksLikeReview } = require('./lib/review-guards');

// Basic: URL slug contains show title words → pass
assert(
  urlLooksLikeReview('https://www.theatermania.com/new-york/theater/reviews/giant-review/', 'Giant'),
  'Giant: URL contains "giant" → passes'
);
assert(
  urlLooksLikeReview('https://www.vulture.com/2026/03/hamilton-review-still-brilliant.html', 'Hamilton'),
  'Hamilton: URL contains "hamilton" → passes'
);

// Article-prefixed title: "the" is stripped, remaining word must match
assert(
  urlLooksLikeReview('https://deadline.com/2026/03/notebook-review-broadway/', 'The Notebook'),
  'The Notebook: "the" stripped, "notebook" in URL → passes'
);
assert(
  !urlLooksLikeReview('https://deadline.com/2026/03/something-else-review/', 'The Notebook'),
  'The Notebook: URL has no notebook → rejected'
);

// 50% threshold: 2 of 4 words sufficient
assert(
  urlLooksLikeReview('https://example.com/outsiders-review-broadway/', 'The Outsiders'),
  'The Outsiders: "outsiders" (1 of 1 significant word) → passes'
);
assert(
  urlLooksLikeReview('https://example.com/play-goes-wrong-review/', 'The Play That Goes Wrong'),
  'The Play That Goes Wrong: "play", "goes", "wrong" (3/3 after filtering) → passes'
);

// Rejection: tag/author/category pages
assert(
  !urlLooksLikeReview('https://variety.com/tag/hamilton/', 'Hamilton'),
  'Tag page → rejected'
);
assert(
  !urlLooksLikeReview('https://nytimes.com/author/ben-brantley/', 'Giant'),
  'Author page → rejected'
);
assert(
  !urlLooksLikeReview('https://example.com/category/theater/hamilton/', 'Hamilton'),
  'Category page → rejected'
);

// Rejection: search and pagination
assert(
  !urlLooksLikeReview('https://example.com/search?q=hamilton', 'Hamilton'),
  'Search URL → rejected'
);
assert(
  !urlLooksLikeReview('https://example.com/page/2/', 'Hamilton'),
  'Pagination URL → rejected'
);

// Rejection: ticket URL without review
assert(
  !urlLooksLikeReview('https://telecharge.com/ticket/hamilton/', 'Hamilton'),
  'Ticket URL without "review" → rejected'
);

// Ticket URL that also contains "review" → pass (e.g. ticketmaster review page)
assert(
  urlLooksLikeReview('https://example.com/ticket-review/hamilton/', 'Hamilton'),
  'Ticket URL that also contains "review" → passes'
);

// Single-word title "Giant" (length 5 > 2 threshold → kept)
assert(
  urlLooksLikeReview('https://theatermania.com/reviews/giant-2026/', 'Giant'),
  'Giant: single significant word, in URL → passes'
);
assert(
  !urlLooksLikeReview('https://theatermania.com/reviews/wicked-2026/', 'Giant'),
  'Giant: URL contains other show name → rejected'
);

// Short-word titles: all words ≤2 chars → fail-open (no significant words → include)
assert(
  urlLooksLikeReview('https://example.com/anything/random-url/', 'I Am'),
  'Title with no significant words (all ≤2 chars) → fail-open (true)'
);

// Word-boundary matching: prevents substring false positives
assert(
  !urlLooksLikeReview('https://example.com/trump-executive-order-review/', 'Tru'),
  'Tru: does NOT match "trump" (substring, not word boundary)'
);
assert(
  urlLooksLikeReview('https://example.com/tru-broadway-review/', 'Tru'),
  'Tru: DOES match "tru" at word boundary (hyphen-delimited)'
);
assert(
  !urlLooksLikeReview('https://example.com/how-to-debug-code/', 'Bug'),
  'Bug: does NOT match "debug" (substring)'
);
assert(
  urlLooksLikeReview('https://example.com/bug-broadway-review-carrie-coon/', 'Bug'),
  'Bug: DOES match "bug" at word boundary'
);
assert(
  !titleMatchesShow('Trump Signs Executive Order on Broadway Funding', 'Tru'),
  'RSS: Tru does NOT match Trump headline'
);
assert(
  titleMatchesShow("Tru: Gossipy Truman Capote on the Warpath", 'Tru'),
  'RSS: Tru DOES match actual Tru review headline'
);

// Special chars in title stripped cleanly
assert(
  urlLooksLikeReview('https://example.com/into-woods-review/', 'Into the Woods!'),
  'Into the Woods!: special chars stripped, "into" + "woods" match → passes'
);

// ============================================================
// Vulture site-search endpoint configuration
// Verifies SITE_SEARCH_ENDPOINTS has Vulture correctly configured.
// ============================================================
console.log('\n=== Vulture Site Search Configuration ===\n');

const vultureConfig = SITE_SEARCH_ENDPOINTS['vulture'];

assert(
  vultureConfig !== undefined,
  'Vulture is present in SITE_SEARCH_ENDPOINTS'
);

assert(
  vultureConfig && vultureConfig.name === 'Vulture',
  'Vulture config has correct name'
);

assert(
  vultureConfig && vultureConfig.domain === 'vulture.com',
  'Vulture config has correct domain'
);

assert(
  vultureConfig && vultureConfig.requiresJs === true,
  'Vulture config requires JS rendering'
);

assert(
  vultureConfig && typeof vultureConfig.fetchAndParse === 'function',
  'Vulture config has fetchAndParse function'
);

assert(
  !vultureConfig.skipUrlFilter,
  'Vulture has no skipUrlFilter (urlLooksLikeReview filters to polled show)'
);

assert(
  vultureConfig && !vultureConfig.market,
  'Vulture config has no market restriction (reviews both BW and WE shows)'
);

// ============================================================
// Daily Beast ID fix — endpoint key matches outlet-registry.json
// ============================================================
console.log('\n=== Daily Beast Site Search ===\n');

assert(
  SITE_SEARCH_ENDPOINTS['dailybeast'] === undefined,
  'dailybeast disabled (search is JS-rendered, times out on ScrapingBee)'
);

assert(
  SITE_SEARCH_ENDPOINTS['daily-beast'] === undefined,
  'old daily-beast key also absent'
);

// ============================================================
// Broadway News RSS feed configuration
// ============================================================
console.log('\n=== Broadway News RSS Feed ===\n');

const bnFeed = ALL_FEEDS.find(f => f.outletId === 'broadwaynews');

assert(
  bnFeed !== undefined,
  'Broadway News is present in ALL_FEEDS'
);

assert(
  bnFeed && bnFeed.url === 'https://www.broadwaynews.com/tag/review/rss/',
  'Broadway News uses tag-filtered review RSS (not main feed)'
);

assert(
  bnFeed && bnFeed.needsFilter === true,
  'Broadway News requires title filtering (needsFilter=true)'
);

assert(
  bnFeed && !bnFeed.openingWindow,
  'Broadway News does NOT use openingWindow (reviews cover all shows, not just Broadway openings)'
);

// ============================================================
// Title matching: Broadway News review titles
// Broadway News titles follow pattern: "The Broadway Review: '{Title}' ..."
// titleMatchesShow must handle smart quotes and surrounding text
// ============================================================
console.log('\n=== Broadway News Title Matching ===\n');

assert(
  titleMatchesShow("The Broadway Review: 'Dead Outlaw' makes beautiful music in the dark", 'Dead Outlaw'),
  'BN: Dead Outlaw with smart quotes matches'
);

assert(
  titleMatchesShow("The Broadway Review: Broadway's 'Real Women Have Curves' is more jubilant", 'Real Women Have Curves'),
  'BN: Real Women Have Curves matches (ignoring articles)'
);

assert(
  titleMatchesShow("The Broadway Review: 'Giant' at the Broadway Theatre", 'Giant'),
  'BN: Single-word title Giant matches'
);

assert(
  !titleMatchesShow("The Broadway Review: 'Dead Outlaw' makes beautiful music", 'Giant'),
  'BN: Dead Outlaw does NOT match Giant (different show)'
);

assert(
  titleMatchesShow("The Broadway Review: 'Stranger Things: The First Shadow' is jaw-dropping", 'Stranger Things: The First Shadow'),
  'BN: Stranger Things matches with subtitle'
);

// ============================================================
// WSJ, LA Times, WashPost RSS feed configuration
// ============================================================
console.log('\n=== T1 RSS Feeds: WSJ, LA Times, WashPost ===\n');

const wsjFeed = ALL_FEEDS.find(f => f.outletId === 'wsj');
const latimesFeed = ALL_FEEDS.find(f => f.outletId === 'latimes');
const washpostFeed = ALL_FEEDS.find(f => f.outletId === 'washpost');

assert(wsjFeed !== undefined, 'WSJ is present in ALL_FEEDS');
assert(wsjFeed && wsjFeed.needsFilter === true, 'WSJ uses needsFilter (general lifestyle feed)');
assert(wsjFeed && !wsjFeed.openingWindow, 'WSJ has no openingWindow (too broad)');

assert(latimesFeed !== undefined, 'LA Times is present in ALL_FEEDS');
assert(latimesFeed && latimesFeed.needsFilter === true, 'LA Times uses needsFilter (general entertainment feed)');

assert(washpostFeed !== undefined, 'WashPost is present in ALL_FEEDS');
assert(washpostFeed && washpostFeed.needsFilter === true, 'WashPost uses needsFilter (general entertainment feed)');

const newyorkerFeed = ALL_FEEDS.find(f => f.outletId === 'newyorker');
assert(newyorkerFeed !== undefined, 'New Yorker is present in ALL_FEEDS');
assert(newyorkerFeed && newyorkerFeed.needsFilter === true, 'New Yorker uses needsFilter (general culture feed)');
assert(newyorkerFeed && newyorkerFeed.url.includes('/feed/culture'), 'New Yorker uses /feed/culture (not /feed/culture/cultural-comment)');

// New Yorker title matching — reviews use "Theatre Review:" or show title in headline
assert(
  titleMatchesShow('Theatre Review: "An Ark" and "Data"', 'An Ark'),
  'NY: "An Ark" theater review matches'
);
assert(
  titleMatchesShow('In Tracy Letts\'s "Bug," Crazy Is Contagious', 'Bug'),
  'NY: Bug review matches (show title in headline)'
);
assert(
  !titleMatchesShow('Two Playwrights Tackle Father Figures', 'Giant'),
  'NY: Negative — generic headline does NOT match Giant'
);

// ============================================================
// NY Stage Review + NY Theater RSS feed configuration
// ============================================================
console.log('\n=== T2 RSS Feeds: NY Stage Review, NY Theater ===\n');

const nysrFeed = ALL_FEEDS.find(f => f.outletId === 'nysr');
assert(nysrFeed !== undefined, 'NY Stage Review is present in ALL_FEEDS');
assert(nysrFeed && nysrFeed.needsFilter === true, 'NYSR uses needsFilter (title matching)');
assert(nysrFeed && !nysrFeed.openingWindow, 'NYSR has no openingWindow (covers all shows)');
assert(nysrFeed && nysrFeed.url.includes('nystagereview.com'), 'NYSR has correct feed URL');

const nytTheaterFeed = ALL_FEEDS.find(f => f.outletId === 'nyt-theater');
assert(nytTheaterFeed !== undefined, 'NY Theater is present in ALL_FEEDS');
assert(nytTheaterFeed && nytTheaterFeed.needsFilter === true, 'NY Theater uses needsFilter');
assert(nytTheaterFeed && nytTheaterFeed.url.includes('newyorktheater.me'), 'NY Theater has correct feed URL');

// Title matching for NYSR and NY Theater headline patterns
assert(
  titleMatchesShow('Giant: Author/Antisemite Roald Dahl Erupts Volcanically', 'Giant'),
  'NYSR: Giant review headline matches'
);
assert(
  titleMatchesShow('Jesa: Honoring the Ancestors, or Maybe Not', 'Jesa'),
  'NYSR: Jesa review headline matches'
);
assert(
  titleMatchesShow('Giant Review. John Lithgow as Roald Dahl, Antisemite', 'Giant'),
  'NYT: Giant review headline matches'
);
assert(
  !titleMatchesShow('No Kings Protests Today in NYC', 'Giant'),
  'NYT: Negative — protest news does NOT match Giant'
);
assert(
  !titleMatchesShow('Giant: Author/Antisemite Roald Dahl Erupts Volcanically', 'Hamilton'),
  'NYSR: Negative — Giant review does NOT match Hamilton'
);

// ============================================================
// NBC NY, HuffPost, Slant Magazine RSS feed configuration
// ============================================================
console.log('\n=== T2 RSS Feeds: NBC NY, HuffPost, Slant ===\n');

const nbcnyFeed = ALL_FEEDS.find(f => f.outletId === 'nbcny');
assert(nbcnyFeed !== undefined, 'NBC NY is present in ALL_FEEDS');
assert(nbcnyFeed && nbcnyFeed.needsFilter === true, 'NBC NY uses needsFilter');

const huffpostFeed = ALL_FEEDS.find(f => f.outletId === 'huffpost');
assert(huffpostFeed !== undefined, 'HuffPost is present in ALL_FEEDS');
assert(huffpostFeed && huffpostFeed.needsFilter === true, 'HuffPost uses needsFilter');

const slantFeed = ALL_FEEDS.find(f => f.outletId === 'slantmagazine');
assert(slantFeed !== undefined, 'Slant Magazine is present in ALL_FEEDS');
assert(slantFeed && slantFeed.needsFilter === true, 'Slant uses needsFilter');

// Title matching for typical WSJ/LAT/WashPost review headlines
assert(
  titleMatchesShow("'Giant' Review: John Lithgow as a Venomous Roald Dahl", 'Giant'),
  'WSJ-style: Giant review headline matches'
);
assert(
  titleMatchesShow("Review: 'Hamilton' Electrifies Broadway", 'Hamilton'),
  'LAT-style: Hamilton review headline matches'
);
assert(
  !titleMatchesShow("Review: 'Giant' Robot Movie Crushes the Box Office", 'Hamilton'),
  'Negative: Giant robot movie does NOT match Hamilton'
);

// ============================================================
// Endpoint-registry ID consistency check
// All SITE_SEARCH_ENDPOINTS keys must exist in outlet-registry.json
// ============================================================
console.log('\n=== Endpoint-Registry ID Consistency ===\n');

const registry = require('../data/outlet-registry.json').outlets;
const endpointKeys = Object.keys(SITE_SEARCH_ENDPOINTS);
let idMismatches = 0;
for (const key of endpointKeys) {
  if (!registry[key]) {
    console.error(`  ✗ FAIL: endpoint "${key}" not in outlet-registry.json`);
    idMismatches++;
    failed++;
  }
}
if (idMismatches === 0) {
  console.log(`  ✓ All ${endpointKeys.length} endpoint keys match outlet-registry.json`);
  passed++;
} else {
  console.error(`  ${idMismatches} endpoint key(s) don't match registry — poller will never call them`);
}

// RSS feed outletId-registry consistency
const rssFeedIds = ALL_FEEDS.map(f => f.outletId);
let rssMismatches = 0;
for (const id of rssFeedIds) {
  if (!registry[id]) {
    console.error(`  ✗ FAIL: RSS feed outletId "${id}" not in outlet-registry.json`);
    rssMismatches++;
    failed++;
  }
}
if (rssMismatches === 0) {
  console.log(`  ✓ All ${rssFeedIds.length} RSS feed outletIds match outlet-registry.json`);
  passed++;
}

// ============================================================
// Tour/Regional Review Guard (review-guards.js)
// Detects regional BWW URLs and local paper tour reviews.
// ============================================================
console.log('\n=== isLikelyTourReview: tour/regional review detection ===\n');

const { isLikelyTourReview } = require('./lib/review-guards');

// Regional BWW cities → should flag for Broadway shows
assert(
  isLikelyTourReview('https://www.broadwayworld.com/des-moines/article/Review-LIFE-OF-PI', 'life-of-pi-2023'),
  'Regional BWW (des-moines): flagged for Broadway show'
);
assert(
  isLikelyTourReview('https://www.broadwayworld.com/cleveland/article/Review-SHUCKED', 'shucked-2023'),
  'Regional BWW (cleveland): flagged for Broadway show'
);
assert(
  isLikelyTourReview('https://www.broadwayworld.com/san-francisco/article/Review-A-BEAUTIFUL-NOISE', 'a-beautiful-noise-the-neil-diamond-musical-2022'),
  'Regional BWW (san-francisco): flagged for Broadway show'
);

// Local papers covering tour stops → should flag
assert(
  isLikelyTourReview('https://www.houstonchronicle.com/entertainment/theater/article/life-of-pi', 'life-of-pi-2023'),
  'Houston Chronicle: flagged as tour review'
);
assert(
  isLikelyTourReview('https://wehotimes.com/life-of-pi-at-the-ahmanson/', 'life-of-pi-2023'),
  'WeHo Times: flagged as tour review'
);
assert(
  isLikelyTourReview('https://bocamag.com/theatre-review-broadways-shucked-at-broward-center/', 'shucked-2023'),
  'Boca Magazine: flagged as tour review'
);

// Main BWW → should NOT flag
assert(
  !isLikelyTourReview('https://www.broadwayworld.com/article/Review-LIFE-OF-PI', 'life-of-pi-2023'),
  'Main BWW article: NOT flagged'
);

// Major outlets → should NOT flag
assert(
  !isLikelyTourReview('https://www.nytimes.com/2023/03/30/theater/life-of-pi-review.html', 'life-of-pi-2023'),
  'NYT: NOT flagged'
);
assert(
  !isLikelyTourReview('https://variety.com/2022/legit/news/life-of-pi-broadway', 'life-of-pi-2023'),
  'Variety: NOT flagged'
);

// West End shows → BWW westend/london legit, US cities are cross-market contamination
assert(
  !isLikelyTourReview('https://www.broadwayworld.com/westend/article/Review', 'teeth-n-smiles-west-end-2026'),
  'BWW westend for WE show: NOT flagged (legit WE coverage)'
);
assert(
  !isLikelyTourReview('https://www.broadwayworld.com/london/article/Review', 'teeth-n-smiles-west-end-2026'),
  'BWW london for WE show: NOT flagged (legit UK coverage)'
);
assert(
  isLikelyTourReview('https://www.broadwayworld.com/chicago/article/Review', 'moulin-rouge-west-end-2021'),
  'BWW chicago for WE show: FLAGGED (cross-market, US tour on WE show)'
);
assert(
  isLikelyTourReview('https://www.broadwayworld.com/denver/article/Review', 'oh-mary-west-end-2025'),
  'BWW denver for WE show: FLAGGED (cross-market contamination)'
);

// Off-Broadway shows → US regional BWW should flag (cross-market)
assert(
  isLikelyTourReview('https://www.broadwayworld.com/chicago/article/Review', 'something-off-broadway-2026'),
  'BWW chicago for off-broadway show: FLAGGED (cross-market)'
);

// Edge cases
assert(
  !isLikelyTourReview('', 'life-of-pi-2023'),
  'Empty URL: NOT flagged'
);
assert(
  !isLikelyTourReview(null, 'life-of-pi-2023'),
  'Null URL: NOT flagged'
);
assert(
  !isLikelyTourReview('https://www.broadwayworld.com/off-broadway/article/Review', 'life-of-pi-2023'),
  'BWW off-broadway section: NOT flagged (nonRegional list)'
);

// ============================================================
// isBWWRoundupContent — shared roundup validator (#16)
// ============================================================
console.log('\n--- isBWWRoundupContent (#16) ---');

const { isBWWRoundupContent } = require('./lib/bww-roundup-validator');

// Should REJECT: BWW homepage (has nav links with "Review Roundup" but no article markers)
assert(
  !isBWWRoundupContent('<html><head><title>BroadwayWorld</title></head><body><nav><a>Review Roundup</a></nav></body></html>'),
  'BWW homepage with "Review Roundup" in nav: REJECTED'
);

// Should REJECT: page without "Review Roundup" at all
assert(
  !isBWWRoundupContent('<html><body><p>Hello world</p></body></html>'),
  'Random page without Review Roundup: REJECTED'
);

// Should REJECT: empty string
assert(!isBWWRoundupContent(''), 'Empty string: REJECTED');

// Should ACCEPT: BlogPosting marker
assert(
  isBWWRoundupContent('<html><body>Review Roundup<script type="application/ld+json">{"@type":"BlogPosting"}</script></body></html>'),
  'Page with Review Roundup + BlogPosting: ACCEPTED'
);

// Should ACCEPT: articleBody marker
assert(
  isBWWRoundupContent('<html><body>Review Roundup<script type="application/ld+json">{"articleBody":"text"}</script></body></html>'),
  'Page with Review Roundup + articleBody: ACCEPTED'
);

// Should ACCEPT: Photo Credit marker
assert(
  isBWWRoundupContent('<html><body><h1>Review Roundup</h1><p>Photo Credit: Joan Marcus</p></body></html>'),
  'Page with Review Roundup + Photo Credit: ACCEPTED'
);

// Should ACCEPT: Opens-on-Broadway marker
assert(
  isBWWRoundupContent('<html><body><h1>Review Roundup: SHOW Opens-on-Broadway</h1></body></html>'),
  'Page with Opens-on-Broadway: ACCEPTED'
);

// Should ACCEPT: Opens-in-the-West-End marker
assert(
  isBWWRoundupContent('<html><body><h1>Review Roundup: SHOW Opens-in-the-West-End</h1></body></html>'),
  'Page with Opens-in-the-West-End: ACCEPTED'
);

// Should ACCEPT: long page with title tag containing Review Roundup
const longPage = '<html><head><title>Review Roundup: BECKY SHAW</title></head><body>' + 'x'.repeat(5000) + '</body></html>';
assert(
  isBWWRoundupContent(longPage),
  'Long page (>5000 chars) with Review Roundup in <title>: ACCEPTED'
);

// Should REJECT: short page with title tag (below 5000 char threshold)
assert(
  !isBWWRoundupContent('<html><head><title>Review Roundup</title></head><body>short</body></html>'),
  'Short page with Review Roundup in <title> only: REJECTED (below threshold)'
);

// ============================================================
// Summary
// ============================================================
console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n⚠ ${failed} test(s) FAILED — review the logic above`);
  process.exit(1);
} else {
  console.log(`\n✓ All ${passed} tests passed`);
}
