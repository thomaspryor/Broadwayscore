#!/usr/bin/env node
/**
 * discover-playbill-urls.js
 *
 * Discovers Playbill production page URLs for all open Broadway shows.
 * Two-step approach:
 *   1. Construct URL from show data (title-broadway-venue-year pattern)
 *   2. SERP fallback for shows where constructed URL returns 404
 *
 * Usage:
 *   node scripts/discover-playbill-urls.js               # All open Broadway shows
 *   node scripts/discover-playbill-urls.js --show=ID     # Single show
 *   node scripts/discover-playbill-urls.js --dry-run     # Preview only
 *   node scripts/discover-playbill-urls.js --force       # Re-discover even if URL exists
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const OUTPUT_PATH = path.join(__dirname, '..', 'data', 'playbill-urls.json');

const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const verbose = args.includes('--verbose') || args.includes('--dry-run');

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * HEAD request to check if a URL exists (follows redirects)
 */
function checkUrl(url) {
  return new Promise((resolve) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'HEAD',
      timeout: 10000,
    }, (res) => {
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
  });
}

/**
 * Slugify a string for Playbill URL pattern
 * Playbill uses lowercase-hyphenated with special char removal
 */
function playbillSlug(str) {
  return str
    .toLowerCase()
    .replace(/[''""\u2018\u2019\u201C\u201D]/g, '') // remove quotes/apostrophes
    .replace(/[&]/g, 'and')
    .replace(/[!?,.:;()]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Generate URL variants to try for a show
 */
function generateUrlVariants(show) {
  const title = playbillSlug(show.title);
  const venue = playbillSlug(show.venue || '');
  const year = (show.openingDate || show.id).match(/\d{4}/)?.[0] || '';

  const variants = [];

  // Standard pattern: title-broadway-venue-year
  if (venue && year) {
    variants.push(`https://playbill.com/production/${title}-broadway-${venue}-${year}`);
  }

  // Without "theatre"/"theater" suffix
  const venueNoTheatre = venue
    .replace(/-theatre$/, '')
    .replace(/-theater$/, '');
  if (venueNoTheatre !== venue && year) {
    variants.push(`https://playbill.com/production/${title}-broadway-${venueNoTheatre}-${year}`);
  }

  // Without venue (some older shows)
  if (year) {
    variants.push(`https://playbill.com/production/${title}-broadway-${year}`);
  }

  // Try prior year (opening year from ID may differ from Playbill's year)
  const idYear = show.id.match(/\d{4}/)?.[0];
  if (idYear && idYear !== year && venue) {
    variants.push(`https://playbill.com/production/${title}-broadway-${venue}-${idYear}`);
  }

  return variants;
}

/**
 * SERP fallback: search Google for the Playbill production page
 */
async function serpFallback(show) {
  try {
    const { serpQuery } = require('./lib/url-discovery');
    const query = `site:playbill.com "${show.title}" broadway production`;
    const results = await serpQuery(query, { nbResults: 5 });
    if (!results || results.length === 0) return null;

    for (const r of results) {
      if (r.url && r.url.includes('/production/')) {
        // Verify it's actually accessible
        const status = await checkUrl(r.url);
        if (status === 200) return r.url;
      }
    }
    return null;
  } catch (e) {
    if (verbose) console.log(`    SERP error: ${e.message}`);
    return null;
  }
}

async function main() {
  console.log('Discover Playbill URLs');
  console.log('='.repeat(40));
  if (dryRun) console.log('[DRY RUN]\n');

  // Load shows
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  let targetShows = showsData.shows.filter(s =>
    (s.status === 'open' || s.status === 'previews') && !s.category
  );

  if (showFilter) {
    targetShows = targetShows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (targetShows.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
  }

  console.log(`Target: ${targetShows.length} open Broadway shows\n`);

  // Load existing URLs
  let existing = { shows: {}, lastUpdated: '' };
  try {
    existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  } catch { /* first run */ }

  let found = 0, failed = 0, skipped = 0;

  for (const show of targetShows) {
    // Skip if already has a valid URL (unless --force)
    if (existing.shows[show.id] && !force) {
      if (verbose) console.log(`  [skip] ${show.id} — already has URL`);
      skipped++;
      continue;
    }

    if (verbose) console.log(`  ${show.title} (${show.id})`);

    // Step 1: Try constructed URLs
    const variants = generateUrlVariants(show);
    let foundUrl = null;

    for (const url of variants) {
      const status = await checkUrl(url);
      if (status === 200) {
        foundUrl = url;
        if (verbose) console.log(`    ✓ ${url}`);
        break;
      } else {
        if (verbose) console.log(`    ✗ ${status} ${url}`);
      }
      await sleep(500); // Rate limit HEAD requests
    }

    // Step 2: SERP fallback
    if (!foundUrl) {
      if (verbose) console.log(`    Trying SERP fallback...`);
      foundUrl = await serpFallback(show);
      if (foundUrl) {
        if (verbose) console.log(`    ✓ SERP: ${foundUrl}`);
      }
      await sleep(1000); // Rate limit SERP
    }

    if (foundUrl) {
      existing.shows[show.id] = foundUrl;
      found++;
    } else {
      console.log(`  ✗ FAILED: ${show.title} (${show.id}) — no Playbill URL found`);
      failed++;
    }

    await sleep(300); // Small delay between shows
  }

  existing.lastUpdated = new Date().toISOString();

  console.log(`\nResults: ${found} found, ${failed} failed, ${skipped} skipped (already have URL)`);
  console.log(`Total URLs in file: ${Object.keys(existing.shows).length}`);

  if (!dryRun && (found > 0)) {
    fs.writeFileSync(OUTPUT_PATH, JSON.stringify(existing, null, 2) + '\n');
    console.log(`Saved to ${OUTPUT_PATH}`);
  } else if (dryRun) {
    console.log('[DRY RUN] Would save to playbill-urls.json');
  }
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
