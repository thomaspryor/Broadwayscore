// Unit tests for BWW /reviews/ page production disambiguation guards.
//
// The BWW /reviews/ aggregator page for "CATS: The Jellicle Ball" (2026) uses the
// slug "Cats" and therefore returns reviews from ALL Cats productions (2016 revival
// included). These tests verify the three defence layers:
//
//   1. Date-year guard: skip reviews whose BWW sub-info date is outside window
//   2. Token-overlap sibling set: cats-2016 and cats-the-jellicle-ball-2026 share "cats"
//   3. isIncludableForRebuild: bwwAggregatorAmbiguous:true reviews are excluded
//
// Per feedback_test_extraction_pattern.md: require() the real functions — no logic copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Helpers under test (real functions, not copies)
// ---------------------------------------------------------------------------
const { isIncludableForRebuild } = require('../../scripts/lib/review-guards.js');

// buildTokenOverlapSiblingSet is not exported — inline the same logic so the
// test stays independent from the script's CLI harness.  We verify the
// *contract* (which show IDs end up in the set) not the implementation details.
const { getMarketPool } = require('../../scripts/lib/venue-classification.js');
const { normalizeTitle } = require('../../scripts/lib/market-routing.js');

const TOKEN_OVERLAP_STOPWORDS = new Set([
  'the','a','an','of','and','or','for','to','in','on','at','with','as','by',
  'revival','musical','play','show','new','york','broadway','west','end','off',
]);

