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
 * For CI, set SCRAPINGBEE_API_KEY for proxy-based fetching.
 * Locally, uses Playwright directly.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

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
// Playwright-based extraction
// ============================================
// The site uses a consistent structure:
//   article > h1 (name), p (cuisine), div (price $$), p ("X mi away at ADDRESS")
// This is the same for both dining and parking pages.

let browser = null;

async function initBrowser() {
  if (browser) return;
  const { chromium } = require('playwright');
  browser = await chromium.launch({ headless: true });
}

async function closeBrowser() {
  if (browser) {
    await browser.close();
    browser = null;
  }
}

/**
 * Dining extraction: articles with h1 name, p cuisine, p distance+address
 */
const EXTRACT_DINING_FN = `(() => {
  const articles = document.querySelectorAll('article');
  const results = [];
  for (const art of articles) {
    const h1 = art.querySelector('h1');
    if (!h1) continue;
    const name = h1.textContent.trim();
    if (!name || name.length < 2) continue;

    const entry = { name };
    const paras = art.querySelectorAll('p');

    for (const p of paras) {
      const text = p.textContent.trim();
      const distMatch = text.match(/([\\d.]+)\\s*mi\\s*away\\s*at\\s*(.*)/);
      if (distMatch) {
        entry.distance = distMatch[1] + ' mi';
        entry.address = distMatch[2].trim();
      } else if (!text.includes('More Info') && !text.includes('Reserve') && text.length > 1 && text.length < 40) {
        if (!entry.cuisine) entry.cuisine = text;
      }
    }

    const priceMatch = art.textContent.match(/(\\$\\$\\$?\\$?)/);
    if (priceMatch) entry.priceRange = priceMatch[1];

    results.push(entry);
  }
  return results;
})()`;

/**
 * Parking extraction: li items with h3 name, p distance+address
 * (Different HTML structure from dining — no article tags)
 */
const EXTRACT_PARKING_FN = `(() => {
  const items = document.querySelectorAll('li');
  const results = [];
  for (const item of items) {
    const h3 = item.querySelector('h3');
    if (!h3) continue;
    const name = h3.textContent.trim();
    if (!name || name.length < 3) continue;

    const entry = { name };
    const paras = item.querySelectorAll('p');
    for (const p of paras) {
      const text = p.textContent.trim();
      const distMatch = text.match(/([\\d.]+)\\s*mi\\s*away\\s*at\\s*(.*)/);
      if (distMatch) {
        entry.distance = distMatch[1] + ' mi';
        entry.address = distMatch[2].trim();
      }
    }
    results.push(entry);
  }
  // Deduplicate by name
  const seen = new Set();
  return results.filter(r => {
    if (seen.has(r.name)) return false;
    seen.add(r.name);
    return true;
  });
})()`;

async function extractFromPage(url, extractFn) {
  await initBrowser();
  const page = await browser.newPage();

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1500); // Let dynamic content settle

    const results = await page.evaluate(extractFn);
    await page.close();
    return results;
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

// ============================================
// ScrapingBee fallback (CI without Playwright)
// ============================================

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

async function fetchHtmlWithScrapingBee(url) {
  if (!SCRAPINGBEE_KEY) return null;

  const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=true&wait=3000`;

  return new Promise((resolve, reject) => {
    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else reject(new Error(`ScrapingBee HTTP ${res.statusCode}`));
      });
    }).on('error', reject);
  });
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
  if (SCRAPINGBEE_KEY) {
    const html = await fetchHtmlWithScrapingBee(url);
    return parseDiningFromHtml(html);
  } else {
    return await extractFromPage(url, EXTRACT_DINING_FN);
  }
}

async function extractParking(url) {
  if (SCRAPINGBEE_KEY) {
    const html = await fetchHtmlWithScrapingBee(url);
    return parseParkingFromHtml(html);
  } else {
    return await extractFromPage(url, EXTRACT_PARKING_FN);
  }
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
  console.log(`Method: ${SCRAPINGBEE_KEY ? 'ScrapingBee' : 'Playwright (local)'}\n`);

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
  await closeBrowser();

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
    console.log(`⚠️  Empty: ${emptyDining} no dining, ${emptyParking} no parking`);
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

main().catch(err => {
  closeBrowser().catch(() => {});
  console.error('Fatal error:', err);
  process.exit(1);
});
