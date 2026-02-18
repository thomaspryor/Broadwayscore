#!/usr/bin/env node
/**
 * Discover DTLI show slugs from WordPress sitemaps and match to our shows.
 *
 * DTLI uses unpredictable slugs (e.g. "frozen-3", "company-2", "cabaret-at-the-kit-kat-club")
 * that can't be guessed algorithmically. This script scrapes all 13 sitemaps to build
 * a persistent slug map in data/dtli-slug-map.json.
 *
 * Usage:
 *   node scripts/discover-dtli-slugs.js              # Full discovery
 *   node scripts/discover-dtli-slugs.js --dry-run    # Print matches without writing
 *   node scripts/discover-dtli-slugs.js --verify     # Check mapped URLs still work
 *   node scripts/discover-dtli-slugs.js --force      # Re-discover even for mapped shows
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const SLUG_MAP_PATH = path.join(__dirname, '..', 'data', 'dtli-slug-map.json');
const SITEMAP_INDEX_URL = 'https://didtheylikeit.com/sitemap_index.xml';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const VERIFY = args.includes('--verify');
const FORCE = args.includes('--force');

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 20000 }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirectUrl = res.headers.location;
        if (redirectUrl) {
          httpGet(redirectUrl.startsWith('http') ? redirectUrl : `https://didtheylikeit.com${redirectUrl}`)
            .then(resolve).catch(reject);
          return;
        }
      }
      if (res.statusCode !== 200) {
        resolve({ ok: false, status: res.statusCode });
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ ok: true, body: data }));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Load shows from shows.json
 */
function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return data.shows || data;
}

/**
 * Load existing slug map
 */
function loadSlugMap() {
  try {
    return JSON.parse(fs.readFileSync(SLUG_MAP_PATH, 'utf8'));
  } catch {
    return { _meta: { lastUpdated: null, source: 'DTLI WordPress sitemaps', totalDtliSlugs: 0, matchedShows: 0, unmatchedSlugs: [] }, shows: {} };
  }
}

/**
 * Fetch sitemap index to find all show sitemap URLs
 */
async function fetchSitemapUrls() {
  console.log('Fetching sitemap index...');
  const result = await httpGet(SITEMAP_INDEX_URL);
  if (!result.ok) {
    console.error(`Failed to fetch sitemap index: ${result.error || result.status}`);
    return [];
  }
  const urls = [];
  const regex = /<loc>(https:\/\/didtheylikeit\.com\/shows-sitemap\d+\.xml)<\/loc>/g;
  let match;
  while ((match = regex.exec(result.body)) !== null) {
    urls.push(match[1]);
  }
  console.log(`  Found ${urls.length} show sitemaps`);
  return urls;
}

/**
 * Extract show-level slugs from a sitemap XML
 * Show pages match /shows/{slug}/ but NOT /shows/{slug}/{review-slug}/
 */
function extractShowSlugs(xml) {
  const slugs = [];
  const regex = /<loc>https:\/\/didtheylikeit\.com\/shows\/([^/]+)\/<\/loc>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const slug = match[1];
    // Skip the /shows/ index page itself (empty slug or "all")
    if (slug && slug !== 'all') {
      slugs.push(slug);
    }
  }
  return [...new Set(slugs)]; // deduplicate
}

/**
 * Build lookup indices for matching DTLI slugs to our shows
 */
function buildMatchIndices(shows) {
  const indices = {
    bySlugBase: new Map(),      // show slug without year → [shows]
    byTitleSlug: new Map(),     // slugified title → [shows]
    byTitleNoArticle: new Map() // title without leading article → [shows]
  };

  for (const show of shows) {
    // slug base: "hamilton-2015" → "hamilton"
    const slugBase = show.id.replace(/-\d{4}$/, '');
    if (!indices.bySlugBase.has(slugBase)) indices.bySlugBase.set(slugBase, []);
    indices.bySlugBase.get(slugBase).push(show);

    // title slug: "The Book of Mormon" → "the-book-of-mormon"
    const titleSlug = slugify(show.title);
    if (!indices.byTitleSlug.has(titleSlug)) indices.byTitleSlug.set(titleSlug, []);
    indices.byTitleSlug.get(titleSlug).push(show);

    // title without article: "The Lion King" → "lion-king"
    const titleNoArticle = slugify(show.title.replace(/^(the|a|an)\s+/i, ''));
    if (!indices.byTitleNoArticle.has(titleNoArticle)) indices.byTitleNoArticle.set(titleNoArticle, []);
    indices.byTitleNoArticle.get(titleNoArticle).push(show);
  }

  return indices;
}

/**
 * Strip common DTLI suffixes to get the base show name
 */
function stripDtliSuffixes(slug) {
  return slug
    .replace(/-bway$/, '')
    .replace(/-broadway$/, '')
    .replace(/-review$/, '')
    .replace(/-reviews$/, '')
    .replace(/-the-musical$/, '')
    .replace(/-revival$/, '');
}