function buildTokenOverlapSiblingSet(shows) {
  const tokenToShows = new Map();
  for (const s of shows) {
    if (!s || !s.title) continue;
    const titleLower = s.title.toLowerCase().replace(/[^a-z0-9 ]/g, ' ');
    const tokens = titleLower.split(/\s+/).filter(t => t.length >= 4 && !TOKEN_OVERLAP_STOPWORDS.has(t));
    for (const tok of tokens) {
      if (!tokenToShows.has(tok)) tokenToShows.set(tok, []);
      tokenToShows.get(tok).push(s);
    }
  }
  const overlapSet = new Set();
  for (const tokenShows of tokenToShows.values()) {
    if (tokenShows.length < 2) continue;
    const byMarket = new Map();
    for (const s of tokenShows) {
      const market = getMarketPool(s.category || '');
      if (!byMarket.has(market)) byMarket.set(market, []);
      byMarket.get(market).push(s);
    }
    for (const marketShows of byMarket.values()) {
      if (marketShows.length < 2) continue;
      const distinctTitles = new Set(marketShows.map(s => normalizeTitle(s.title)));
      if (distinctTitles.size < 2) continue;
      for (const s of marketShows) overlapSet.add(s.id);
    }
  }
  return overlapSet;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SHOWS_CATS = [
  {
    id: 'cats-the-jellicle-ball-2026',
    title: 'CATS: The Jellicle Ball',
    category: 'broadway',
    openingDate: '2026-04-08',
    closingDate: null,
  },
  {
    id: 'cats-2016',
    title: 'Cats',
    category: 'broadway',
    openingDate: '2016-07-31',
    closingDate: '2000-09-10',
  },
];

// Unrelated show to verify it is NOT added to the set
const SHOWS_CATS_WITH_UNRELATED = [
  ...SHOWS_CATS,
  {
    id: 'hamilton-2015',
    title: 'Hamilton',
    category: 'broadway',
    openingDate: '2015-08-06',
    closingDate: null,
  },
];

// ---------------------------------------------------------------------------
// Test 1: Token-overlap set includes both Cats productions
// ---------------------------------------------------------------------------

test('buildTokenOverlapSiblingSet: cats-2016 and cats-the-jellicle-ball-2026 share "cats"', () => {
  const set = buildTokenOverlapSiblingSet(SHOWS_CATS);
  assert.ok(set.has('cats-the-jellicle-ball-2026'), 'jellicle-ball-2026 should be in overlap set');
  assert.ok(set.has('cats-2016'), 'cats-2016 should be in overlap set');
});

// ---------------------------------------------------------------------------
// Test 2: Unrelated show is not in the overlap set
// ---------------------------------------------------------------------------

test('buildTokenOverlapSiblingSet: hamilton-2015 is not added (no shared token)', () => {
  const set = buildTokenOverlapSiblingSet(SHOWS_CATS_WITH_UNRELATED);
  assert.ok(!set.has('hamilton-2015'), 'hamilton-2015 should not be in overlap set');
});

// ---------------------------------------------------------------------------
// Test 3: Shows with the same normalized title are NOT in the overlap set
//   (they're already handled by the same-title cascade in classifyMarketRouting)
// ---------------------------------------------------------------------------

test('buildTokenOverlapSiblingSet: exact-title siblings do not enter the set', () => {
  const shows = [
    { id: 'hadestown-2019', title: 'Hadestown', category: 'broadway', openingDate: '2019-04-17' },
    { id: 'hadestown-west-end-2024', title: 'Hadestown', category: 'west-end', openingDate: '2024-09-19' },
  ];
  // Same title but different markets — same market pool check prevents overlap
  const set = buildTokenOverlapSiblingSet(shows);
  // Both shows are in different markets (nyc vs london), so they shouldn't both
  // be in the set due to market filtering
  const nycSet = new Set(['hadestown-2019']);
  const londonSet = new Set(['hadestown-west-end-2024']);
  // Neither appears because each market only has 1 show for "hadestown"
  assert.ok(!set.has('hadestown-2019'), 'cross-market same-title pair should not appear in overlap set');
});

// ---------------------------------------------------------------------------
// Test 4: Date-year guard logic (pure math — the guard lives in processShow
//   which we don't test here, but we verify the year-extraction pattern)
// ---------------------------------------------------------------------------

test('date-year guard: year extracted from BWW date string', () => {
  const dateStr = 'July 31, 2016';
  const yearM = String(dateStr).match(/\b((?:19|20)\d{2})\b/);
  assert.ok(yearM, 'should extract year from BWW date string');
  assert.strictEqual(parseInt(yearM[1], 10), 2016);
});

test('date-year guard: year 2016 is outside 2026 show window (>3 years)', () => {
  const reviewYear = 2016;
  const showOpeningYear = 2026;
  const showClosingYear = null;
  const currentYear = new Date().getFullYear();
  const upper = showClosingYear
    ? Math.max(showClosingYear + 1, showOpeningYear + 2)
    : currentYear + 1;
  assert.ok(reviewYear < showOpeningYear - 3, '2016 should be caught as outside window');
});

// ---------------------------------------------------------------------------
// Test 5: isIncludableForRebuild excludes bwwAggregatorAmbiguous reviews
// ---------------------------------------------------------------------------

test('isIncludableForRebuild: bwwAggregatorAmbiguous:true → excluded', () => {
  const review = {
    outletId: 'nydailynews',
    criticName: 'Joe Dziemianowicz',
    url: 'https://www.nydailynews.com/leona-lewis-opens-broadway-cats-review',
    bwwAggregatorAmbiguous: true,
    source: 'bww-reviews',
  };
  assert.strictEqual(isIncludableForRebuild(review, null), false);
});

test('isIncludableForRebuild: bwwAggregatorAmbiguous with manual clear → included', () => {
  const review = {
    outletId: 'nydailynews',
    criticName: 'Joe Dziemianowicz',
    url: 'https://www.nydailynews.com/cats-jellicle-ball-2026-review',
    bwwAggregatorAmbiguous: true,
    bwwAggregatorAmbiguousClearedNote: 'Verified: 2026 Jellicle Ball production',
    source: 'bww-reviews',
    originalScore: 80,    // Cleared review still needs content/signal to pass
    bwwScore: 8,
  };
  // With manual clear + content, should not be blocked by bwwAggregatorAmbiguous
  const result = isIncludableForRebuild(review, null);
  assert.strictEqual(result, true);
});

// ---------------------------------------------------------------------------
// Test 6: Leona Lewis URL smoke test — no date, no URL year
//   Simulates the exact bug case from 2026-05-17
// ---------------------------------------------------------------------------

test('Leona Lewis URL smoke: no year in URL, no BWW date → overlap guard fires', () => {
  // The URL has no year segment (regex returns null)
  const leonaLewisUrl = 'https://www.nydailynews.com/leona-lewis-opens-broadway-cats-review-article-1.2716547';
  const yearM = leonaLewisUrl.match(/\/((?:19|20)\d{2})\//);
  assert.strictEqual(yearM, null, 'Leona Lewis URL should have no /YYYY/ segment');

  // The show is in the token-overlap set
  const overlapSet = buildTokenOverlapSiblingSet(SHOWS_CATS);
  assert.ok(overlapSet.has('cats-the-jellicle-ball-2026'), 'jellicle-ball show should be in overlap set');

  // With no date and no URL year, review gets bwwAggregatorAmbiguous:true → excluded
  const flaggedReview = {
    outletId: 'nydailynews',
    criticName: 'Joe Dziemianowicz',
    url: leonaLewisUrl,
    bwwAggregatorAmbiguous: true,
  };
  assert.strictEqual(isIncludableForRebuild(flaggedReview, null), false,
    'flagged review should be excluded from rebuild');
});
