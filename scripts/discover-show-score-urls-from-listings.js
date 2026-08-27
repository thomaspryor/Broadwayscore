#!/usr/bin/env node
/**
 * discover-show-score-urls-from-listings.js
 *
 * Smart Show Score URL discovery that scrapes their actual listings pages
 * instead of guessing URL slugs. Works for all these categories:
 *   - Broadway: https://www.show-score.com/broadway-shows
 *   - Off-Broadway: https://www.show-score.com/off-broadway-shows
 *   - Off-Off-Broadway: https://www.show-score.com/off-off-broadway-shows
 *   - West End: https://www.show-score.com/uk/london/west-end-shows
 *
 * Off-Off-Broadway shows (small rental venues like SoHo Playhouse booking
 * limited-run solo comedy/fringe transfers) get their own Show Score category
 * distinct from "Off-Broadway" even when our own shows.json tracks the venue
 * under category:"off-broadway" — matched into our DB the same way as the
 * off-broadway listing (card: SoHo Playhouse discovery gap, 2026-08-27).
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
const { isLondonMarket } = require('./lib/venue-classification');

const DATA_DIR = path.join(__dirname, '../data');
const URLS_PATH = path.join(DATA_DIR, 'show-score-urls.json');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const CANDIDATES_PATH = path.join(DATA_DIR, 'show-score-candidates.json');

// Candidates older than this are pruned (show probably closed or was a one-off event)
const CANDIDATE_TTL_DAYS = 90;

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

// ── Venue extraction from listing titles ──
// Show Score listing titles sometimes include venue in trailing parentheses:
//   "Little Shop of Horrors (Sheen Center)"
//   "Burnout Paradise (Astor Place Theatre)"
// Category tags like (Broadway), (Off-Broadway) etc. are NOT venues.

const CATEGORY_TAGS = /^(Broadway|London|West End|Off-Broadway|NYC|Off Broadway)$/i;

function extractVenueFromTitle(rawTitle) {
  const title = (rawTitle || '').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
  const match = title.match(/\s*\(([^)]+)\)\s*$/);
  if (!match) return null;
  if (CATEGORY_TAGS.test(match[1].trim())) return null;
  return match[1].trim();
}

function venuesMatch(a, b) {
  if (!a || !b) return false;
  const norm = s => s.toLowerCase()
    .replace(/\bthe\b/g, '')
    .replace(/\btheatre\b/g, 'theater')
    .replace(/[''""'":,.!?–—-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const na = norm(a);
  const nb = norm(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  return false;
}

// ── Date-aware production validation ──
// Show Score is a JavaScript SPA — plain HTTP fetches get empty shell HTML.
// Instead, we validate against our ARCHIVED HTML files (saved by Playwright
// from previous gather runs). These contain fully-rendered content with
// review dates and status info.
// Two signals:
// 1. Status: "Closed" or "Open run" — compare against our status
// 2. Median review date: if >3 years from opening, it's a different production

const ARCHIVE_DIR = path.join(DATA_DIR, 'aggregator-archive', 'show-score');

function validateUrlWithArchive(url, show) {
  // Look for existing archive for a DIFFERENT show that has this same URL
  // The archive filename is {show-id}.html, so we check all archives for URL matches
  // Also validate using the URL slug to find matching archives
  const urlSlug = url.replace(/.*\//, ''); // e.g. "little-shop-of-horrors" from full URL

  // Check all archived files for this URL slug
  let archiveHtml = null;
  let archiveShowId = null;
  try {
    const archiveFiles = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.html'));
    for (const file of archiveFiles) {
      const fileSlug = file.replace('.html', '');
      // If an existing archive file matches this URL slug but for a DIFFERENT show,
      // that's a clue the URL was previously assigned to another production
      const archivePath = path.join(ARCHIVE_DIR, file);
      const content = fs.readFileSync(archivePath, 'utf8');
      // Check if this archive's Show Score URL matches the URL we're validating
      if (content.includes(urlSlug) || file === `${urlSlug}.html`) {
        archiveHtml = content;
        archiveShowId = fileSlug;
        break;
      }
    }
  } catch (e) {
    // No archive dir or read error — can't validate
  }

  if (!archiveHtml) {
    return { valid: true, reason: 'no archive available for validation' };
  }

  // Signal 1: Status mismatch
  const statusMatch = archiveHtml.match(/class="show-page-v2__info-top-line"[^>]*>\s*(Closed|Open run)/i);
  const pageStatus = statusMatch ? statusMatch[1].toLowerCase().trim() : null;
  if (pageStatus && show.status === 'closed' && pageStatus === 'open run') {
    return { valid: false, reason: `Archive says "Open run" but production ${show.id} is closed — likely a newer production` };
  }

  // Signal 2: Median review date
  // Show Score uses ordinal dates: "October 6th, 2022", "January 1st, 2023"
  const datePattern = /(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}(?:st|nd|rd|th)?,?\s*\d{4}/gi;
  const rawDates = archiveHtml.match(datePattern) || [];
  const dates = [];
  const { parseDate: parseDateUtil } = require('./lib/date-utils');
  for (const m of rawDates) {
    const d = parseDateUtil(m);
    if (d && d.getFullYear() >= 2000 && d.getFullYear() <= 2030) {
      dates.push(d);
    }
  }

  if (dates.length < 3) {
    return { valid: true, reason: `${pageStatus || 'no status'}, ${dates.length} archive dates (too few)` };
  }

  dates.sort((a, b) => a - b);
  const median = dates[Math.floor(dates.length / 2)];
  const showYear = show.openingDate ? new Date(show.openingDate).getFullYear() : null;

  if (showYear && Math.abs(median.getFullYear() - showYear) > 3) {
    return {
      valid: false,
      reason: `Archive median review ${median.getFullYear()} is >3yr from opening ${showYear} (archive: ${archiveShowId})`,
    };
  }

  return { valid: true, reason: `${pageStatus || 'no status'}, median ${median.getFullYear()}, opens ${showYear} — OK` };
}

// ── Title normalization for fuzzy matching ──

function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s*\(broadway\)\s*/gi, '')
    .replace(/\s*\(london\)\s*/gi, '')
    .replace(/\s*\(west end\)\s*/gi, '')
    .replace(/\s*\(off-broadway\)\s*/gi, '')
    .replace(/\s*\(nyc\)\s*/gi, '')
    .replace(/\s*\([^)]*\)\s*$/g, '')  // Strip trailing parenthetical (venue, etc.)
    .replace(/^encores!\s*/i, '')  // Strip "Encores!" prefix for City Center shows
    .replace(/\*+/g, '')  // Strip censoring asterisks (s**tshow → shtshow)
    .replace(/[''""":,.!?–—-]/g, '')
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
  // Word-set matching: if ≥75% of significant words (3+ chars) from the shorter title
  // appear in the longer title. Catches subtitle variations ("A Musical About Nothing"
  // vs "An Unauthorized Musical Parody About Nothing") and censored titles ("shtshow"
  // vs "shitshow" where 3/4 other words still match).
  const shorterWords = shorterNoThe.split(' ').filter(w => w.length >= 3);
  const longerWords = new Set(longerNoThe.split(' ').filter(w => w.length >= 3));
  if (shorterWords.length >= 2) {
    const matchCount = shorterWords.filter(w => longerWords.has(w)).length;
    if (matchCount >= Math.ceil(shorterWords.length * 0.75)) return true;
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
  // Also build a "core title" map: normalizeTitle(before first comma/colon) → shows
  // This catches "Beaches" matching "Beaches, A New Musical" — normalizeTitle strips
  // commas so the comma-split in findBestMatch can't work on already-normalized text.
  const showsByCoreTitle = {};
  for (const show of shows) {
    const norm = normalizeTitle(show.title);
    if (!showsByNormalizedTitle[norm]) showsByNormalizedTitle[norm] = [];
    showsByNormalizedTitle[norm].push(show);
    // Extract core title from raw title (before comma or colon), normalize separately
    const rawCore = show.title.split(/[,:]/, 1)[0].trim();
    const normCore = normalizeTitle(rawCore);
    if (normCore && normCore !== norm && normCore.length >= 5) {
      if (!showsByCoreTitle[normCore]) showsByCoreTitle[normCore] = [];
      showsByCoreTitle[normCore].push(show);
    }
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

  // Off-Off-Broadway is a separate Show Score category (small rental/fringe
  // venues — SoHo Playhouse, La MaMa, etc.) even though we track those venues
  // under our own "off-broadway" category. Merge into obListings so it flows
  // through the same off-broadway matching/candidate path below.
  const oobListings = await fetchAllListings(
    'https://www.show-score.com/off-off-broadway-shows',
    /^\/off-off-broadway-shows\//,
    'Off-Off-Broadway'
  );
  console.log(`  Off-Off-Broadway: ${oobListings.length} shows found`);
  {
    const seenObHrefs = new Set(obListings.map(l => l.href));
    for (const l of oobListings) {
      if (!seenObHrefs.has(l.href)) {
        seenObHrefs.add(l.href);
        obListings.push(l);
      }
    }
  }

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
    'off-west-end': 'off-west-end',
  };

  function findBestMatch(listing, ourCategory, listingVenue) {
    const listingTitle = listing.title
      .replace(/&amp;/g, '&')
      .replace(/&#39;/g, "'");
    const norm = normalizeTitle(listingTitle);

    // Try exact normalized title match first
    let candidates = showsByNormalizedTitle[norm] || [];

    // Try core title matching: extract part before comma/colon from the RAW listing title
    // (normalizeTitle strips commas, so we split the raw title first)
    // This catches "Beaches" (ShowScore) → "Beaches, A New Musical" (our DB)
    if (candidates.length === 0) {
      const listingCore = normalizeTitle(listingTitle.split(/[,:]/, 1)[0].trim());
      if (listingCore && listingCore !== norm) {
        // Listing's core title → our full normalized titles
        if (showsByNormalizedTitle[listingCore]) {
          candidates = showsByNormalizedTitle[listingCore];
        }
        // Listing's core title → our core titles
        if (candidates.length === 0 && showsByCoreTitle[listingCore]) {
          candidates = showsByCoreTitle[listingCore];
        }
      }
      // Also try: listing full title matches our core titles (reverse direction)
      if (candidates.length === 0 && showsByCoreTitle[norm]) {
        candidates = showsByCoreTitle[norm];
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
    if (isLondonMarket(ourCategory)) {
      filtered = candidates.filter(s => isLondonMarket(s.category));
    } else if (ourCategory === 'off-broadway') {
      filtered = candidates.filter(s => s.category === 'off-broadway');
    } else {
      // Broadway: exclude OB and London markets
      filtered = candidates.filter(s => s.category !== 'off-broadway' && !isLondonMarket(s.category));
    }

    if (filtered.length === 0) {
      // Don't fall back to cross-category matching — too many false positives
      return null;
    }

    // Venue disambiguation: when listing title includes a venue and multiple candidates exist
    if (filtered.length > 1 && listingVenue) {
      const venueMatched = filtered.filter(s => venuesMatch(listingVenue, s.venue));
      if (venueMatched.length >= 1) {
        if (verbose && venueMatched.length < filtered.length) {
          console.log(`    [VENUE] Narrowed ${filtered.length} → ${venueMatched.length} via venue "${listingVenue}"`);
        }
        filtered = venueMatched;
      }
    }

    // Log ambiguous multi-production matches for spot-checking
    if (filtered.length > 1 && verbose) {
      console.log(`    [AMBIGUOUS] "${listing.title}" matches ${filtered.length}: ${filtered.map(s => s.id).join(', ')}`);
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

  // Build multi-production lookup: shows with year suffix that share a base title
  const productionsByBase = {};
  for (const s of shows) {
    const base = s.id.replace(/-\d{4}$/, '');
    if (!productionsByBase[base]) productionsByBase[base] = [];
    productionsByBase[base].push(s);
  }
  const multiProductionBases = new Set(
    Object.entries(productionsByBase).filter(([_, p]) => p.length > 1).map(([b]) => b)
  );

  let newDiscoveries = 0;
  let alreadyCached = 0;
  let noMatch = 0;
  let urlConflict = 0;
  let dateRejected = 0;
  const discoveries = [];
  const candidates = []; // Unmatched listings → potential new shows
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

      const listingVenue = extractVenueFromTitle(listing.title);
      const match = findBestMatch(listing, category, listingVenue);
      if (!match) {
        noMatch++;
        candidates.push({
          title: displayTitle,
          showScoreUrl: fullUrl,
          category: category || 'broadway',
        });
        if (verbose) console.log(`  [NO MATCH] ${displayTitle} (${listing.href})`);
        continue;
      }

      // Skip if this show already has a URL (in cache or assigned earlier this run)
      if (urlData.shows[match.id] || assignedInThisRun.has(match.id)) {
        alreadyCached++;
        if (verbose) console.log(`  [HAS URL] ${displayTitle} → ${match.id} (already has URL)`);
        continue;
      }

      // Date-aware validation for multi-production shows: check archived HTML
      // for review date and status mismatches before accepting the URL
      const base = match.id.replace(/-\d{4}$/, '');
      const isMultiProduction = multiProductionBases.has(base);
      if (isMultiProduction && match.openingDate) {
        console.log(`  [DATE CHECK] "${displayTitle}" → ${match.id} (${productionsByBase[base].length} productions, checking archive...)`);
        const validation = validateUrlWithArchive(fullUrl, match);
        if (!validation.valid) {
          console.log(`  [DATE REJECTED] ${match.id}: ${validation.reason}`);
          dateRejected++;
          continue;
        }
        console.log(`    [DATE OK] ${validation.reason}`);
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
  console.log(`No match in DB:   ${noMatch} (→ candidates)`);
  console.log(`URL conflicts:    ${urlConflict}`);
  console.log(`Date rejected:    ${dateRejected}`);
  console.log('═══════════════════════════════════════\n');

  // ── Write URL results ──
  if (newDiscoveries > 0 && !dryRun) {
    for (const d of discoveries) {
      // Check for duplicate URL: another show already has this URL
      const existingOwner = Object.entries(urlData.shows).find(([id, url]) => url === d.url && id !== d.showId);
      if (existingOwner) {
        console.log(`  [DUPLICATE URL] ${d.url} already assigned to ${existingOwner[0]}, skipping ${d.showId}`);
        urlConflict++;
        continue;
      }
      urlData.shows[d.showId] = d.url;
    }
    urlData._meta = urlData._meta || {};
    urlData._meta.lastUpdated = new Date().toISOString();
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

  // ── Write candidates file (unmatched listings for new show discovery) ──
  // Always run merge/prune logic (even with 0 new candidates) to expire stale entries
  {
    // Load existing candidates and merge
    let existingCandidates = [];
    try {
      const existing = JSON.parse(fs.readFileSync(CANDIDATES_PATH, 'utf8'));
      existingCandidates = existing.candidates || [];
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn(`  Warning: could not parse ${CANDIDATES_PATH}: ${e.message}`);
    }

    // Build URL set of current candidates for dedup
    const currentUrls = new Set(candidates.map(c => c.showScoreUrl));

    // Keep existing candidates that:
    // 1. Aren't in the current batch (they weren't on listings this run — keep if not expired)
    // 2. Haven't been matched to a show (URL not in urlData.shows values)
    const matchedUrls = new Set(Object.values(urlData.shows));
    const now = Date.now();
    const ttlMs = CANDIDATE_TTL_DAYS * 24 * 60 * 60 * 1000;

    const mergedCandidates = [];

    // Add current run's candidates with fresh timestamp
    for (const c of candidates) {
      if (matchedUrls.has(c.showScoreUrl)) continue; // Already matched this run
      mergedCandidates.push({
        ...c,
        discoveredAt: new Date().toISOString(),
      });
    }

    // Carry over existing candidates not in this run and not expired/matched
    for (const c of existingCandidates) {
      if (currentUrls.has(c.showScoreUrl)) continue; // Replaced by fresh entry above
      if (matchedUrls.has(c.showScoreUrl)) continue; // Matched since last run
      const age = now - new Date(c.discoveredAt).getTime();
      if (age > ttlMs) continue; // Expired (>90 days old)
      mergedCandidates.push(c);
    }

    if (mergedCandidates.length > 0 || existingCandidates.length > 0) {
      const candidatesData = {
        _meta: {
          lastUpdated: new Date().toISOString(),
          totalCandidates: mergedCandidates.length,
          ttlDays: CANDIDATE_TTL_DAYS,
        },
        candidates: mergedCandidates,
      };

      if (!dryRun) {
        fs.writeFileSync(CANDIDATES_PATH, JSON.stringify(candidatesData, null, 2) + '\n');
        console.log(`Wrote ${mergedCandidates.length} candidates to show-score-candidates.json (${candidates.length} new this run)`);
      } else {
        console.log(`[DRY RUN] Would write ${mergedCandidates.length} candidates (${candidates.length} new)`);
      }
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
