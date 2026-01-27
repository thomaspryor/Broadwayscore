#!/usr/bin/env node
/**
 * Dedicated BroadwayWorld Review Roundup Scraper
 *
 * Extracts reviews from BWW Review Roundup articles.
 * BWW compiles all reviews into a single article per show.
 * Archives pages for future reference.
 *
 * Usage:
 *   node scripts/scrape-bww-roundups.js --show=merrily-we-roll-along-2023
 *   node scripts/scrape-bww-roundups.js --shows=show1,show2,show3
 *   node scripts/scrape-bww-roundups.js --all-historical
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Paths
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'aggregator-archive', 'bww-roundups');
const BWW_URLS_PATH = path.join(__dirname, '..', 'data', 'bww-roundup-urls.json');

// Load manual URL overrides (for shows with non-standard BWW URL patterns)
let bwwUrlOverrides = {};
if (fs.existsSync(BWW_URLS_PATH)) {
  bwwUrlOverrides = JSON.parse(fs.readFileSync(BWW_URLS_PATH, 'utf8'));
  delete bwwUrlOverrides._comment;
}

// Ensure archive directory exists
if (!fs.existsSync(ARCHIVE_DIR)) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

// Known Review Roundup URL patterns
// BWW uses various URL formats, we try multiple patterns
const BWW_URL_PATTERNS = [
  'https://www.broadwayworld.com/article/Review-Roundup-{TITLE}-Opens-on-Broadway',
  'https://www.broadwayworld.com/article/Read-All-the-Reviews-for-{TITLE}-on-Broadway',
  'https://www.broadwayworld.com/article/What-Do-Critics-Think-of-{TITLE}',
  'https://www.broadwayworld.com/article/{TITLE}-Reviews',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Load shows data
 */
function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return data.shows || data;
}

/**
 * HTTP GET with redirect handling
 */
function httpGet(url, maxRedirects = 5) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ found: true, html: data, finalUrl: url, status: 200 }));
      } else if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location;
        if (maxRedirects > 0) {
          const nextUrl = redirectUrl.startsWith('http') ? redirectUrl : `https://www.broadwayworld.com${redirectUrl}`;
          httpGet(nextUrl, maxRedirects - 1).then(resolve);
        } else {
          resolve({ found: false, tooManyRedirects: true, status: res.statusCode });
        }
      } else {
        resolve({ found: false, status: res.statusCode });
      }
    });
    req.on('error', (err) => resolve({ found: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ found: false, error: 'timeout' });
    });
  });
}

/**
 * Search BWW for review roundup article
 */
