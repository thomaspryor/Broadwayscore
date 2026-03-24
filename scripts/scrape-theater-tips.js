#!/usr/bin/env node
/**
 * scrape-theater-tips.js
 *
 * Scrapes nearby restaurant names/addresses and parking garage names/addresses
 * from NewYorkCityTheatre.com for each Broadway theater.
 *
 * Extracts only FACTUAL data (names, addresses, distances, cuisine types,
 * price ranges) — not editorial content, ratings, or descriptions.
 *
 * Output: data/theater-tips-scraped.json
 *
 * Usage:
 *   node scripts/scrape-theater-tips.js [--limit N] [--theater "Booth"]
 *
 * Uses scraper.js fetchPage() for BD → SB → Playwright fallback chain.
 */

const fs = require('fs');
const path = require('path');
const { fetchPage, cleanup: cleanupScraper } = require('./lib/scraper');

// ============================================
// Theater name → NYC Theatre Guide slug mapping
// Manually verified from /venues/category/theater-district
// ============================================

const THEATER_SLUG_MAP = {
  'Al Hirschfeld Theatre': 'alhirschfeldtheater',
  'Ambassador Theatre': 'ambassadortheater',
  'August Wilson Theatre': 'augustwilsontheater',
  'Belasco Theatre': 'belascotheater',
  'Bernard B. Jacobs Theatre': 'bernardbjacobstheater',
  'Booth Theatre': 'booththeater',
  'Broadhurst Theatre': 'broadhursttheater',
  'Broadway Theatre': 'broadwaytheater',
  'Lena Horne Theatre': 'lena-horne-theatre',
  'Circle in the Square Theatre': 'circleinthesquaretheater',
  'Ethel Barrymore Theatre': 'ethelbarrymoretheater',
  "Eugene O'Neill Theatre": 'eugeneoneilltheater',
  'Gerald Schoenfeld Theatre': 'geraldschoenfeldtheater',
  'Gershwin Theatre': 'gershwintheater',
  // Harold and Miriam Steinberg — 299 seats, not on the site
  'Helen Hayes Theater': 'hayes-theatre',
  'Hudson Theatre': 'hudson-theatre',
  'Imperial Theatre': 'imperialtheater',
  'James Earl Jones Theatre': 'james-earl-jones-theatre',
  'John Golden Theatre': 'johngoldentheater',
  'Longacre Theatre': 'longacretheater',
  'Lunt-Fontanne Theatre': 'luntfontannetheater',
  'Lyceum Theatre': 'lyceumtheater',
  'Lyric Theatre': 'lyric-theatre',
  'Majestic Theatre': 'majestictheater',
  'Marquis Theatre': 'marquistheater',
  'Minskoff Theatre': 'minskofftheater',
  'Music Box Theatre': 'musicboxtheater',
  'Nederlander Theatre': 'nederlandertheater',
  'Neil Simon Theatre': 'neilsimontheater',
  'New Amsterdam Theatre': 'newamsterdamtheater',
  'Palace Theatre': 'palacetheater',
  'Richard Rodgers Theatre': 'richardrodgerstheater',
  'Samuel J. Friedman Theatre': 'friedmantheater',
  'Shubert Theatre': 'shuberttheater',
  'St. James Theatre': 'stjamestheater',
  'Stephen Sondheim Theatre': 'stephen-sondheim-theatre',
  'Studio 54': 'studio54',
  'Todd Haimes Theatre': 'todd-haimes-theatre',
  'Vivian Beaumont Theater': 'vivian-beaumont-theater',
  'Walter Kerr Theatre': 'walterkerrtheater',
  'Winter Garden Theatre': 'wintergardentheater',
};

const BASE_URL = 'https://www.newyorkcitytheatre.com/venues';
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'theater-tips-scraped.json');
const RATE_LIMIT_MS = 2000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// HTML parsers (work with raw HTML from any source)
// ============================================
// The site uses a consistent structure:
//   article > h1 (name), p (cuisine), div (price $$), p ("X mi away at ADDRESS")
// This is the same for both dining and parking pages.

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

function parseDiningFromHtml(html) {
  const results = [];
  const articleRegex = /<article[^>]*>([\s\S]*?)<\/article>/gi;
  let match;

  while ((match = articleRegex.exec(html)) !== null) {
    const block = match[1];
    const h1Match = block.match(/<h1[^>]*>([^<]+)<\/h1>/i);
    if (!h1Match) continue;
    const name = stripTags(h1Match[1]);
    if (!name || name.length < 2) continue;

    const entry = { name };
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pMatch;
    while ((pMatch = pRegex.exec(block)) !== null) {
      const text = stripTags(pMatch[1]);
      const distMatch = text.match(/([\d.]+)\s*mi\s*away\s*at\s*(.*)/);
      if (distMatch) {
        entry.distance = distMatch[1] + ' mi';
        entry.address = distMatch[2].trim();
      } else if (!text.includes('More Info') && !text.includes('Reserve') && text.length > 1 && text.length < 40) {
        if (!entry.cuisine) entry.cuisine = text;
      }
    }
    const priceMatch = block.match(/(\${2,4})/);
    if (priceMatch) entry.priceRange = priceMatch[1];
    results.push(entry);
  }
  return results;
}

