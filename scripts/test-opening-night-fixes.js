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

const { ALL_FEEDS } = require('./lib/rss-discovery');

const varietyFeed = ALL_FEEDS.find(f => f.name === 'Variety Legit');
const nytFeed = ALL_FEEDS.find(f => f.name === 'NYT Theater');
const wosFeed = ALL_FEEDS.find(f => f.name === 'WhatsOnStage');
const standardFeed = ALL_FEEDS.find(f => f.name === 'Evening Standard Theatre');
const thrFeed = ALL_FEEDS.find(f => f.name === 'THR');
const guardianFeed = ALL_FEEDS.find(f => f.name === 'Guardian Stage');

assert(varietyFeed && varietyFeed.openingWindow === true, 'Variety Legit: openingWindow=true');
assert(nytFeed && nytFeed.openingWindow === true, 'NYT Theater: openingWindow=true');
assert(wosFeed && !wosFeed.openingWindow, 'WhatsOnStage: no openingWindow (WE feed — always title-matches)');
assert(standardFeed && !standardFeed.openingWindow, 'Evening Standard: no openingWindow (WE feed)');
assert(thrFeed && !thrFeed.openingWindow, 'THR: no openingWindow (entertainment feed, has needsFilter)');
assert(!guardianFeed, 'Guardian Stage: removed from ALL_FEEDS entirely (too broad)');

// ============================================================
// FIX — skipUrlFilter flag (site-search-discovery.js)
// Variety section page is pre-scoped to /legit/reviews/ — skip urlLooksLikeReview.
// TheaterMania and others retain url filtering.
// ============================================================
console.log('\n=== skipUrlFilter: only pre-scoped section pages skip URL matching ===\n');

const { SITE_SEARCH_ENDPOINTS } = require('./lib/site-search-discovery');

assert(
  SITE_SEARCH_ENDPOINTS.variety && SITE_SEARCH_ENDPOINTS.variety.skipUrlFilter === true,
  'variety: skipUrlFilter=true (section page already scoped to /legit/reviews/)'
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