async function searchBWWRoundup(show) {
  // Check for manual URL override first (for shows with non-standard URLs)
  if (bwwUrlOverrides[show.id]) {
    const url = bwwUrlOverrides[show.id];
    console.log(`  Using manual URL override: ${url}`);
    const result = await httpGet(url);
    if (result.found && result.html) {
      return { url, html: result.html };
    }
    console.log(`  ✗ Manual URL override failed (status: ${result.status})`);
  }

  const openingDate = new Date(show.openingDate);
  const year = openingDate.getFullYear();
  const month = String(openingDate.getMonth() + 1).padStart(2, '0');
  const day = String(openingDate.getDate()).padStart(2, '0');
  const dateStr = `${year}${month}${day}`;

  // Generate title variations for URL
  const titleVariations = [
    show.title.toUpperCase().replace(/[^A-Z0-9\s]+/g, '').replace(/\s+/g, '-'),
    show.title.replace(/[^a-zA-Z0-9\s]+/g, '').replace(/\s+/g, '-'),
    show.title.replace(/'/g, '').replace(/[^a-zA-Z0-9\s]+/g, '').replace(/\s+/g, '-'),
    slugify(show.title).toUpperCase().replace(/-/g, '-'),
  ];

  // Try URL patterns

  // BWW URL patterns (with full date suffix YYYYMMDD)
  const searchUrls = [];

  for (const title of titleVariations) {
    // Most common patterns with full date
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Revival-Officially-Opens-What-Did-the-Critics-Think-${dateStr}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Officially-Opens-on-Broadway-What-Did-the-Critics-Think-${dateStr}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-on-Broadway-Updating-LIVE-${dateStr}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-on-Broadway-${dateStr}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-What-Did-the-Critics-Think-of-${title}-${dateStr}`);

    // Patterns with just year (legacy)
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-on-Broadway-Updating-LIVE-${year}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-on-Broadway-${year}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-${year}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Reviews-${title}-on-Broadway-${year}`);
  }

  console.log(`  Trying ${searchUrls.length} BWW URL patterns...`);

  for (const url of searchUrls) {
    const result = await httpGet(url);
    if (result.found && result.html) {
      // Verify it's a Broadway roundup (not Off-Broadway)
      const isBroadway = result.html.includes('Broadway') &&
        !result.html.includes('Off-Broadway') &&
        !result.html.includes('New York Theatre Workshop');

      // For revivals, also check if it's about the right production
      const isRightYear = result.html.includes(String(year));

      if (result.html.includes('Review Roundup') && (isBroadway || isRightYear)) {
        console.log(`  ✓ Found at: ${url}`);
        return { url, html: result.html };
      }
    }
    await sleep(200);
  }

  console.log(`  ✗ Not found via URL patterns, trying web search...`);

  // Fallback: Use web search to find the BWW Review Roundup
  const searchResult = await searchWebForBWWRoundup(show);
  if (searchResult) {
    return searchResult;
  }

  console.log(`  ✗ Not found via web search either`);
  return null;
}

/**
 * Search the web for BWW Review Roundup article
 * Uses ScrapingBee Google Search API (requires SCRAPINGBEE_API_KEY)
 */
