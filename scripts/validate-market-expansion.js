#!/usr/bin/env node
/**
 * Market expansion validation script.
 * Catches every class of issue found in the Feb 2026 WE/OB audit.
 * Run in CI and locally before launching any new market.
 *
 * Usage: node scripts/validate-market-expansion.js [--market west-end|off-broadway|all]
 */
const fs = require('fs');
const path = require('path');
// Pure decision logic lives in lib/market-expansion-validator.js (BRO-2507,
// unit-tested in tests/unit/validate-market-expansion.test.mjs). This file
// only does the I/O and the printing.
const {
  MARKETS,
  THRESHOLD_SOURCES,
  findSlugMarkerMisses,
  findIdMarkerMisses,
  findShowsWithoutSlug,
  findSlugCollisions,
  findStaleOpenShows,
  findMissingRequiredFields,
  findUntypedStubsNearPreviews,
  buildOutletDomainMaps,
  scanShowReviews,
  sourceHandlesMarket,
  browseSerializesCategory,
  seoMarkerFor,
  summarize,
} = require('./lib/market-expansion-validator');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SRC_DIR = path.join(__dirname, '..', 'src');

let errors = 0;
let warnings = 0;

function error(msg) { errors++; console.log(`❌ ERROR: ${msg}`); }
function warn(msg) { warnings++; console.log(`⚠️  WARNING: ${msg}`); }
function ok(msg) { console.log(`✅ ${msg}`); }
function info(msg) { console.log(`ℹ️  ${msg}`); }

// Parse args
const marketArg = process.argv.find(a => a.startsWith('--market='));
const targetMarket = marketArg ? marketArg.split('=')[1] : 'all';
if (targetMarket !== 'all' && !MARKETS.includes(targetMarket)) {
  // An unknown market filtered zero shows and printed a pass for nothing.
  console.error(`Unknown --market=${targetMarket}; expected one of: all, ${MARKETS.join(', ')}`);
  process.exit(2);
}

// Load data
const showsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shows.json'), 'utf8'));
const shows = showsData.shows;

let registryData;
try {
  registryData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'outlet-registry.json'), 'utf8'));
} catch (e) {
  registryData = null;
  warn('Could not load outlet-registry.json — skipping outlet checks');
}

const marketsToCheck = targetMarket === 'all' ? MARKETS : [targetMarket];

console.log('');
console.log('=== Market Expansion Validation ===');
console.log(`Markets: ${marketsToCheck.join(', ')}`);
console.log('');

// ===== 1. SLUG CHECKS =====
console.log('--- Slug Checks ---');

// Every show needs a slug (it is the URL); reported before the market loops so
// a slug-less show fails the gate with a clear message.
for (const show of findShowsWithoutSlug(shows)) {
  error(`show ${show.id} has no slug`);
}

for (const market of marketsToCheck) {
  const marketShows = shows.filter(s => s.category === market);
  const slugMarker = market; // 'west-end' or 'off-broadway'

  // Every show with this category should have the marker in its slug
  // (off-west-end accepts legacy "west-end" slugs; see the lib).
  const missing = findSlugMarkerMisses(marketShows, market);
  if (missing.length > 0) {
    warn(`${missing.length} ${market} shows missing "${slugMarker}" in slug: ${missing.slice(0, 5).map(s => s.slug).join(', ')}${missing.length > 5 ? '...' : ''}`);
  } else {
    ok(`All ${marketShows.length} ${market} slugs contain "${slugMarker}"`);
  }

  // ID pattern: should include market marker
  const badIds = findIdMarkerMisses(marketShows, market);
  if (badIds.length > 0) {
    warn(`${badIds.length} ${market} show IDs missing "${slugMarker}": ${badIds.slice(0, 3).map(s => s.id).join(', ')}${badIds.length > 3 ? '...' : ''}`);
  } else {
    ok(`All ${market} show IDs contain "${slugMarker}"`);
  }
}

// Only flag if the EXACT same slug appears in multiple shows (not just similar base)
const realCollisions = findSlugCollisions(shows);
if (realCollisions.length > 0) {
  for (const [slug, entries] of realCollisions) {
    error(`Slug collision: "${slug}" used by ${entries.map(e => `${e.id} (${e.category || 'broadway'})`).join(', ')}`);
  }
} else {
  ok('No exact slug collisions across markets');
}

