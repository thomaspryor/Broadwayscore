#!/usr/bin/env node
/**
 * Opening-Night Coverage Audit
 *
 * Checks recently-opened shows for missing T1/T2 reviews and optionally
 * sends Discord alerts + dispatches targeted collection workflows.
 *
 * Usage:
 *   node scripts/audit-opening-night-coverage.js                    # check last 3 days
 *   node scripts/audit-opening-night-coverage.js --days=7           # check last 7 days
 *   node scripts/audit-opening-night-coverage.js --show=SHOW_ID     # check specific show
 *   node scripts/audit-opening-night-coverage.js --dispatch         # auto-dispatch collection for gaps
 *   node scripts/audit-opening-night-coverage.js --alert            # send Discord alerts for gaps
 */

const fs = require('fs');
const path = require('path');
const { isLondonMarket } = require('./lib/venue-classification');

const DATA_DIR = path.join(__dirname, '..', 'data');

// Core T1 outlets that review virtually every major Broadway opening
const BROADWAY_CORE_T1 = ['nytimes', 'vulture', 'variety', 'hollywood-reporter', 'timeout'];
// Frequent T1 that often (but not always) review Broadway
const BROADWAY_FREQUENT_T1 = ['guardian', 'washpost', 'newyorker', 'wsj'];
// All Broadway T1
const BROADWAY_ALL_T1 = [...BROADWAY_CORE_T1, ...BROADWAY_FREQUENT_T1, 'ap', 'broadwaynews', 'latimes', 'financialtimes'];

// Off-Broadway expected outlets (subset — many T1s don't review OB)
const OB_EXPECTED = ['nytimes', 'vulture', 'timeout', 'nypost', 'theatermania', 'variety'];

// West End expected outlets
const WE_EXPECTED = ['times-uk', 'telegraph', 'standard', 'thestage', 'timeout-london', 'guardian', 'financialtimes'];

// Key T2 outlets for Broadway
const BROADWAY_KEY_T2 = ['nypost', 'theatermania', 'deadline', 'thewrap', 'ew', 'nydailynews', 'observer'];

// Opening-night floor: silent-failure detection for Broadway shows.
// FA (2026-04-19) landed 14/17 reviews because the BWW extractor silently
// dropped 3 outlets. The outlet-gap check didn't flag it because the missing
// outlets weren't all in core T1. A total-count floor catches this class.
// Window: 36-72h post-open. 36h lower bound chosen because late-drop T1s
// (WSJ, Observer) routinely publish 24-36h after opening; a 24h floor
// would false-alarm while the opening-night-poller is still ingesting.
// OB shows are exempt (floor constants are null for that market).
const BROADWAY_FLOOR_REVIEWS = 10;   // critic files captured
const BROADWAY_FLOOR_SCORED = 5;     // scored reviews
const WE_FLOOR_REVIEWS = 6;
const WE_FLOOR_SCORED = 3;
const FLOOR_WINDOW_MIN_HOURS = 36;
const FLOOR_WINDOW_MAX_HOURS = 72;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { days: 3, dispatch: false, alert: false, showId: null };
  for (const arg of args) {
    if (arg.startsWith('--days=')) opts.days = parseInt(arg.split('=')[1], 10);
    if (arg.startsWith('--show=')) opts.showId = arg.split('=')[1];
    if (arg === '--dispatch') opts.dispatch = true;
    if (arg === '--alert') opts.alert = true;
  }
  return opts;
}

function loadJSON(filename) {
  const filepath = path.join(DATA_DIR, filename);
  if (!fs.existsSync(filepath)) {
    console.error(`Missing data file: ${filepath}`);
    console.error('Run: npm run data:check');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(filepath, 'utf8'));
}

function getExpectedOutlets(category) {
  if (isLondonMarket(category)) return { core: WE_EXPECTED, frequent: [], keyT2: [] };
  if (category === 'off-broadway') return { core: OB_EXPECTED, frequent: [], keyT2: [] };
  // Broadway (default)
  return { core: BROADWAY_CORE_T1, frequent: BROADWAY_FREQUENT_T1, keyT2: BROADWAY_KEY_T2 };
}

