#!/usr/bin/env node
/**
 * Validate mobile-shows.json integrity
 *
 * Catches stale build artifacts reintroduced by worktree merges.
 * The visibility filter in generate-mobile-data.js excludes closed shows
 * without scored reviews. If too many appear, the file is stale.
 *
 * Checks:
 * 1. Cross-reference with reviews.json (when available in CI): closed shows
 *    in mobile-shows.json must have at least one scored review in reviews.json.
 *    Shows that don't have reviews shouldn't pass the visibility filter.
 * 2. Show count should not drop dramatically vs shows.json expectations
 */

const fs = require('fs');
const path = require('path');
const {
  MAX_CLOSED_WITHOUT_REVIEWS,
  buildShowsWithScores,
  findClosedShowsWithoutScores,
} = require('./lib/mobile-shows-validator.js');

const MOBILE_PATH = path.join(__dirname, '..', 'public', 'data', 'mobile-shows.json');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');

function main() {
  if (!fs.existsSync(MOBILE_PATH)) {
    console.log('⚠️  mobile-shows.json not found — skipping validation (pre-build)');
    process.exit(0);
  }

  const mobile = JSON.parse(fs.readFileSync(MOBILE_PATH, 'utf8'));
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));

  const mobileShows = mobile.shows || [];
  const allShows = showsData.shows || [];

  console.log(`mobile-shows.json: ${mobileShows.length} shows`);
  console.log(`shows.json: ${allShows.length} shows`);

  // Check 1: Cross-reference closed mobile shows against reviews.json
  // The visibility filter is: showsWithScores.has(show.id) || show.status !== 'closed'
  // So every closed show in mobile MUST have a scored review in reviews.json.
  if (fs.existsSync(REVIEWS_PATH)) {
    const reviewsRaw = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
    const reviews = reviewsRaw.reviews || reviewsRaw;
    const reviewArr = Array.isArray(reviews) ? reviews : Object.values(reviews);

    // Build the same showsWithScores set that generate-mobile-data.js uses
    const showsWithScores = buildShowsWithScores(reviewArr);

    const closedMobileShows = mobileShows.filter(s => s.st === 'closed');
    const closedWithoutReviews = findClosedShowsWithoutScores(mobileShows, showsWithScores);

    console.log(`\nClosed shows in mobile: ${closedMobileShows.length}`);
    console.log(`Closed shows WITHOUT scored reviews in reviews.json: ${closedWithoutReviews.length}`);

    if (closedWithoutReviews.length > MAX_CLOSED_WITHOUT_REVIEWS) {
      console.error(`\n❌ FAIL: mobile-shows.json contains ${closedWithoutReviews.length} closed shows that have no scored reviews (max ${MAX_CLOSED_WITHOUT_REVIEWS})`);
      console.error('These shows should not pass the visibility filter in generate-mobile-data.js.');
      console.error('This usually means a stale build artifact was reintroduced by a worktree merge.');
      console.error('Fix: run "npm run prebuild" to regenerate.\n');
      console.error('Stale entries:');
      for (const s of closedWithoutReviews.slice(0, 20)) {
        console.error(`  ${s.id} (${s.t}) — closed, not in showsWithScores`);
      }
      if (closedWithoutReviews.length > 20) {
        console.error(`  ... and ${closedWithoutReviews.length - 20} more`);
      }
      process.exit(1);
    }
  } else {
    console.log('\n⚠️  reviews.json not available — skipping cross-reference check');
  }

  // Check 2: Basic sanity — mobile should have at least 50% of non-closed shows
  const nonClosed = allShows.filter(s => s.status !== 'closed').length;
  if (mobileShows.length < nonClosed * 0.5) {
    console.error(`\n❌ FAIL: mobile-shows.json has ${mobileShows.length} shows but shows.json has ${nonClosed} non-closed shows`);
    console.error('mobile-shows.json appears truncated or corrupted.');
    process.exit(1);
  }

  console.log('\n✅ mobile-shows.json integrity check passed');
}

main();