/**
 * Try to match a DTLI slug to one of our shows
 * Returns { showId, confidence } or null
 */
function matchDtliSlug(dtliSlug, indices) {
  // Strip numeric suffixes like -2, -3 (used for revivals)
  const withoutNumSuffix = dtliSlug.replace(/-\d+$/, '');
  const stripped = stripDtliSuffixes(dtliSlug);
  const strippedNoNum = stripDtliSuffixes(withoutNumSuffix);

  // Try direct matches first (most reliable)
  const candidates = [dtliSlug, withoutNumSuffix, stripped, strippedNoNum];

  for (const candidate of candidates) {
    // Match by slug base
    const bySlug = indices.bySlugBase.get(candidate);
    if (bySlug && bySlug.length === 1) {
      return { showId: bySlug[0].id, confidence: 'high', matchType: 'slug-base' };
    }

    // Match by title slug
    const byTitle = indices.byTitleSlug.get(candidate);
    if (byTitle && byTitle.length === 1) {
      return { showId: byTitle[0].id, confidence: 'high', matchType: 'title-slug' };
    }

    // Match by title without article
    const byNoArticle = indices.byTitleNoArticle.get(candidate);
    if (byNoArticle && byNoArticle.length === 1) {
      return { showId: byNoArticle[0].id, confidence: 'high', matchType: 'title-no-article' };
    }
  }

  // For ambiguous matches (multiple shows with same title), pick the most recent
  for (const candidate of candidates) {
    const bySlug = indices.bySlugBase.get(candidate);
    if (bySlug && bySlug.length > 1) {
      // DTLI numeric suffix correlates with production order
      // -2 = second production, -3 = third, etc.
      const numSuffix = dtliSlug.match(/-(\d+)$/);
      if (numSuffix) {
        const n = parseInt(numSuffix[1]);
        // Sort by opening date ascending, pick nth
        const sorted = [...bySlug].sort((a, b) => {
          const dateA = a.openingDate || a.previewsStartDate || '9999';
          const dateB = b.openingDate || b.previewsStartDate || '9999';
          return dateA.localeCompare(dateB);
        });
        if (n <= sorted.length) {
          return { showId: sorted[n - 1].id, confidence: 'medium', matchType: 'numeric-suffix-order' };
        }
      }

      // No numeric suffix — pick most recent (most likely what DTLI's base slug refers to)
      const sorted = [...bySlug].sort((a, b) => {
        const dateA = a.openingDate || a.previewsStartDate || '0000';
        const dateB = b.openingDate || b.previewsStartDate || '0000';
        return dateB.localeCompare(dateA);
      });
      return { showId: sorted[0].id, confidence: 'low', matchType: 'most-recent-ambiguous' };
    }

    const byTitle = indices.byTitleSlug.get(candidate);
    if (byTitle && byTitle.length > 1) {
      const numSuffix = dtliSlug.match(/-(\d+)$/);
      if (numSuffix) {
        const n = parseInt(numSuffix[1]);
        const sorted = [...byTitle].sort((a, b) => {
          const dateA = a.openingDate || a.previewsStartDate || '9999';
          const dateB = b.openingDate || b.previewsStartDate || '9999';
          return dateA.localeCompare(dateB);
        });
        if (n <= sorted.length) {
          return { showId: sorted[n - 1].id, confidence: 'medium', matchType: 'numeric-suffix-title-order' };
        }
      }
      const sorted = [...byTitle].sort((a, b) => {
        const dateA = a.openingDate || a.previewsStartDate || '0000';
        const dateB = b.openingDate || b.previewsStartDate || '0000';
        return dateB.localeCompare(dateA);
      });
      return { showId: sorted[0].id, confidence: 'low', matchType: 'most-recent-title-ambiguous' };
    }

    const byNoArticle = indices.byTitleNoArticle.get(candidate);
    if (byNoArticle && byNoArticle.length > 1) {
      const sorted = [...byNoArticle].sort((a, b) => {
        const dateA = a.openingDate || a.previewsStartDate || '0000';
        const dateB = b.openingDate || b.previewsStartDate || '0000';
        return dateB.localeCompare(dateA);
      });
      return { showId: sorted[0].id, confidence: 'low', matchType: 'most-recent-no-article-ambiguous' };
    }
  }

  return null;
}

/**
 * Verify that mapped URLs still return 200
 */
async function verifyMappedUrls(slugMap) {
  const entries = Object.entries(slugMap.shows);
  console.log(`\nVerifying ${entries.length} mapped URLs...`);
  let working = 0;
  let broken = 0;
  const brokenList = [];

  for (const [showId, dtliSlug] of entries) {
    const url = `https://didtheylikeit.com/shows/${dtliSlug}/`;
    const result = await httpGet(url);
    if (result.ok) {
      working++;
    } else {
      broken++;
      brokenList.push({ showId, dtliSlug, status: result.status || result.error });
    }
    if ((working + broken) % 50 === 0) {
      console.log(`  Checked ${working + broken}/${entries.length}...`);
    }
    await sleep(200); // Be gentle
  }

  console.log(`\n  Working: ${working}, Broken: ${broken}`);
  if (brokenList.length > 0) {
    console.log('  Broken URLs:');
    for (const b of brokenList) {
      console.log(`    ${b.showId} → ${b.dtliSlug} (${b.status})`);
    }
  }
}