// ===== 2. SCORING THRESHOLD CHECKS =====
console.log('\n--- Scoring Threshold Checks ---');

// Check that score-buckets.ts handles each market
try {
  const scoreBucketsContent = THRESHOLD_SOURCES.map((f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')).join('\n');
  for (const market of marketsToCheck) {
    if (sourceHandlesMarket(scoreBucketsContent, market)) {
      ok(`score-buckets.ts handles '${market}'`);
    } else {
      error(`score-buckets.ts does NOT handle '${market}' — hasEnoughReviews() will use wrong threshold`);
    }
  }
} catch (e) {
  warn('Could not read score-buckets.ts');
}

// Check ScoreBadge handles each market (directly or via market-utils.ts)
try {
  const scoreBadgeContent = fs.readFileSync(path.join(SRC_DIR, 'components', 'show-cards', 'ScoreBadge.tsx'), 'utf8');
  // ScoreBadge delegates to getMarketMinReviews() from market-utils.ts — check both files
  let marketUtilsContent = '';
  try {
    marketUtilsContent = fs.readFileSync(path.join(SRC_DIR, 'lib', 'market-utils.ts'), 'utf8');
  } catch (e) { /* optional */ }
  const combinedContent = scoreBadgeContent + marketUtilsContent;
  for (const market of marketsToCheck) {
    if (sourceHandlesMarket(combinedContent, market)) {
      ok(`ScoreBadge handles '${market}' (via market-utils)`);
    } else {
      error(`ScoreBadge does NOT handle '${market}' — score display will use wrong threshold`);
    }
  }
} catch (e) {
  warn('Could not read ScoreBadge.tsx');
}

// ===== 3. SHOW DATA CHECKS =====
console.log('\n--- Show Data Checks ---');

for (const market of marketsToCheck) {
  const marketShows = shows.filter(s => s.category === market);

  // No "open" shows with closingDate older than the auto-close grace window
  // (CLOSING_GRACE_DAYS in the lib: update-show-status.js's 7 days + 1).
  const badOpen = findStaleOpenShows(marketShows);
  if (badOpen.length > 0) {
    for (const s of badOpen) {
      error(`${market} show "${s.title}" (${s.id}) status is "open" but closingDate ${s.closingDate} is in the past`);
    }
  } else {
    ok(`No ${market} shows with open status and past closingDate`);
  }

  // Required fields (type exempt while announced or an upcoming venue-page stub; see the lib).
  const missingFields = findMissingRequiredFields(marketShows);
  if (missingFields.length > 0) {
    const ids = missingFields.slice(0, 10).map((s) => `${s.id || s.title}${s.type ? '' : ` (${s.status || 'no status'}, no type)`}`).join(', ');
    error(`${missingFields.length} ${market} shows missing required fields (title/category/status, or a type once past the announced / upcoming venue-stub stage): ${ids}${missingFields.length > 10 ? ', ...' : ''}`);
  } else {
    ok(`All ${market} shows have required fields`);
  }
  // An untyped venue stub fails the check above the day its previews start; name it while there is time.
  for (const s of findUntypedStubsNearPreviews(marketShows)) {
    warn(`${market} stub ${s.id} has no type and previews ${s.previewsStartDate}; set "type" in shows.json before then or this check fails`);
    if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Untyped show stub::${s.id} previews ${s.previewsStartDate} with no type; set it in shows.json before then`);
  }
}

// ===== 4. REVIEW DATA CHECKS =====
console.log('\n--- Review Data Checks ---');

const reviewTextsDir = path.join(DATA_DIR, 'review-texts');
const hasReviewTexts = fs.existsSync(reviewTextsDir);

if (hasReviewTexts && registryData) {
  const { outletDomains, outletDomainAliases } = buildOutletDomainMaps(registryData);

  for (const market of marketsToCheck) {
    const marketShows = shows.filter(s => s.category === market);
    let urlMismatches = 0;
    let duplicatePairs = 0;
    let earlyReviews = 0;
    let totalReviews = 0;

    for (const show of marketShows) {
      const showDir = path.join(reviewTextsDir, show.id);
      if (!fs.existsSync(showDir)) continue;

      const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
      const reviews = [];
      for (const file of files) {
        try {
          reviews.push({ file, review: JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8')) });
        } catch (e) {
          // skip malformed files
        }
      }

      const stats = scanShowReviews(show, reviews, outletDomains, outletDomainAliases);
      totalReviews += stats.totalReviews;
      urlMismatches += stats.urlMismatches;
      duplicatePairs += stats.duplicatePairs;
      earlyReviews += stats.earlyReviews;
    }

    info(`${market}: ${totalReviews} active reviews scanned`);
    if (urlMismatches > 0) warn(`${market}: ${urlMismatches} URL/outlet domain mismatches`);
    else ok(`${market}: No URL/outlet domain mismatches`);
    if (duplicatePairs > 0) warn(`${market}: ${duplicatePairs} duplicate show+outlet pairs`);
    else ok(`${market}: No duplicate show+outlet pairs`);
    if (earlyReviews > 0) warn(`${market}: ${earlyReviews} reviews published >1 year before show opening`);
    else ok(`${market}: No suspiciously early reviews`);
  }
} else {
  info('Skipping review data checks (review-texts not available or outlet-registry missing)');
}

// ===== 5. DISPLAY CHECKS (grep-based) =====
console.log('\n--- Display Checks ---');

// Browse page category serialization
try {
  const browseContent = fs.readFileSync(path.join(SRC_DIR, 'app', 'browse', '[slug]', 'page.tsx'), 'utf8');
  const hasCategorySerialization = browseSerializesCategory(browseContent);
  if (hasCategorySerialization) {
    ok('Browse page serializes category field');
  } else {
    error('Browse page does NOT serialize category — market thresholds will fail on browse pages');
  }
} catch (e) {
  warn('Could not read browse page');
}

// tier1And2Count passed to ScoreBadge (may be in BrowseListClient or ShowListCard after refactors)
try {
  const filesToCheck = ['components/BrowseListClient.tsx', 'components/show-cards/ShowListCard.tsx'];
  const found = filesToCheck.some(f => {
    try {
      return fs.readFileSync(path.join(SRC_DIR, f), 'utf8').includes('tier1And2Count');
    } catch { return false; }
  });
  if (found) {
    ok('tier1And2Count passed to ScoreBadge in browse card pipeline');
  } else {
    error('tier1And2Count missing from both BrowseListClient and ShowListCard — T3-only guard disabled');
  }
} catch (e) {
  warn('Could not check tier1And2Count in browse card files');
}

// ===== 6. COPY CHECKS =====
console.log('\n--- Copy Checks ---');

// SEO organizer name
try {
  const seoContent = fs.readFileSync(path.join(SRC_DIR, 'lib', 'seo.ts'), 'utf8');
  for (const market of marketsToCheck) {
    const marker = seoMarkerFor(market);
    if (seoContent.includes(marker)) {
      ok(`seo.ts references "${marker}"`);
    } else {
      warn(`seo.ts does not reference "${marker}" — SEO schemas may use wrong site name`);
    }
  }
} catch (e) {
  warn('Could not read seo.ts');
}

// Show page market-aware text
try {
  const showPageContent = fs.readFileSync(path.join(SRC_DIR, 'app', 'show', '[slug]', 'page.tsx'), 'utf8');
  if (showPageContent.includes('West End Scorecard') && showPageContent.includes('Off-Broadway Scorecard')) {
    ok('Show page has market-aware copy for WE and OB');
  } else {
    warn('Show page may have hardcoded "Broadway Scorecard" text');
  }

  // Check outlet examples in How This Score Works
  if (showPageContent.includes('The Guardian') || showPageContent.includes('guardian')) {
    ok('Show page has WE-specific outlet examples');
  } else if (marketsToCheck.includes('west-end')) {
    warn('Show page missing WE-specific outlet examples in "How This Score Works"');
  }
} catch (e) {
  warn('Could not read show page');
}

// ===== SUMMARY =====
console.log('\n============================================================');
console.log('MARKET EXPANSION VALIDATION RESULT');
console.log('============================================================\n');

const verdict = summarize(errors, warnings);
if (verdict.status === 'failed') {
  console.log(`❌ FAILED: ${errors} error(s), ${warnings} warning(s)`);
} else if (verdict.status === 'warnings') {
  console.log(`⚠️  PASSED with ${warnings} warning(s)`);
} else {
  console.log('✅ ALL CHECKS PASSED');
}
process.exit(verdict.exitCode);
