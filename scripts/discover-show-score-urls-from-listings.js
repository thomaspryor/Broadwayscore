#!/usr/bin/env node
/**
 * discover-show-score-urls-from-listings.js
 *
 * Smart Show Score URL discovery that scrapes their actual listings pages
 * instead of guessing URL slugs. Works for all 3 categories:
 *   - Broadway: https://www.show-score.com/broadway-shows
 *   - Off-Broadway: https://www.show-score.com/off-broadway-shows
 *   - West End: https://www.show-score.com/uk/london/west-end-shows
 *
 * Usage:
 *   node scripts/discover-show-score-urls-from-listings.js [--dry-run] [--verbose]
 *
 * This script replaces brittle URL slug guessing with real URL discovery.
 * It fetches Show Score's own listings, extracts show URLs, and fuzzy-matches
 * them against our shows.json entries.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const DATA_DIR = path.join(__dirname, '../data');
const URLS_PATH = path.join(DATA_DIR, 'show-score-urls.json');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');

const dryRun = process.argv.includes('--dry-run');
const verbose = process.argv.includes('--verbose');

// ── Fetch helpers ──

function fetchPage(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchPage(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Title normalization for fuzzy matching ──

function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/\s*\(broadway\)\s*/gi, '')
    .replace(/\s*\(london\)\s*/gi, '')
    .replace(/\s*\(west end\)\s*/gi, '')
    .replace(/\s*\(off-broadway\)\s*/gi, '')
    .replace(/\s*\([^)]*\)\s*$/g, '')  // Strip trailing parenthetical (venue, etc.)
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/[''""":,.!?]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titlesMatch(a, b) {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Handle "the" prefix variations
  const naNoThe = na.replace(/^the /, '');
  const nbNoThe = nb.replace(/^the /, '');
  if (naNoThe === nbNoThe) return true;
  // Substring matching: only if the shorter string is a significant portion of the longer one
  // AND the shorter string is at least 8 chars (prevents "ma" matching "amaze", "da" matching "madama butterfly")
  // AND the shorter string matches at a word boundary (not in the middle of a word)
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  const shorterNoThe = shorter.replace(/^the /, '');
  const longerNoThe = longer.replace(/^the /, '');
  if (shorterNoThe.length >= 8 && shorterNoThe.length >= longerNoThe.length * 0.5) {
    // Must match at a word boundary
    const regex = new RegExp(`\\b${shorterNoThe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (regex.test(longerNoThe) || longerNoThe.startsWith(shorterNoThe)) return true;
  }
  return false;
}

// ── Extract show listings from HTML ──

function extractListingsFromHtml(html, categoryPattern) {
  // Pattern: title="Show Name (Category)" href="/category-path/slug"
  // Also handles: href="/category-path/slug" ... title="Show Name (Category)"
  const results = [];
  const seen = new Set();

  // Pattern 1: title before href
  const pattern1 = /title="([^"]+)"\s+href="(\/[^"#]+)"/g;
  let match;
  while ((match = pattern1.exec(html)) !== null) {
    const [, title, href] = match;
    if (!href.match(categoryPattern)) continue;
    if (title === 'Show-Score' || title.includes('Improve our accuracy') || title.includes('Get alerts')) continue;
    if (!seen.has(href)) {
      seen.add(href);
      results.push({ title, href });
    }
  }

  // Pattern 2: href before title (less common but possible)
  const pattern2 = /href="(\/[^"#]+)"\s+[^>]*title="([^"]+)"/g;
  while ((match = pattern2.exec(html)) !== null) {
    const [, href, title] = match;
    if (!href.match(categoryPattern)) continue;
    if (title === 'Show-Score' || title.includes('Improve our accuracy') || title.includes('Get alerts')) continue;
    if (!seen.has(href)) {
      seen.add(href);
      results.push({ title, href });
    }
  }

  return results;
}

// ── Fetch all listings for a category with pagination ──

async function fetchAllListings(baseUrl, categoryPattern, label) {
  const allListings = [];
  const seenHrefs = new Set();
  let page = 1;
  let emptyStreak = 0;

  while (emptyStreak < 2) {
    const url = page === 1 ? baseUrl : `${baseUrl}?page=${page}`;
    if (verbose) console.log(`  Fetching ${label} page ${page}...`);

    try {
      const html = await fetchPage(url);
      const listings = extractListingsFromHtml(html, categoryPattern);

      let newCount = 0;
      for (const listing of listings) {
        if (!seenHrefs.has(listing.href)) {
          seenHrefs.add(listing.href);
          allListings.push(listing);
          newCount++;
        }
      }

      if (newCount === 0) {
        emptyStreak++;
      } else {
        emptyStreak = 0;
      }

      if (verbose) console.log(`    Found ${listings.length} shows (${newCount} new)`);
    } catch (err) {
      console.error(`  Error fetching ${url}: ${err.message}`);
      break;
    }

    page++;
    await sleep(1500); // Rate limit
  }

  return allListings;
}

// ── Main ──

async function main() {
  console.log('Show Score URL Discovery from Listings\n');

  // Load data
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows || showsData;
  const urlData = JSON.parse(fs.readFileSync(URLS_PATH, 'utf8'));
  if (!urlData.shows) urlData.shows = {};

  // Build lookup maps by normalized title → shows (grouped by category)
  const showsByNormalizedTitle = {};
  for (const show of shows) {
    const norm = normalizeTitle(show.title);
    if (!showsByNormalizedTitle[norm]) showsByNormalizedTitle[norm] = [];
    showsByNormalizedTitle[norm].push(show);
  }

  // Also build a reverse map: existing URL → show ID
  const existingUrlToId = {};
  for (const [id, url] of Object.entries(urlData.shows)) {
    existingUrlToId[url] = id;
  }

  // ── Fetch all listings ──
  console.log('Fetching Show Score listings...\n');

  const broadwayListings = await fetchAllListings(
    'https://www.show-score.com/broadway-shows',
    /^\/broadway-shows\//,
    'Broadway'
  );
  console.log(`  Broadway: ${broadwayListings.length} shows found`);

  const obListings = await fetchAllListings(
    'https://www.show-score.com/off-broadway-shows',
    /^\/off-broadway-shows\//,
    'Off-Broadway'
  );
  console.log(`  Off-Broadway: ${obListings.length} shows found`);

  // West End: no pagination (loops), fetch both endpoints once
  let weListings = [];
  try {
    const weHtml = await fetchPage('https://www.show-score.com/uk/london/west-end-shows');
    weListings = extractListingsFromHtml(weHtml, /^\/uk\/london\/west-end-shows\//);
    await sleep(1500);
    // Also get off-west-end shows from the London page
    const londonHtml = await fetchPage('https://www.show-score.com/uk/london');
    const offWeListings = extractListingsFromHtml(londonHtml, /^\/uk\/london\/(west-end-shows|off-west-end-shows)\//);
    const seenHrefs = new Set(weListings.map(l => l.href));
    for (const l of offWeListings) {
      if (!seenHrefs.has(l.href)) {
        seenHrefs.add(l.href);
        weListings.push(l);
      }
    }
  } catch (err) {
    console.error(`  Error fetching West End listings: ${err.message}`);
  }
  console.log(`  West End: ${weListings.length} shows found`);

  const totalListings = broadwayListings.length + obListings.length + weListings.length;
  console.log(`\nTotal Show Score listings: ${totalListings}\n`);

  // ── Match listings to our shows ──

  // Map listing category to our show category
  const categoryMap = {
    broadway: undefined, // default (not off-broadway and not west-end)
    'off-broadway': 'off-broadway',
    'west-end': 'west-end',
  };

  function findBestMatch(listing, ourCategory) {
    const listingTitle = listing.title
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'");
    const norm = normalizeTitle(listingTitle);

    // Try exact normalized title match first
    let candidates = showsByNormalizedTitle[norm] || [];

    // Try stripping subtitle after comma (e.g., "Beaches" vs "Beaches, A New Musical")
    if (candidates.length === 0) {
      const beforeComma = norm.split(',')[0].trim();
      if (beforeComma !== norm && showsByNormalizedTitle[beforeComma]) {
        candidates = showsByNormalizedTitle[beforeComma];
      }
    }

    // Also try matching where OUR title's before-comma matches the listing title
    if (candidates.length === 0) {
      for (const [normTitle, showGroup] of Object.entries(showsByNormalizedTitle)) {
        const ourBeforeComma = normTitle.split(',')[0].trim();
        if (ourBeforeComma === norm || norm === normTitle) {
          candidates = candidates.concat(showGroup);
        }
      }
    }

    // If no exact match, try fuzzy matching against all shows
    if (candidates.length === 0) {
      for (const [normTitle, showGroup] of Object.entries(showsByNormalizedTitle)) {
        if (titlesMatch(norm, normTitle)) {
          candidates = candidates.concat(showGroup);
        }
      }
    }

    if (candidates.length === 0) return null;

    // Filter by category
    let filtered;
    if (ourCategory === 'west-end') {
      filtered = candidates.filter(s => s.category === 'west-end');
    } else if (ourCategory === 'off-broadway') {
      filtered = candidates.filter(s => s.category === 'off-broadway');
    } else {
      // Broadway: exclude OB and WE
      filtered = candidates.filter(s => s.category !== 'off-broadway' && s.category !== 'west-end');
    }

    if (filtered.length === 0) {
      // Don't fall back to cross-category matching — too many false positives
      return null;
    }

    // Prefer open/previews shows, then most recent
    filtered.sort((a, b) => {
      const statusOrder = { open: 0, previews: 1, upcoming: 2, closed: 3, rumored: 4 };
      const sa = statusOrder[a.status] ?? 5;
      const sb = statusOrder[b.status] ?? 5;
      if (sa !== sb) return sa - sb;
      // Most recent opening date first
      const da = a.openingDate || a.startDate || '';
      const db = b.openingDate || b.startDate || '';
      return db.localeCompare(da);
    });

    return filtered[0];
  }

  let newDiscoveries = 0;
  let alreadyCached = 0;
  let noMatch = 0;
  let urlConflict = 0;
  const discoveries = [];
  const assignedInThisRun = new Set(); // Prevent same show getting 2 URLs in one run

  function processListings(listings, category, label) {
    console.log(`── Matching ${label} (${listings.length} shows) ──`);

    for (const listing of listings) {
      const fullUrl = `https://www.show-score.com${listing.href}`;
      const displayTitle = listing.title.replace(/&amp;/g, '&').replace(/&#39;/g, "'");

      // Skip if URL already claimed
      if (existingUrlToId[fullUrl]) {
        alreadyCached++;
        if (verbose) console.log(`  [CACHED] ${displayTitle} → ${existingUrlToId[fullUrl]}`);
        continue;
      }

      const match = findBestMatch(listing, category);
      if (!match) {
        noMatch++;
        if (verbose) console.log(`  [NO MATCH] ${displayTitle} (${listing.href})`);
        continue;
      }

      // Skip if this show already has a URL (in cache or assigned earlier this run)
      if (urlData.shows[match.id] || assignedInThisRun.has(match.id)) {
        alreadyCached++;
        if (verbose) console.log(`  [HAS URL] ${displayTitle} → ${match.id} (already has URL)`);
        continue;
      }

      console.log(`  ✓ NEW: "${displayTitle}" → ${match.id} (${fullUrl})`);
      discoveries.push({ showId: match.id, title: match.title, url: fullUrl });
      assignedInThisRun.add(match.id);
      newDiscoveries++;
    }
    console.log('');
  }

  processListings(broadwayListings, undefined, 'Broadway');
  processListings(obListings, 'off-broadway', 'Off-Broadway');
  processListings(weListings, 'west-end', 'West End');

  // ── Summary ──
  console.log('═══════════════════════════════════════');
  console.log(`New discoveries:  ${newDiscoveries}`);
  console.log(`Already cached:   ${alreadyCached}`);
  console.log(`No match in DB:   ${noMatch}`);
  console.log(`URL conflicts:    ${urlConflict}`);
  console.log('═══════════════════════════════════════\n');

  // ── Write results ──
  if (newDiscoveries > 0 && !dryRun) {
    for (const d of discoveries) {
      urlData.shows[d.showId] = d.url;
    }
    urlData._meta = urlData._meta || {};
    urlData._meta.lastUpdated = new Date().toISOString().split('T')[0];
    urlData._meta.lastListingsDiscovery = new Date().toISOString();
    fs.writeFileSync(URLS_PATH, JSON.stringify(urlData, null, 2) + '\n');
    console.log(`Wrote ${newDiscoveries} new URLs to show-score-urls.json`);
  } else if (newDiscoveries > 0 && dryRun) {
    console.log('[DRY RUN] Would write:');
    for (const d of discoveries) {
      console.log(`  ${d.showId}: ${d.url}`);
    }
  } else {
    console.log('No new URLs to write.');
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