async function main() {
  const opts = parseArgs();

  // Load data
  const showsData = loadJSON('shows.json');
  const shows = showsData.shows || showsData;
  const reviewsData = loadJSON('reviews.json');
  const reviews = reviewsData.reviews || reviewsData;
  const outletRegistry = loadJSON('outlet-registry.json');
  const outlets = outletRegistry.outlets || outletRegistry;

  // Find recently-opened shows
  const now = new Date();
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - opts.days);
  const cutoffStr = cutoff.toISOString().split('T')[0];

  let targetShows;
  if (opts.showId) {
    targetShows = shows.filter(s => s.id === opts.showId || s.slug === opts.showId);
    if (targetShows.length === 0) {
      console.error(`Show not found: ${opts.showId}`);
      process.exit(1);
    }
  } else {
    targetShows = shows.filter(s => {
      if (s.status !== 'open') return false;
      if (!s.openingDate) return false;
      return s.openingDate >= cutoffStr;
    });
  }

  if (targetShows.length === 0) {
    console.log(`No shows opened in the last ${opts.days} days.`);
    return;
  }

  console.log(`\n=== Opening-Night Coverage Audit ===`);
  console.log(`Checking ${targetShows.length} show(s) opened since ${cutoffStr}\n`);

  const gaps = [];
  const floorBreaches = [];

  for (const show of targetShows) {
    const showId = show.id || show.slug;
    const category = show.category || 'broadway';
    const showReviews = reviews.filter(r => r.showId === showId);
    const scoredReviews = showReviews.filter(r => r.assignedScore != null);

    // Get outlets that have reviews
    const coveredOutlets = new Set(showReviews.map(r => r.outletId).filter(Boolean));

    // Get expected outlets for this market
    const expected = getExpectedOutlets(category);

    const missingCore = expected.core.filter(o => !coveredOutlets.has(o));
    const missingFrequent = expected.frequent.filter(o => !coveredOutlets.has(o));
    const missingKeyT2 = expected.keyT2.filter(o => !coveredOutlets.has(o));

    // Get outlet display names
    const getName = (id) => outlets[id]?.displayName || id;

    // Determine severity
    const hasMajorGaps = missingCore.length >= 3;
    const hasSomeGaps = missingCore.length >= 1;

    // Floor check — silent-failure detection (catches broken extractors when
    // no specific outlet gap stands out). Only runs in 36-72h post-open window.
    // `-04:00` is EDT (summer Broadway openings). hoursSinceOpen reported in
    // Discord may be off ±1h in winter; the 36h floor gives enough slack.
    const openingMs = show.openingDate ? Date.parse(show.openingDate + 'T23:00:00-04:00') : null;
    if (show.openingDate && !Number.isFinite(openingMs)) {
      console.warn(`  ⚠ Unparseable openingDate for ${showId}: "${show.openingDate}" — floor check skipped`);
    }
    const hoursSinceOpen = Number.isFinite(openingMs) ? (now - openingMs) / (1000 * 60 * 60) : null;
    const inFloorWindow = hoursSinceOpen != null
      && hoursSinceOpen >= FLOOR_WINDOW_MIN_HOURS
      && hoursSinceOpen <= FLOOR_WINDOW_MAX_HOURS;
    // Positive-match by market so regional/off-off/typos don't silently
    // inherit the Broadway floor (10 reviews) and false-breach.
    const isBroadway = category === 'broadway';
    const floorReviews = isBroadway ? BROADWAY_FLOOR_REVIEWS : (isLondonMarket(category) ? WE_FLOOR_REVIEWS : null);
    const floorScored = isBroadway ? BROADWAY_FLOOR_SCORED : (isLondonMarket(category) ? WE_FLOOR_SCORED : null);
    const belowReviewFloor = floorReviews != null && showReviews.length < floorReviews;
    const belowScoredFloor = floorScored != null && scoredReviews.length < floorScored;
    const floorBreached = inFloorWindow && (belowReviewFloor || belowScoredFloor);

    console.log(`${show.title} (${showId})`);
    console.log(`  Category: ${category} | Opened: ${show.openingDate}`);
    console.log(`  Reviews: ${showReviews.length} total, ${scoredReviews.length} scored`);
    console.log(`  Covered outlets: ${[...coveredOutlets].sort().join(', ')}`);

    if (missingCore.length > 0) {
      console.log(`  MISSING core T1 (${missingCore.length}): ${missingCore.map(getName).join(', ')}`);
    }
    if (missingFrequent.length > 0) {
      console.log(`  Missing frequent T1 (${missingFrequent.length}): ${missingFrequent.map(getName).join(', ')}`);
    }
    if (missingKeyT2.length > 0) {
      console.log(`  Missing key T2 (${missingKeyT2.length}): ${missingKeyT2.map(getName).join(', ')}`);
    }

    if (floorBreached) {
      console.log(`  🚨 FLOOR BREACH: ${showReviews.length}/${floorReviews} reviews, ${scoredReviews.length}/${floorScored} scored at ${Math.round(hoursSinceOpen)}h post-open`);
    }

    if (floorBreached) {
      console.log(`  Status: FLOOR BREACH (silent extractor failure likely)`);
    } else if (missingCore.length === 0 && missingKeyT2.length <= 2) {
      console.log(`  Status: COMPLETE`);
    } else if (hasMajorGaps) {
      console.log(`  Status: MAJOR GAPS`);
    } else {
      console.log(`  Status: MINOR GAPS`);
    }
    console.log('');

    if (floorBreached) {
      floorBreaches.push({
        showId,
        title: show.title,
        category,
        openingDate: show.openingDate,
        hoursSinceOpen: Math.round(hoursSinceOpen),
        reviewCount: showReviews.length,
        scoredCount: scoredReviews.length,
        reviewFloor: floorReviews,
        scoredFloor: floorScored,
        belowReviewFloor,
        belowScoredFloor,
      });
    }

    if (hasSomeGaps) {
      gaps.push({
        showId,
        title: show.title,
        category,
        openingDate: show.openingDate,
        reviewCount: showReviews.length,
        scoredCount: scoredReviews.length,
        missingCore,
        missingFrequent,
        missingKeyT2,
        severity: hasMajorGaps ? 'major' : 'minor',
      });
    }
  }

  // Summary
  console.log(`\n=== Summary ===`);
  console.log(`Shows checked: ${targetShows.length}`);
  console.log(`Shows with gaps: ${gaps.length}`);
  const majorGaps = gaps.filter(g => g.severity === 'major');
  if (majorGaps.length > 0) {
    console.log(`Major gaps (3+ core T1 missing): ${majorGaps.length}`);
  }
  if (floorBreaches.length > 0) {
    console.log(`🚨 Floor breaches (silent extractor failure): ${floorBreaches.length}`);
  }

  // Discord alert
  if (opts.alert && (gaps.length > 0 || floorBreaches.length > 0)) {
    await sendDiscordAlert(gaps, floorBreaches);
  }

  // Auto-dispatch collection
  if (opts.dispatch && (gaps.length > 0 || floorBreaches.length > 0)) {
    const toDispatch = [
      ...gaps,
      ...floorBreaches.filter(b => !gaps.some(g => g.showId === b.showId)),
    ];
    await dispatchCollection(toDispatch);
  }

  // Machine-readable output
  const report = {
    timestamp: new Date().toISOString(),
    daysChecked: opts.days,
    showsChecked: targetShows.length,
    gaps,
    floorBreaches,
  };
  console.log('\n' + JSON.stringify(report, null, 2));

  // Exit with non-zero if major gaps or floor breaches found (useful for CI)
  if (majorGaps.length > 0 || floorBreaches.length > 0) {
    process.exit(1);
  }
}