function parseParkingFromHtml(html) {
  const results = [];
  // Parking uses <li> with <h3> — extract each <li> block
  const liRegex = /<li[^>]*>([\s\S]*?)<\/li>/gi;
  let match;

  while ((match = liRegex.exec(html)) !== null) {
    const block = match[1];
    const h3Match = block.match(/<h3[^>]*>([^<]+)<\/h3>/i);
    if (!h3Match) continue;
    const name = stripTags(h3Match[1]);
    if (!name || name.length < 3) continue;

    const entry = { name };
    const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
    let pMatch;
    while ((pMatch = pRegex.exec(block)) !== null) {
      const text = stripTags(pMatch[1]);
      const distMatch = text.match(/([\d.]+)\s*mi\s*away\s*at\s*(.*)/);
      if (distMatch) {
        entry.distance = distMatch[1] + ' mi';
        entry.address = distMatch[2].trim();
      }
    }
    results.push(entry);
  }
  // Deduplicate
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });
}

async function extractDining(url) {
  const html = await fetchPage(url);
  return parseDiningFromHtml(html);
}

async function extractParking(url) {
  const html = await fetchPage(url);
  return parseParkingFromHtml(html);
}

// ============================================
// Main
// ============================================

async function main() {
  const args = process.argv.slice(2);
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : 0;
  const theaterIdx = args.indexOf('--theater');
  const theaterFilter = theaterIdx >= 0 ? args[theaterIdx + 1] : null;

  // Load existing results for checkpoint/resume
  let existing = {};
  if (fs.existsSync(OUTPUT_FILE)) {
    try {
      existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
      console.log(`Loaded ${Object.keys(existing.theaters || {}).length} existing theater results`);
    } catch (e) {
      console.log('Starting fresh');
    }
  }

  const theaters = existing.theaters || {};
  let entries = Object.entries(THEATER_SLUG_MAP);

  if (theaterFilter) {
    entries = entries.filter(([name]) =>
      name.toLowerCase().includes(theaterFilter.toLowerCase())
    );
    if (entries.length === 0) {
      console.error(`No theater matching "${theaterFilter}"`);
      process.exit(1);
    }
  }

  if (limit > 0) entries = entries.slice(0, limit);

  console.log(`\nScraping ${entries.length} theater(s)...`);
  console.log(`Method: BD → SB → Playwright (via scraper.js)\n`);

  let scraped = 0, skipped = 0, errors = 0;

  for (const [theaterName, slug] of entries) {
    if (theaters[theaterName] && !theaterFilter) {
      skipped++;
      continue;
    }

    const idx = scraped + skipped + 1;
    console.log(`[${idx}/${entries.length}] ${theaterName}`);

    const result = { slug, dining: [], parking: [], scrapedAt: new Date().toISOString() };

    // Dining
    try {
      result.dining = await extractDining(`${BASE_URL}/${slug}/dining`);
      console.log(`  Dining: ${result.dining.length} restaurants`);
    } catch (err) {
      console.log(`  Dining: FAILED — ${err.message}`);
      result.diningError = err.message;
      errors++;
    }

    await sleep(RATE_LIMIT_MS);

    // Parking
    try {
      result.parking = await extractParking(`${BASE_URL}/${slug}/parking`);
      console.log(`  Parking: ${result.parking.length} garages`);
    } catch (err) {
      console.log(`  Parking: FAILED — ${err.message}`);
      result.parkingError = err.message;
      errors++;
    }

    theaters[theaterName] = result;
    scraped++;

    // Checkpoint every 5
    if (scraped % 5 === 0) {
      saveOutput(theaters);
      console.log(`  [Checkpoint: ${Object.keys(theaters).length} theaters saved]`);
    }

    await sleep(RATE_LIMIT_MS);
  }

  saveOutput(theaters);
  await cleanupScraper();

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Done! Scraped: ${scraped}, Skipped: ${skipped}, Errors: ${errors}`);
  console.log(`Total: ${Object.keys(theaters).length} theaters`);

  // Quality summary
  let emptyDining = 0, emptyParking = 0;
  for (const data of Object.values(theaters)) {
    if (!data.dining || data.dining.length === 0) emptyDining++;
    if (!data.parking || data.parking.length === 0) emptyParking++;
  }
  if (emptyDining > 0 || emptyParking > 0) {
    console.log(`Warning: ${emptyDining} no dining, ${emptyParking} no parking`);
  }
}

function saveOutput(theaters) {
  const output = {
    _meta: {
      description: 'Scraped restaurant and parking data from NewYorkCityTheatre.com',
      source: 'newyorkcitytheatre.com',
      lastUpdated: new Date().toISOString(),
      note: 'Factual data only (names, addresses, distances). No editorial content.',
    },
    theaters,
  };
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
}

main().catch(async err => {
  await cleanupScraper().catch(() => {});
  console.error('Fatal error:', err);
  process.exit(1);
});
