#!/usr/bin/env node
/**
 * Validate mobile-shows.json integrity
 *
 * Catches stale build artifacts reintroduced by worktree merges.
 * The visibility filter in generate-mobile-data.js excludes closed shows
 * without scored reviews. If too many appear, the file is stale.
 *
 * Checks:
 * 1. Closed shows without critic scores should be rare (threshold: 10)
 * 2. Show count should not drop dramatically vs shows.json expectations
 */

const fs = require('fs');
const path = require('path');

const MOBILE_PATH = path.join(__dirname, '..', 'public', 'data', 'mobile-shows.json');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

// Closed shows without scores should be filtered out by generate-mobile-data.js
// A handful may legitimately exist (recently closed, audience-only data)
// but 17+ appeared when a stale worktree version was merged
const MAX_CLOSED_WITHOUT_SCORE = 10;

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

  // Check 1: Closed shows without critic scores
  const closedNoScore = mobileShows.filter(s =>
    s.st === 'closed' && s.cs == null && (s.cr?.rc ?? 0) === 0
  );

  console.log(`\nClosed shows without scores or reviews: ${closedNoScore.length}`);

  if (closedNoScore.length > MAX_CLOSED_WITHOUT_SCORE) {
    console.error(`\n❌ FAIL: mobile-shows.json contains ${closedNoScore.length} closed shows without scores (max ${MAX_CLOSED_WITHOUT_SCORE})`);
    console.error('This usually means a stale build artifact was reintroduced by a worktree merge.');
    console.error('Fix: run "npm run prebuild" to regenerate, or let the next Vercel deploy rebuild it.\n');
    console.error('Shows that should not be in mobile-shows.json:');
    for (const s of closedNoScore.slice(0, 20)) {
      console.error(`  ${s.id} (${s.t}) — closed, no score, no reviews`);
    }
    if (closedNoScore.length > 20) {
      console.error(`  ... and ${closedNoScore.length - 20} more`);
    }
    process.exit(1);
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