async function sendDiscordAlert(gaps, floorBreaches = []) {
  try {
    const { sendAlert } = require('./lib/discord-notify');

    // Floor breaches take priority — they indicate a silent extractor failure.
    if (floorBreaches.length > 0) {
      const fields = floorBreaches.map(b => ({
        name: `🚨 ${b.title} (${b.openingDate})`,
        value: `**${b.reviewCount}/${b.reviewFloor} reviews, ${b.scoredCount}/${b.scoredFloor} scored** at ${b.hoursSinceOpen}h post-open\nLikely silent extractor failure (BWW RR sanitizer, DTLI, aggregator parse). Check latest gather-reviews logs.`,
      }));
      await sendAlert({
        title: '🚨 Opening-Night Review Floor Breach',
        description: `${floorBreaches.length} show(s) below minimum review count 24-72h post-open`,
        severity: 'error',
        fields: fields.slice(0, 10),
      });
      console.log('\nDiscord floor-breach alert sent.');
    }

    if (gaps.length > 0) {
      const fields = gaps.map(g => ({
        name: `${g.title} (${g.openingDate})`,
        value: `${g.reviewCount} reviews, ${g.scoredCount} scored\nMissing core T1: ${g.missingCore.join(', ') || 'none'}\nMissing key T2: ${g.missingKeyT2.join(', ') || 'none'}`,
      }));
      await sendAlert({
        title: 'Opening-Night Coverage Gaps',
        description: `${gaps.length} show(s) have missing T1/T2 reviews`,
        severity: gaps.some(g => g.severity === 'major') ? 'error' : 'warning',
        fields: fields.slice(0, 10),
      });
      console.log('\nDiscord gap alert sent.');
    }
  } catch (e) {
    console.error('Failed to send Discord alert:', e.message);
  }
}

async function dispatchCollection(gaps) {
  const { execSync } = require('child_process');
  for (const gap of gaps) {
    try {
      console.log(`\nDispatching gather-reviews for ${gap.showId}...`);
      execSync(
        `gh workflow run gather-reviews.yml -f shows="${gap.showId}" -f max_tier=2`,
        { stdio: 'inherit' }
      );

      console.log(`Dispatching collect-review-texts for ${gap.showId}...`);
      execSync(
        `gh workflow run "Collect Review Texts" -f show_filter="${gap.showId}" -f max_reviews=0 -f chain=true`,
        { stdio: 'inherit' }
      );
    } catch (e) {
      console.error(`Failed to dispatch for ${gap.showId}:`, e.message);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