async function main() {
  const shows = loadShows();
  const slugMap = loadSlugMap();
  const indices = buildMatchIndices(shows);

  console.log(`Loaded ${shows.length} shows, ${Object.keys(slugMap.shows).length} existing mappings`);

  if (VERIFY) {
    await verifyMappedUrls(slugMap);
    return;
  }

  // Step 1: Fetch all sitemaps and extract show slugs
  const sitemapUrls = await fetchSitemapUrls();
  if (sitemapUrls.length === 0) {
    console.error('No sitemaps found!');
    process.exit(1);
  }

  const allDtliSlugs = [];
  for (const sitemapUrl of sitemapUrls) {
    const result = await httpGet(sitemapUrl);
    if (!result.ok) {
      console.warn(`  Failed to fetch ${sitemapUrl}`);
      continue;
    }
    const slugs = extractShowSlugs(result.body);
    allDtliSlugs.push(...slugs);
    console.log(`  ${path.basename(sitemapUrl)}: ${slugs.length} show pages`);
    await sleep(500);
  }

  const uniqueSlugs = [...new Set(allDtliSlugs)];
  console.log(`\nTotal unique DTLI show slugs: ${uniqueSlugs.length}`);

  // Step 2: Match each slug to our shows
  let newMatches = 0;
  let skippedExisting = 0;
  let unmatched = 0;
  const unmatchedSlugs = [];
  const allMatches = {};

  // Build reverse map: showId → dtliSlug (from existing map)
  const existingReverse = new Map();
  for (const [showId, dtliSlug] of Object.entries(slugMap.shows)) {
    existingReverse.set(showId, dtliSlug);
  }

  for (const dtliSlug of uniqueSlugs) {
    // Skip if already mapped (unless --force)
    const alreadyMapped = Object.values(slugMap.shows).includes(dtliSlug);
    if (alreadyMapped && !FORCE) {
      skippedExisting++;
      continue;
    }

    const match = matchDtliSlug(dtliSlug, indices);
    if (match) {
      // Don't overwrite high-confidence existing mappings with low-confidence new ones
      if (existingReverse.has(match.showId) && !FORCE) {
        skippedExisting++;
        continue;
      }
      allMatches[match.showId] = { dtliSlug, ...match };
      newMatches++;
    } else {
      unmatched++;
      unmatchedSlugs.push(dtliSlug);
    }
  }

  console.log(`\nResults:`);
  console.log(`  New matches: ${newMatches}`);
  console.log(`  Already mapped (skipped): ${skippedExisting}`);
  console.log(`  Unmatched DTLI slugs: ${unmatched}`);

  // Print confidence breakdown
  const byConfidence = { high: 0, medium: 0, low: 0 };
  for (const m of Object.values(allMatches)) {
    byConfidence[m.confidence]++;
  }
  console.log(`  Confidence: ${byConfidence.high} high, ${byConfidence.medium} medium, ${byConfidence.low} low`);

  if (unmatchedSlugs.length > 0 && unmatchedSlugs.length <= 30) {
    console.log(`\nUnmatched DTLI slugs (may be off-Broadway or not in our DB):`);
    for (const s of unmatchedSlugs) {
      console.log(`  - ${s}`);
    }
  } else if (unmatchedSlugs.length > 30) {
    console.log(`\nFirst 30 unmatched DTLI slugs:`);
    for (const s of unmatchedSlugs.slice(0, 30)) {
      console.log(`  - ${s}`);
    }
  }

  // Print new matches
  if (newMatches > 0 && newMatches <= 50) {
    console.log(`\nNew matches:`);
    for (const [showId, m] of Object.entries(allMatches)) {
      console.log(`  ${showId} → ${m.dtliSlug} (${m.confidence}, ${m.matchType})`);
    }
  }

  if (DRY_RUN) {
    console.log('\n[DRY RUN] No changes written.');
    return;
  }

  // Step 3: Merge new matches into slug map
  for (const [showId, m] of Object.entries(allMatches)) {
    slugMap.shows[showId] = m.dtliSlug;
  }

  // Update metadata
  slugMap._meta.lastUpdated = new Date().toISOString();
  slugMap._meta.totalDtliSlugs = uniqueSlugs.length;
  slugMap._meta.matchedShows = Object.keys(slugMap.shows).length;
  slugMap._meta.unmatchedSlugs = unmatchedSlugs;

  // Write atomically
  const tmpPath = SLUG_MAP_PATH + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(slugMap, null, 2) + '\n');
  fs.renameSync(tmpPath, SLUG_MAP_PATH);

  console.log(`\nWrote ${Object.keys(slugMap.shows).length} total mappings to ${path.relative(process.cwd(), SLUG_MAP_PATH)}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
