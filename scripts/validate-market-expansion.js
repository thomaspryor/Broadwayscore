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
const { isLondonMarket } = require('./lib/venue-classification');

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

const markets = ['west-end', 'off-west-end', 'off-broadway'];
const marketsToCheck = targetMarket === 'all' ? markets : [targetMarket];

console.log('');
console.log('=== Market Expansion Validation ===');
console.log(`Markets: ${marketsToCheck.join(', ')}`);
console.log('');

// ===== 1. SLUG CHECKS =====
console.log('--- Slug Checks ---');

for (const market of marketsToCheck) {
  const marketShows = shows.filter(s => s.category === market);
  const slugMarker = market; // 'west-end' or 'off-broadway'

  // Every show with this category should have the marker in its slug.
  // For off-west-end: many shows were originally categorized as west-end and retain
  // legacy slugs with "west-end" (not "off-west-end"). Renaming would break URLs/SEO,
  // so accept "west-end" in slugs for off-west-end shows as valid (it's a superset).
  const missing = marketShows.filter(s => {
    if (market === 'off-west-end') return !s.slug.includes('west-end');
    return !s.slug.includes(slugMarker);
  });
  if (missing.length > 0) {
    warn(`${missing.length} ${market} shows missing "${slugMarker}" in slug: ${missing.slice(0, 5).map(s => s.slug).join(', ')}${missing.length > 5 ? '...' : ''}`);
  } else {
    ok(`All ${marketShows.length} ${market} slugs contain "${slugMarker}"`);
  }

  // ID pattern: should include market marker
  const badIds = marketShows.filter(s => !s.id.includes(slugMarker));
  if (badIds.length > 0) {
    warn(`${badIds.length} ${market} show IDs missing "${slugMarker}": ${badIds.slice(0, 3).map(s => s.id).join(', ')}${badIds.length > 3 ? '...' : ''}`);
  } else {
    ok(`All ${market} show IDs contain "${slugMarker}"`);
  }
}

// Cross-market slug collision check
const slugToMarkets = {};
for (const show of shows) {
  const base = show.slug.replace(/-west-end$/, '').replace(/-off-broadway$/, '').replace(/-\d{4}$/, '');
  if (!slugToMarkets[base]) slugToMarkets[base] = [];
  slugToMarkets[base].push({ slug: show.slug, market: show.category || 'broadway', id: show.id });
}
const crossCollisions = Object.entries(slugToMarkets)
  .filter(([_, entries]) => {
    const uniqueMarkets = new Set(entries.map(e => e.market));
    return uniqueMarkets.size > 1 && entries.length > 1;
  });
// Only flag if the EXACT same slug appears in multiple markets (not just similar base)
const exactDupSlugs = {};
for (const show of shows) {
  if (!exactDupSlugs[show.slug]) exactDupSlugs[show.slug] = [];
  exactDupSlugs[show.slug].push(show);
}
const realCollisions = Object.entries(exactDupSlugs).filter(([_, entries]) => entries.length > 1);
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
  const scoreBucketsContent = fs.readFileSync(path.join(SRC_DIR, 'config', 'score-buckets.ts'), 'utf8');
  for (const market of marketsToCheck) {
    if (scoreBucketsContent.includes(`'${market}'`)) {
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
    if (combinedContent.includes(`'${market}'`)) {
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

  // No "open" shows with closingDate more than 1 day in the past
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const badOpen = marketShows.filter(s =>
    s.status === 'open' && s.closingDate && new Date(s.closingDate) < yesterday
  );
  if (badOpen.length > 0) {
    for (const s of badOpen) {
      error(`${market} show "${s.title}" (${s.id}) status is "open" but closingDate ${s.closingDate} is in the past`);
    }
  } else {
    ok(`No ${market} shows with open status and past closingDate`);
  }

  // Required fields
  const missingFields = marketShows.filter(s => !s.title || !s.category || !s.status || !s.type);
  if (missingFields.length > 0) {
    error(`${missingFields.length} ${market} shows missing required fields (title/category/status/type)`);
  } else {
    ok(`All ${market} shows have required fields`);
  }
}

// ===== 4. REVIEW DATA CHECKS =====
console.log('\n--- Review Data Checks ---');

const reviewTextsDir = path.join(DATA_DIR, 'review-texts');
const hasReviewTexts = fs.existsSync(reviewTextsDir);

if (hasReviewTexts && registryData) {
  const outlets = registryData.outlets || {};
  const outletDomains = {};
  const outletDomainAliases = {};
  for (const [id, outlet] of Object.entries(outlets)) {
    if (outlet.domain) outletDomains[id] = outlet.domain.toLowerCase();
    if (outlet.domainAliases) outletDomainAliases[id] = outlet.domainAliases.map(d => d.toLowerCase());
  }

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
      const byOutlet = {};

      for (const file of files) {
        try {
          const review = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
          if (review.wrongProduction || review.wrongShow || review.duplicateOf || review.wrongUrl) continue;
          totalReviews++;

          const outletId = review.outletId || file.split('--')[0];

          // URL/domain check
          if (review.url && outletDomains[outletId]) {
            let urlDomain;
            try { urlDomain = new URL(review.url).hostname.replace(/^www\./, '').toLowerCase(); } catch(e) { continue; }
            const expected = outletDomains[outletId].replace(/^www\./, '');
            const aliases = outletDomainAliases[outletId] || [];
            // Exact domain or subdomain match (e.g. m.nytimes.com matches nytimes.com)
            const domainOrSub = (a, b) => a === b || a.endsWith('.' + b) || b.endsWith('.' + a);
            const domainMatches = domainOrSub(urlDomain, expected)
              || aliases.some(a => domainOrSub(urlDomain, a.replace(/^www\./, '')));
            if (!domainMatches) {
              urlMismatches++;
            }
          }

          // Outlet dedup tracking
          if (!byOutlet[outletId]) byOutlet[outletId] = [];
          byOutlet[outletId].push(file);

          // Early date check (>1 year before opening)
          if (review.publishDate && show.openingDate) {
            const pub = new Date(review.publishDate);
            const open = new Date(show.openingDate);
            const daysBefore = (open - pub) / (1000 * 60 * 60 * 24);
            if (daysBefore > 365) earlyReviews++;
          }
        } catch (e) {
          // skip malformed files
        }
      }

      // Count duplicate outlet pairs
      for (const [outlet, files] of Object.entries(byOutlet)) {
        if (files.length > 1) duplicatePairs++;
      }
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
  const hasCategorySerialization = browseContent.includes('category:') && browseContent.includes('show.category');
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
    const marker = market === 'west-end' ? 'West End Scorecard' : market === 'off-west-end' ? 'Off-West End Scorecard' : 'Off-Broadway Scorecard';
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

if (errors > 0) {
  console.log(`❌ FAILED: ${errors} error(s), ${warnings} warning(s)`);
  process.exit(1);
} else if (warnings > 0) {
  console.log(`⚠️  PASSED with ${warnings} warning(s)`);
  process.exit(0);
} else {
  console.log('✅ ALL CHECKS PASSED');
  process.exit(0);
}