async function searchWebForBWWRoundup(show) {
  const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

  if (!SCRAPINGBEE_KEY) {
    console.log(`  No SCRAPINGBEE_API_KEY, skipping web search`);
    return null;
  }

  console.log(`  Searching Google via ScrapingBee: ${show.title}...`);
  const searchQuery = `site:broadwayworld.com "Review Roundup" "${show.title}" Broadway`;
  const apiUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${SCRAPINGBEE_KEY}&search=${encodeURIComponent(searchQuery)}`;

  try {
    const response = await new Promise((resolve, reject) => {
      https.get(apiUrl, { timeout: 30000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`HTTP ${res.statusCode}`));
          }
        });
      }).on('error', reject);
    });

    // Parse organic results
    const results = response.organic_results || [];
    for (const result of results.slice(0, 5)) {
      const url = result.url || result.link;
      if (url && url.includes('broadwayworld.com/article/') && url.toLowerCase().includes('review-roundup')) {
        console.log(`  Trying search result: ${url}`);
        const pageResult = await httpGet(url);

        if (pageResult.found && pageResult.html && pageResult.html.includes('Review Roundup')) {
          // Verify it mentions the show title
          const titleWords = show.title.toLowerCase().split(/\s+/).filter(w => w.length > 3);
          const htmlLower = pageResult.html.toLowerCase();
          const matchCount = titleWords.filter(w => htmlLower.includes(w)).length;

          if (matchCount >= Math.min(2, titleWords.length)) {
            console.log(`  ✓ Found via Google search: ${url}`);
            saveUrlOverride(show.id, url);
            return { url, html: pageResult.html };
          }
        }
        await sleep(300);
      }
    }
  } catch (e) {
    console.log(`  Google search error: ${e.message}`);
  }

  return null;
}

/**
 * Save discovered URL to overrides file for future runs
 */
function saveUrlOverride(showId, url) {
  try {
    let overrides = {};
    if (fs.existsSync(BWW_URLS_PATH)) {
      overrides = JSON.parse(fs.readFileSync(BWW_URLS_PATH, 'utf8'));
    }

    if (!overrides[showId]) {
      overrides[showId] = url;
      const final = { _comment: "Manual and auto-discovered URL overrides for BWW Review Roundups with non-standard URL patterns" };
      Object.keys(overrides).sort().forEach(k => {
        if (k !== '_comment') final[k] = overrides[k];
      });

      fs.writeFileSync(BWW_URLS_PATH, JSON.stringify(final, null, 2));
      console.log(`  📝 Saved URL to bww-roundup-urls.json for future runs`);
    }
  } catch (e) {
    console.log(`  Warning: Could not save URL override: ${e.message}`);
  }
}

/**
 * Extract reviews from BWW Review Roundup HTML
 * BWW stores all reviews in JSON-LD articleBody as plain text
 * Format: "Critic Name, Outlet: excerpt"
 */
function extractBWWReviews(html, showId, bwwUrl) {
  const reviews = [];

  // Extract from JSON-LD articleBody
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!jsonLdMatch) {
    console.log('    No JSON-LD found');
    return reviews;
  }

  try {
    const jsonLd = JSON.parse(jsonLdMatch[1]);
    const articleBody = jsonLd.articleBody || '';

    if (!articleBody) {
      console.log('    No articleBody in JSON-LD');
      return reviews;
    }

    // Parse individual reviews from article body
    // Format is: "Critic Name, Outlet: excerpt" separated by double spaces or newlines
    // Example: "Jesse Green, The New York Times: Radcliffe's wit..."

    // Known critic patterns with their outlets
    const knownCriticPatterns = [
      // Format: Critic Name, Outlet: excerpt
      { regex: /Jesse Green,?\s*(?:The\s*)?New York Times:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Jesse Green', outlet: 'The New York Times', outletId: 'nytimes' },
      { regex: /Ben Brantley,?\s*(?:The\s*)?New York Times:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Ben Brantley', outlet: 'The New York Times', outletId: 'nytimes' },
      { regex: /Laura Collins-Hughes,?\s*(?:The\s*)?New York Times:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Laura Collins-Hughes', outlet: 'The New York Times', outletId: 'nytimes' },
      { regex: /Maya Phillips,?\s*(?:The\s*)?New York Times:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Maya Phillips', outlet: 'The New York Times', outletId: 'nytimes' },
      { regex: /Greg Evans,?\s*Deadline:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Greg Evans', outlet: 'Deadline', outletId: 'deadline' },
      { regex: /Robert Hofler,?\s*(?:The\s*)?Wrap:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Robert Hofler', outlet: 'The Wrap', outletId: 'the-wrap' },
      { regex: /Sara Holdren,?\s*Vulture:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Sara Holdren', outlet: 'Vulture', outletId: 'vulture' },
      { regex: /Jackson McHenry,?\s*Vulture:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Jackson McHenry', outlet: 'Vulture', outletId: 'vulture' },
      { regex: /Johnny Oleksinski,?\s*(?:New York\s*)?Post:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Johnny Oleksinski', outlet: 'New York Post', outletId: 'new-york-post' },
      { regex: /Adam Feldman,?\s*Time Out(?:\s*(?:New York|NY))?:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Adam Feldman', outlet: 'Time Out New York', outletId: 'time-out-new-york' },
      { regex: /David Rooney,?\s*(?:The\s*)?Hollywood Reporter:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'David Rooney', outlet: 'The Hollywood Reporter', outletId: 'hollywood-reporter' },
      { regex: /Frank Scheck,?\s*(?:The\s*)?Hollywood Reporter:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Frank Scheck', outlet: 'The Hollywood Reporter', outletId: 'hollywood-reporter' },
      { regex: /Matt Windman,?\s*(?:AM\s*)?(?:New York|NY):\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Matt Windman', outlet: 'AM New York', outletId: 'am-new-york' },
      { regex: /Tim Teeman,?\s*(?:The\s*)?Daily Beast:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Tim Teeman', outlet: 'The Daily Beast', outletId: 'daily-beast' },
      { regex: /David Gordon,?\s*TheaterMania:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'David Gordon', outlet: 'TheaterMania', outletId: 'theatermania' },
      { regex: /Zachary Stewart,?\s*TheaterMania:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Zachary Stewart', outlet: 'TheaterMania', outletId: 'theatermania' },
      { regex: /Joey Merlo,?\s*Theatrely:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Joey Merlo', outlet: 'Theatrely', outletId: 'theatrely' },
      { regex: /Juan A\. Ramirez,?\s*Theatrely:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Juan A. Ramirez', outlet: 'Theatrely', outletId: 'theatrely' },
      { regex: /Brittani Samuel,?\s*Broadway News:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Brittani Samuel', outlet: 'Broadway News', outletId: 'broadway-news' },
      { regex: /Michael Musto,?\s*Village Voice:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Michael Musto', outlet: 'Village Voice', outletId: 'village-voice' },
      { regex: /Naveen Kumar,?\s*Variety:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Naveen Kumar', outlet: 'Variety', outletId: 'variety' },
      { regex: /Frank Rizzo,?\s*Variety:\s*([\s\S]*?)(?=\s{2,}[A-Z]|\n\n|$)/gi, critic: 'Frank Rizzo', outlet: 'Variety', outletId: 'variety' },
    ];

    // Also try generic pattern: "Critic Name, Outlet: excerpt"
    // Match pattern like "Name Name, Outlet Name: text..."
    const genericPattern = /([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+),\s*((?:The\s+)?[A-Z][A-Za-z\s]+?):\s*([\s\S]*?)(?=\s{2,}[A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+,|\n\n|$)/g;

    const foundCritics = new Set();

    // First try known critic patterns
    for (const { regex, critic, outlet, outletId } of knownCriticPatterns) {
      const match = regex.exec(articleBody);
      if (match && match[1]) {
        const excerpt = match[1].trim();
        if (excerpt.length > 30 && !foundCritics.has(critic.toLowerCase())) {
          foundCritics.add(critic.toLowerCase());
          reviews.push({
            showId,
            outletId,
            outlet,
            criticName: critic,
            url: null,
            bwwExcerpt: excerpt.substring(0, 500),
            bwwRoundupUrl: bwwUrl,
            source: 'bww-roundup',
          });
        }
      }
    }

    // Then try generic pattern for remaining reviews
    let genericMatch;
    while ((genericMatch = genericPattern.exec(articleBody)) !== null) {
      const [, criticName, outletName, excerpt] = genericMatch;
      if (criticName && outletName && excerpt && excerpt.length > 30) {
        const critic = criticName.trim();
        if (!foundCritics.has(critic.toLowerCase())) {
          foundCritics.add(critic.toLowerCase());
          const outletInfo = mapOutlet(outletName.trim());
          if (outletInfo) {
            reviews.push({
              showId,
              outletId: outletInfo.outletId,
              outlet: outletInfo.outlet,
              criticName: critic,
              url: null,
              bwwExcerpt: excerpt.trim().substring(0, 500),
              bwwRoundupUrl: bwwUrl,
              source: 'bww-roundup',
            });
          }
        }
      }
    }

    console.log(`    Extracted ${reviews.length} reviews from BWW articleBody`);

  } catch (e) {
    console.log(`    Error parsing BWW JSON-LD: ${e.message}`);
  }

  // Fallback: Try to extract from HTML structure if articleBody parsing found nothing
  if (reviews.length === 0) {
    const foundCritics = new Set();
    const reviewSections = html.match(/<p[^>]*>.*?(?:<strong>|<b>).*?(?:<\/strong>|<\/b>).*?<\/p>/gi) || [];

    for (const section of reviewSections) {
      const criticOutletMatch = section.match(/(?:<strong>|<b>)([^<]+)(?:<\/strong>|<\/b>)[\s,]*(?:(?:<i>)?([^<:]+)(?:<\/i>)?)?/i);
      if (criticOutletMatch) {
        let [, criticPart, outletPart] = criticOutletMatch;
        criticPart = (criticPart || '').replace(/<[^>]+>/g, '').trim();
        outletPart = (outletPart || '').replace(/<[^>]+>/g, '').trim();

        let criticName = criticPart;
        let outlet = outletPart;

        const commaMatch = criticPart.match(/([^,]+),\s*(.+)/);
        if (commaMatch) {
          criticName = commaMatch[1].trim();
          outlet = commaMatch[2].trim();
        }

        if (foundCritics.has(criticName.toLowerCase())) continue;
        foundCritics.add(criticName.toLowerCase());

        const outletInfo = mapOutlet(outlet || criticName);
        if (outletInfo) {
          const excerptMatch = section.match(/(?:<\/strong>|<\/b>)[^<]*:?\s*["']?([\s\S]*?)["']?(?:<\/p>|$)/i);
          const excerpt = excerptMatch ? excerptMatch[1].replace(/<[^>]+>/g, '').trim() : null;

          if (excerpt && excerpt.length > 50) {
            reviews.push({
              showId,
              outletId: outletInfo.outletId,
              outlet: outletInfo.outlet,
              criticName: criticName || 'Unknown',
              url: null, // BWW roundups don't always have individual URLs
              bwwExcerpt: excerpt.substring(0, 500), // Truncate long excerpts
              bwwRoundupUrl: bwwUrl,
              source: 'bww-roundup',
            });
          }
        }
      }
    }

    console.log(`    Extracted ${reviews.length} reviews from HTML fallback`);
  }

  return reviews;
}

/**
 * Map outlet name to standardized outlet info
 */
function mapOutlet(outletName) {
  const normalized = outletName.toLowerCase().trim();

  const outletMap = {
    'new york times': { outlet: 'The New York Times', outletId: 'nytimes' },
    'the new york times': { outlet: 'The New York Times', outletId: 'nytimes' },
    'nytimes': { outlet: 'The New York Times', outletId: 'nytimes' },
    'vulture': { outlet: 'Vulture', outletId: 'vulture' },
    'variety': { outlet: 'Variety', outletId: 'variety' },
    'hollywood reporter': { outlet: 'The Hollywood Reporter', outletId: 'THR' },
    'the hollywood reporter': { outlet: 'The Hollywood Reporter', outletId: 'THR' },
    'time out': { outlet: 'Time Out New York', outletId: 'TIMEOUT' },
    'time out new york': { outlet: 'Time Out New York', outletId: 'TIMEOUT' },
    'timeout': { outlet: 'Time Out New York', outletId: 'TIMEOUT' },
    'guardian': { outlet: 'The Guardian', outletId: 'GUARDIAN' },
    'the guardian': { outlet: 'The Guardian', outletId: 'GUARDIAN' },
    'associated press': { outlet: 'Associated Press', outletId: 'AP' },
    'ap': { outlet: 'Associated Press', outletId: 'AP' },
    'theatermania': { outlet: 'TheaterMania', outletId: 'TMAN' },
    'broadwayworld': { outlet: 'BroadwayWorld', outletId: 'BWW' },
    'broadway world': { outlet: 'BroadwayWorld', outletId: 'BWW' },
    'daily news': { outlet: 'New York Daily News', outletId: 'NYDN' },
    'new york daily news': { outlet: 'New York Daily News', outletId: 'NYDN' },
    'new york post': { outlet: 'New York Post', outletId: 'NYP' },
    'ny post': { outlet: 'New York Post', outletId: 'NYP' },
    'post': { outlet: 'New York Post', outletId: 'NYP' },
    'deadline': { outlet: 'Deadline', outletId: 'DEADLINE' },
    'the wrap': { outlet: 'The Wrap', outletId: 'WRAP' },
    'wrap': { outlet: 'The Wrap', outletId: 'WRAP' },
    'entertainment weekly': { outlet: 'Entertainment Weekly', outletId: 'EW' },
    'ew': { outlet: 'Entertainment Weekly', outletId: 'EW' },
    'usa today': { outlet: 'USA Today', outletId: 'USAT' },
    'newsday': { outlet: 'Newsday', outletId: 'NEWSDAY' },
    'wall street journal': { outlet: 'Wall Street Journal', outletId: 'WSJ' },
    'wsj': { outlet: 'Wall Street Journal', outletId: 'WSJ' },
    'chicago tribune': { outlet: 'Chicago Tribune', outletId: 'CHITRIB' },
    'nbc new york': { outlet: 'NBC New York', outletId: 'NBCNY' },
    'am new york': { outlet: 'AM New York', outletId: 'AMNY' },
    'new yorker': { outlet: 'The New Yorker', outletId: 'NYER' },
    'the new yorker': { outlet: 'The New Yorker', outletId: 'NYER' },
    'huffington post': { outlet: 'Huffington Post', outletId: 'HUFFPO' },
    'dc theatre scene': { outlet: 'DC Theatre Scene', outletId: 'DCTHSCN' },
  };

  for (const [key, value] of Object.entries(outletMap)) {
    if (normalized.includes(key)) {
      return value;
    }
  }

  return null;
}

/**
 * Archive BWW page
 */
function archiveBWWPage(showId, url, html) {
  const archivePath = path.join(ARCHIVE_DIR, `${showId}.html`);
  const header = `<!--
  Archived: ${new Date().toISOString()}
  Source: ${url}
  Status: 200
-->\n`;

  fs.writeFileSync(archivePath, header + html);
  console.log(`    Archived to ${archivePath}`);
}

/**
 * Save review to review-texts directory
 */
function saveReview(review) {
  const showDir = path.join(REVIEW_TEXTS_DIR, review.showId);
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  const criticSlug = slugify(review.criticName || 'unknown');
  const outletSlug = review.outletId.toLowerCase();
  const filename = `${outletSlug}--${criticSlug}.json`;
  const filepath = path.join(showDir, filename);

  // Check if file exists
  if (fs.existsSync(filepath)) {
    // Read existing and merge BWW data
    const existing = JSON.parse(fs.readFileSync(filepath, 'utf8'));

    let updated = false;
    if (!existing.bwwExcerpt && review.bwwExcerpt) {
      existing.bwwExcerpt = review.bwwExcerpt;
      updated = true;
    }
    if (!existing.bwwRoundupUrl && review.bwwRoundupUrl) {
      existing.bwwRoundupUrl = review.bwwRoundupUrl;
      updated = true;
    }

    if (updated) {
      fs.writeFileSync(filepath, JSON.stringify(existing, null, 2));
      console.log(`      Updated ${filename} with BWW data`);
      return { created: false, updated: true };
    } else {
      console.log(`      Skipped ${filename} (already has BWW data)`);
      return { created: false, updated: false };
    }
  }

  // Create new file
  const reviewData = {
    showId: review.showId,
    outletId: review.outletId,
    outlet: review.outlet,
    criticName: review.criticName,
    url: review.url,
    publishDate: null,
    fullText: null,
    isFullReview: false,
    bwwExcerpt: review.bwwExcerpt,
    bwwRoundupUrl: review.bwwRoundupUrl,
    originalScore: null,
    assignedScore: null,
    source: 'bww-roundup',
    dtliThumb: null,
    needsScoring: true,
  };

  fs.writeFileSync(filepath, JSON.stringify(reviewData, null, 2));
  console.log(`      Created ${filename}`);
  return { created: true, updated: false };
}

/**
 * Process a single show
 */
async function processShow(show) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing: ${show.title} (${show.id})`);
  console.log('='.repeat(60));

  // Check if we have an archive
  const archivePath = path.join(ARCHIVE_DIR, `${show.id}.html`);
  let html = null;
  let bwwUrl = null;

  if (fs.existsSync(archivePath)) {
    console.log(`  Using archived page...`);
    const archiveContent = fs.readFileSync(archivePath, 'utf8');
    // Extract URL from archive header
    const urlMatch = archiveContent.match(/Source:\s*(https?:\/\/[^\n]+)/);
    if (urlMatch) {
      bwwUrl = urlMatch[1].trim();
    }
    html = archiveContent;
  } else {
    // Search for roundup article
    const result = await searchBWWRoundup(show);
    if (!result) {
      return { success: false, error: 'Not found on BWW' };
    }
    html = result.html;
    bwwUrl = result.url;

    // Archive the page
    archiveBWWPage(show.id, bwwUrl, html);
  }

  // Extract reviews
  const reviews = extractBWWReviews(html, show.id, bwwUrl);

  // Save reviews
  let created = 0;
  let updated = 0;

  for (const review of reviews) {
    const result = saveReview(review);
    if (result.created) created++;
    if (result.updated) updated++;
  }

  console.log(`\n  Summary: ${reviews.length} reviews found, ${created} created, ${updated} updated`);

  return {
    success: true,
    showId: show.id,
    reviewsFound: reviews.length,
    created,
    updated,
  };
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const showArg = args.find(a => a.startsWith('--show='));
  const showsArg = args.find(a => a.startsWith('--shows='));
  const allHistorical = args.includes('--all-historical');

  const shows = loadShows();
  let showsToProcess = [];

  if (showArg) {
    const showId = showArg.replace('--show=', '');
    const show = shows.find(s => s.id === showId);
    if (!show) {
      console.error(`Show not found: ${showId}`);
      process.exit(1);
    }
    showsToProcess = [show];
  } else if (showsArg) {
    const showIds = showsArg.replace('--shows=', '').split(',').map(s => s.trim());
    for (const showId of showIds) {
      const show = shows.find(s => s.id === showId);
      if (show) {
        showsToProcess.push(show);
      } else {
        console.warn(`Warning: Show not found: ${showId}`);
      }
    }
  } else if (allHistorical) {
    showsToProcess = shows.filter(s => s.tags?.includes('historical') || s.status === 'closed');
  } else {
    console.log('Usage:');
    console.log('  node scripts/scrape-bww-roundups.js --show=show-id');
    console.log('  node scripts/scrape-bww-roundups.js --shows=show1,show2,show3');
    console.log('  node scripts/scrape-bww-roundups.js --all-historical');
    process.exit(1);
  }

  console.log('========================================');
  console.log('BWW Review Roundup Scraper');
  console.log('========================================');
  console.log(`Shows to process: ${showsToProcess.length}`);

  const results = [];

  for (const show of showsToProcess) {
    const result = await processShow(show);
    results.push(result);
    await sleep(1000); // Rate limiting
  }

  // Final summary
  console.log('\n========================================');
  console.log('FINAL SUMMARY');
  console.log('========================================');

  let totalFound = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let notFound = 0;

  for (const r of results) {
    if (r.success) {
      console.log(`✓ ${r.showId}: ${r.reviewsFound} reviews (${r.created} new, ${r.updated} updated)`);
      totalFound += r.reviewsFound;
      totalCreated += r.created;
      totalUpdated += r.updated;
    } else {
      console.log(`✗ ${r.showId || 'unknown'}: ${r.error}`);
      notFound++;
    }
  }

  console.log(`\nTotal: ${totalFound} reviews found, ${totalCreated} created, ${totalUpdated} updated`);
  console.log(`Shows not found on BWW: ${notFound}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
