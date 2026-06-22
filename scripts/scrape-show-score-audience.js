#!/usr/bin/env node
/**
 * Scrape Show Score audience data and update audience-buzz.json
 *
 * Uses a fallback chain to fetch Show Score pages and extract audience scores:
 * 1. ScrapingBee (primary — render_js + premium_proxy for SPA content)
 * 2. Playwright (fallback — native JS rendering, no API credits needed)
 * 3. Bright Data Web Unlocker (last resort — may not render JS fully)
 *
 * Designed to run in GitHub Actions.
 *
 * Usage:
 *   node scripts/scrape-show-score-audience.js [--show=hamilton-2015] [--limit=10] [--dry-run]
 *
 * Environment variables:
 *   SCRAPINGBEE_API_KEY - ScrapingBee API key (primary, optional)
 *   BRIGHTDATA_TOKEN    - Bright Data API token (fallback, optional)
 *   At least one scraping method must be available (or Playwright installed).
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { JSDOM } = require('jsdom');
const { calculateCombinedScore, getDesignation } = require('./lib/audience-weighting');
const { validatePageMatchesShow } = require('./lib/page-validator');
const { isLondonMarket } = require('./lib/venue-classification');

// Lazy-load Playwright — only imported if needed as fallback
let playwrightBrowser = null;
let playwrightUnavailable = false; // Cache permanent failures (missing binaries)
async function getPlaywrightBrowser() {
  if (playwrightUnavailable) return null;
  if (playwrightBrowser) return playwrightBrowser;
  try {
    const { chromium } = require('playwright');
    playwrightBrowser = await chromium.launch({ headless: true });
    return playwrightBrowser;
  } catch (e) {
    const msg = e.message || '';
    // Missing binaries = permanent failure, don't retry every call
    if (msg.includes("Executable doesn't exist") || msg.includes('MODULE_NOT_FOUND')) {
      console.error(`  Playwright permanently unavailable: ${msg.split('\n')[0]}`);
      playwrightUnavailable = true;
    } else {
      console.error(`  Playwright unavailable: ${msg}`);
    }
    return null;
  }
}
async function cleanupPlaywright() {
  if (playwrightBrowser) {
    await playwrightBrowser.close();
    playwrightBrowser = null;
  }
}

// Parse command line args
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const showsArg = args.find(a => a.startsWith('--shows='))?.split('=')[1];
const limitArg = args.find(a => a.startsWith('--limit='));
const showLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const includeAll = args.includes('--all');
const shardArg = args.find(a => a.startsWith('--shard='));
const totalShardsArg = args.find(a => a.startsWith('--total-shards='));
const shard = shardArg ? parseInt(shardArg.split('=')[1]) : null;
const totalShards = totalShardsArg ? parseInt(totalShardsArg.split('=')[1]) : null;
const shardMode = shard !== null && totalShards !== null;

// Config
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

// Paths
const showsPath = path.join(__dirname, '../data/shows.json');
const urlsPath = path.join(__dirname, '../data/show-score-urls.json');
const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');
const showScorePath = path.join(__dirname, '../data/show-score.json');

// Load data
const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const showMapById = {};
for (const s of showsData.shows) showMapById[s.id] = s;

// Build multi-production lookup: for each title base, find the most recent production
// that has actually started performances. ShowScore sometimes has separate pages per
// production (e.g. /sunset-boulevard = 2017, /sunset-boulevard-broadway = 2024).
// When only ONE page exists, only the newest production gets the data.
// Exclude shows whose previews haven't started — they can't have real audience data.
const today = new Date().toISOString().split('T')[0];
const mostRecentByTitle = {};
for (const s of showsData.shows) {
  const previewDate = s.previewsStartDate || s.openingDate;
  if (previewDate && previewDate > today) continue; // Skip future shows
  const titleBase = s.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\(.*?\)\s*$/, '').trim();
  const existing = mostRecentByTitle[titleBase];
  if (!existing || (s.openingDate || '') > (existing.openingDate || '')) {
    mostRecentByTitle[titleBase] = s;
  }
}

/**
 * Check if this show is the most recent production of its title.
 */
function isMostRecentProduction(show) {
  const titleBase = show.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\(.*?\)\s*$/, '').trim();
  const newest = mostRecentByTitle[titleBase];
  return !newest || newest.id === show.id;
}

/**
 * Get the newest production's cached URL for this show's title.
 * Returns null if the show IS the newest or if the newest has no cached URL.
 */
function getNewestProductionUrl(show) {
  if (isMostRecentProduction(show)) return null;
  const titleBase = show.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\(.*?\)\s*$/, '').trim();
  const newestShow = mostRecentByTitle[titleBase];
  return newestShow ? getCachedUrl(newestShow.id) : null;
}
const urlData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
const audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));
const showScoreData = JSON.parse(fs.readFileSync(showScorePath, 'utf8'));

// Max new URL discoveries per run to avoid rate-limit avalanche
// In shard mode (bulk backfill), raise cap significantly
const MAX_DISCOVERIES = shardMode ? 100 : 10;
// Cooldown before retrying discovery for a show (7 days, disabled in shard mode)
const DISCOVERY_COOLDOWN_MS = shardMode ? 0 : 7 * 24 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch URL through ScrapingBee (single attempt).
 * Returns HTML string or throws on failure. Returns null if no API key.
 */
function fetchViaScrapingBeeSingle(url) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_KEY) {
      resolve(null); // No key — skip gracefully
      return;
    }

    // premium_proxy dropped 2026-06-21: it costs 25 credits (~$2.48/1k) — MORE than
    // Bright Data ($1.50/1k) — and render_js alone fetches Show Score fine (verified
    // live: page returns full content + title without premium). render_js=true is
    // still required (Show Score is a React SPA). Bright Data remains the fallback
    // in fetchWithFallback() below for the rare case render-only is blocked.
    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=true&wait=3000`;

    https.get(apiUrl, { timeout: 60000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`ScrapingBee HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject)
      .on('timeout', () => reject(new Error('ScrapingBee request timeout')));
  });
}

/**
 * Fetch URL through Playwright (renders JS natively).
 * Returns HTML string or null on failure.
 */
async function fetchViaPlaywright(url) {
  const browser = await getPlaywrightBrowser();
  if (!browser) return null;

  try {
    const page = await browser.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      // Show Score is an SPA — wait a bit for content to render
      await page.waitForTimeout(3000);
      const html = await page.content();
      return html;
    } finally {
      await page.close();
    }
  } catch (error) {
    console.error(`  Playwright failed: ${error.message}`);
    // Reset browser if it's in a bad state so next call relaunches
    if (playwrightBrowser) {
      try { await playwrightBrowser.close(); } catch (_) {}
      playwrightBrowser = null;
    }
    return null;
  }
}

/**
 * Fetch URL through Bright Data Web Unlocker.
 * Returns HTML string or null on failure.
 * Note: Web Unlocker may not fully render JS-heavy SPAs like Show Score.
 */
function fetchViaBrightData(url) {
  const token = process.env.BRIGHTDATA_TOKEN;
  if (!token) return Promise.resolve(null);

  const zone = process.env.BRIGHTDATA_ZONE || 'mcp_unlocker';
  const apiUrl = 'https://api.brightdata.com/request';
  const body = JSON.stringify({ zone, url, format: 'raw' });

  return new Promise((resolve, reject) => {
    const req = https.request(apiUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`BrightData HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => reject(new Error('BrightData request timeout')));
    req.end(body);
  }).catch(error => {
    console.error(`  BrightData failed: ${error.message}`);
    return null;
  });
}

/**
 * Fetch URL with fallback chain and retry logic.
 * Chain: ScrapingBee (premium) → Playwright → Bright Data
 * Returns HTML string or throws if all methods fail.
 */
async function fetchWithFallback(url, retries = 2) {
  // Try ScrapingBee first (with retries) — best for Show Score (render_js + premium_proxy)
  if (SCRAPINGBEE_KEY) {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      try {
        const html = await fetchViaScrapingBeeSingle(url);
        if (html) return html;
        break; // null = no key, skip retries
      } catch (error) {
        if (attempt > retries) {
          if (verbose) console.log(`  ScrapingBee exhausted after ${retries + 1} attempts: ${error.message}`);
          break; // Fall through to next provider
        }
        const delay = 5000 * attempt;
        if (verbose) console.log(`  ScrapingBee retry ${attempt}/${retries} in ${delay / 1000}s: ${error.message}`);
        await sleep(delay);
      }
    }
  }

  // Playwright fallback — renders JS natively, no API credits
  if (verbose) console.log('  Falling back to Playwright...');
  const pwHtml = await fetchViaPlaywright(url);
  if (pwHtml) return pwHtml;

  // Bright Data last resort — may not render SPA content fully
  if (verbose) console.log('  Falling back to BrightData...');
  const bdHtml = await fetchViaBrightData(url);
  if (bdHtml) return bdHtml;

  throw new Error('All scraping methods failed for ' + url);
}

/**
 * Slugify a show title for Show Score URL patterns
 */
function slugifyTitle(title) {
  return title
    .toLowerCase()
    .replace(/&/g, '')           // Drop ampersand
    .replace(/['']/g, '-')       // Apostrophes → hyphen
    .replace(/[:.!?,()]/g, '')   // Drop punctuation
    .replace(/\s+/g, '-')        // Spaces → hyphens
    .replace(/-+/g, '-')         // Collapse multiple hyphens
    .replace(/^-|-$/g, '');      // Trim leading/trailing hyphens
}

/**
 * Generate candidate Show Score URLs for a show
 */
function generateCandidateUrls(show) {
  const titleSlug = slugifyTitle(show.title);
  const titleNoColon = show.title.replace(/:.*$/, '').trim();
  const titleNoColonSlug = slugifyTitle(titleNoColon);
  const showSlug = (show.slug || show.id).replace(/-\d{4}$/, '');
  const isMusical = show.type === 'musical' ||
    (show.tags && show.tags.some(t => /musical/i.test(t)));
  const isOffBroadway = show.category === 'off-broadway';
  const isWestEnd = isLondonMarket(show.category);

  const candidates = [];

  // Try without leading "the-" (SeatPlan/LBO pattern — sites often drop articles)
  const titleNoThe = titleSlug.startsWith('the-') ? titleSlug.replace(/^the-/, '') : null;
  const titleNoMusical = titleSlug.endsWith('-the-musical') ? titleSlug.replace(/-the-musical$/, '') : null;

  if (isWestEnd) {
    // West End: try -west-end and -london suffixes
    candidates.push(
      `${titleSlug}-west-end`,
      `${titleSlug}-london`,
      `${titleNoColonSlug}-west-end`,
      `${titleNoColonSlug}-london`,
      `${showSlug.replace(/-west-end$/, '')}-west-end`,
      `${showSlug.replace(/-west-end$/, '')}-london`,
    );
    if (titleNoThe) {
      candidates.push(`${titleNoThe}-west-end`, `${titleNoThe}-london`);
    }
    if (titleNoMusical) {
      candidates.push(`${titleNoMusical}-west-end`, `${titleNoMusical}-london`);
    }
    if (isMusical) {
      candidates.push(
        `${titleSlug}-the-musical-west-end`,
        `${titleSlug}-the-musical-london`,
      );
    }
    candidates.push(titleSlug, showSlug.replace(/-west-end$/, ''));
  } else if (isOffBroadway) {
    // Off-Broadway: no -broadway suffix needed
    // NOTE: OB slugs are unpredictable (often include venue name like "heathers-the-musical-new-world-stages").
    // Primary discovery is via listings scraping (discover-show-score-urls-from-listings.js).
    // This slug-based fallback only covers simple cases.
    candidates.push(titleSlug, titleNoColonSlug, showSlug);
    if (isMusical) {
      candidates.push(`${titleSlug}-the-musical`, `${titleNoColonSlug}-the-musical`);
    }
  } else {
    candidates.push(
      `${titleSlug}-broadway`,
      `${titleNoColonSlug}-broadway`,
      `${showSlug}-broadway`,
    );
    if (titleNoThe) {
      candidates.push(`${titleNoThe}-broadway`);
    }
    if (titleNoMusical) {
      candidates.push(`${titleNoMusical}-broadway`);
    }
    if (isMusical) {
      candidates.push(
        `${titleSlug}-the-musical-broadway`,
        `${titleNoColonSlug}-the-musical-broadway`,
      );
    }
    candidates.push(titleSlug, showSlug);
  }

  // URL base depends on category
  const base = isWestEnd
    ? 'https://www.show-score.com/uk/london/west-end-shows'
    : isOffBroadway
      ? 'https://www.show-score.com/off-broadway-shows'
      : 'https://www.show-score.com/broadway-shows';

  // Deduplicate while preserving order
  return [...new Set(candidates)].map(slug => `${base}/${slug}`);
}

/**
 * Normalize a title for fuzzy comparison (strip parenthetical suffixes, punctuation, etc.)
 */
function normalizeTitle(title) {
  return (title || '')
    .toLowerCase()
    .replace(/\s*\(broadway\)\s*/i, '')      // Strip "(Broadway)"
    .replace(/\s*\(london\)\s*/i, '')        // Strip "(London)"
    .replace(/\s*\(west end\)\s*/i, '')      // Strip "(West End)"
    .replace(/\s*\(.*?\)\s*$/, '')           // Strip trailing parenthetical
    .replace(/[''":,.!?]/g, '')              // Strip punctuation
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check if a JSON-LD page title matches the show we're looking for.
 * Prevents listings-page contamination (where Hamilton appears as first result).
 */
function titlesMatch(jsonLdName, showTitle) {
  const a = normalizeTitle(jsonLdName);
  const b = normalizeTitle(showTitle);
  if (!a || !b) return false;
  // Exact match after normalization
  if (a === b) return true;
  // One contains the other (handles subtitles like "Sweeney Todd: The Demon Barber...")
  if (a.includes(b) || b.includes(a)) return true;
  // Check first significant word match (handles "The" prefix variations)
  const aWords = a.replace(/^the /, '').split(' ');
  const bWords = b.replace(/^the /, '').split(' ');
  if (aWords[0] === bWords[0] && aWords[0].length > 3) return true;
  return false;
}

/**
 * Extract JSON-LD name from HTML
 */
function extractJsonLdName(html) {
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (!jsonLdMatch) return null;
  for (const match of jsonLdMatch) {
    try {
      const content = match.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
      const data = JSON.parse(content);
      if (data.aggregateRating && data.name) return data.name;
    } catch (e) { /* skip */ }
  }
  return null;
}

/**
 * Validate that HTML is a valid Show Score Broadway show page with audience data.
 * @param {string} html - Page HTML
 * @param {string} url - Page URL
 * @param {string} [showTitle] - Expected show title (for title validation)
 */
function isValidShowScorePage(html, url, showTitle, options = {}) {
  const { allowOffBroadway = false, allowWestEnd = false } = options;
  if (!html) return false;
  // Not a 404
  if (html.includes('Page not found') || html.includes('404 -')) return false;
  // Not the homepage
  if (html.includes('<title>Show Score | NYC Theatre Reviews and Tickets</title>')) return false;
  // Always reject off-off-broadway
  if (url.includes('/off-off-broadway-shows/')) return false;
  // Reject off-broadway unless show is off-broadway
  if (!allowOffBroadway && url.includes('/off-broadway-shows/')) return false;
  // Reject london/west-end shows unless show is west-end
  if (!allowWestEnd && (url.includes('/london-shows/') || url.includes('/west-end-shows/'))) return false;
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const match of jsonLdMatch) {
      try {
        const content = match.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
        const data = JSON.parse(content);
        if (data.aggregateRating && typeof data.aggregateRating.ratingValue === 'number') {
          // Check canonical URL isn't off-off-broadway (always rejected)
          if (data.url && /\/off-off-broadway-shows\//.test(data.url)) {
            if (verbose) console.log(`    Rejected: canonical URL is off-off-broadway (${data.url})`);
            return false;
          }
          // Reject off-broadway canonical unless show is off-broadway
          if (!allowOffBroadway && data.url && /\/off-broadway-shows\//.test(data.url)) {
            if (verbose) console.log(`    Rejected: canonical URL is off-broadway (${data.url})`);
            return false;
          }
          // Reject london/west-end-shows canonical unless show is west-end
          if (!allowWestEnd && data.url && (/\/london-shows\//.test(data.url) || /\/west-end-shows\//.test(data.url))) {
            if (verbose) console.log(`    Rejected: canonical URL is west-end-shows (${data.url})`);
            return false;
          }
          // Title validation: reject if page is for a different show (listings page redirect)
          if (showTitle && data.name && !titlesMatch(data.name, showTitle)) {
            if (verbose) console.log(`    Rejected: title mismatch — page="${data.name}", expected="${showTitle}"`);
            return false;
          }
          return true;
        }
      } catch (e) { /* skip */ }
    }
  }
  return false;
}

/**
 * Discover Show Score URL for a show by trying candidate patterns
 */
async function discoverShowScoreUrl(show) {
  // For older productions, only discover if the newest already has a URL
  // (so we can ensure we find a DIFFERENT page, not the same one)
  let newestUrl = null;
  if (!isMostRecentProduction(show)) {
    newestUrl = getNewestProductionUrl(show);
    if (!newestUrl) {
      console.log(`  SKIP discovery: ${show.id} — newest production not yet discovered`);
      return null;
    }
    console.log(`  Older production — looking for own page (newest uses: ${newestUrl})`);
  }

  const candidates = generateCandidateUrls(show);
  if (verbose) console.log(`  Trying ${candidates.length} URL patterns...`);

  for (const url of candidates) {
    // For older productions, skip URLs already claimed by any other show
    if (newestUrl) {
      if (url === newestUrl) {
        if (verbose) console.log(`  Skip: ${url} (same as newest production)`);
        continue;
      }
      // Also skip if another show already has this URL cached (prevents 3+ production dupes)
      const existingOwner = Object.entries(urlData.shows || {}).find(([id, u]) => u === url && id !== show.id);
      if (existingOwner) {
        if (verbose) console.log(`  Skip: ${url} (already cached for ${existingOwner[0]})`);
        continue;
      }
    }
    try {
      if (verbose) console.log(`  Trying: ${url}`);
      const html = await fetchWithFallback(url, 0); // No retries during discovery
      if (isValidShowScorePage(html, url, show.title, { allowOffBroadway: show.category === 'off-broadway', allowWestEnd: isLondonMarket(show.category) })) {
        // Additional heading-based validation with LLM tiebreaker
        const pageValidation = await validatePageMatchesShow(html, show.title, { openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null });
        if (!pageValidation.valid) {
          console.log(`  ✗ Page validator rejected: ${pageValidation.reason}`);
          continue;
        }
        console.log(`  ✓ Discovered: ${url}`);
        return url;
      }
    } catch (error) {
      if (verbose) console.log(`    ${error.message}`);
    }
    await sleep(2000); // Rate limit between discovery attempts
  }
  return null;
}

/**
 * Save URL cache to disk (incremental persist)
 */
function saveUrlCache() {
  urlData._meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(urlsPath, JSON.stringify(urlData, null, 2) + '\n');
}

/**
 * Extract audience data from Show Score HTML
 */
function extractAudienceData(html, showId) {
  const result = {
    score: null,
    reviewCount: null,
  };

  // Method 1: Extract from JSON-LD (most reliable)
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const match of jsonLdMatch) {
      try {
        const jsonContent = match.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
        const data = JSON.parse(jsonContent);
        if (data.aggregateRating) {
          result.score = data.aggregateRating.ratingValue;
          result.reviewCount = data.aggregateRating.reviewCount;
          break;
        }
      } catch (e) {
        // Skip invalid JSON-LD
      }
    }
  }

  // Method 2: Fallback - look for score in page content
  if (!result.score) {
    // Show Score displays the score prominently, try to find it
    const scoreMatch = html.match(/class="[^"]*score[^"]*"[^>]*>(\d+)%?</i) ||
                       html.match(/>(\d{2,3})%?\s*<[^>]*class="[^"]*score/i);
    if (scoreMatch) {
      result.score = parseInt(scoreMatch[1]);
    }
  }

  // Method 3: Look for review count
  if (!result.reviewCount) {
    const countMatch = html.match(/(\d{1,3}(?:,\d{3})*)\s*(?:member\s*)?reviews?/i) ||
                       html.match(/reviewCount['"]\s*:\s*(\d+)/i);
    if (countMatch) {
      result.reviewCount = parseInt(countMatch[1].replace(/,/g, ''));
    }
  }

  return result;
}

/**
 * Extract metadata (runtime, synopsis) from Show Score HTML via JSDOM.
 * Returns { runtime: string|null, synopsis: string|null }.
 */
function extractMetadata(html) {
  const result = { runtime: null, synopsis: null };

  try {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    // ── Runtime extraction ──
    // Show Score displays "1h 40m" or "2h" in the show header area.
    // Uses non-word-boundary pattern to handle concatenated text from SPA spans.
    // Negative lookahead excludes "Xh ago" timestamps.
    const runtimePattern = /(?:^|[^a-zA-Z])(\d{1,2})\s*h(?:r?s?)?\s*(?:(\d{1,2})\s*m(?:in)?)?(?!\s*ago)/i;
    const runtimePatternMinOnly = /(?:^|[^a-zA-Z])(\d{2,3})\s*min(?:ute)?s?/i;

    function parseRuntime(text) {
      const match = text.match(runtimePattern);
      if (match) {
        const hours = parseInt(match[1]);
        const mins = match[2] ? parseInt(match[2]) : 0;
        if (hours >= 1 && hours <= 5 && mins >= 0 && mins < 60) {
          return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
        }
      }
      const minMatch = text.match(runtimePatternMinOnly);
      if (minMatch) {
        const totalMins = parseInt(minMatch[1]);
        if (totalMins >= 30 && totalMins <= 300) {
          const h = Math.floor(totalMins / 60);
          const m = totalMins % 60;
          return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${totalMins}m`;
        }
      }
      return null;
    }

    // Check individual child spans in header elements (handles SPA-rendered spans)
    const headerCandidates = doc.querySelectorAll('h1, h2, [class*="detail"], [class*="header"], [class*="info"], [class*="show"], [class*="meta"]');
    for (const el of headerCandidates) {
      for (const child of el.querySelectorAll('span, div, p, a, li')) {
        const childText = child.textContent || '';
        if (childText.length > 2 && childText.length < 30) {
          const rt = parseRuntime(childText);
          if (rt) { result.runtime = rt; break; }
        }
      }
      if (result.runtime) break;
      const text = el.textContent || '';
      const rt = parseRuntime(text);
      if (rt) { result.runtime = rt; break; }
    }

    // Fallback: scan first 5000 chars of body text
    if (!result.runtime) {
      const bodyText = (doc.body?.textContent || '').slice(0, 5000);
      result.runtime = parseRuntime(bodyText);
    }

    // ── Synopsis extraction ──
    // Show Score structure: <div class="about-header"><h2>About the Show</h2></div>
    // followed by <div class="about"><p>...</p></div> (sibling of heading's parent).
    const headings = doc.querySelectorAll('h2, h3');
    for (const heading of headings) {
      const headingText = (heading.textContent || '').trim().toLowerCase();
      if (headingText === 'about the show' || headingText === 'about this show') {
        const container = heading.parentElement;

        // Strategy 1: paragraphs in the heading's own parent
        if (container) {
          const paragraphs = container.querySelectorAll('p');
          const texts = Array.from(paragraphs)
            .map(p => (p.textContent || '').trim())
            .filter(t => t.length > 10);
          if (texts.length > 0) {
            let synopsis = texts.join(' ').trim();
            if (synopsis.length > 800) synopsis = synopsis.slice(0, 797) + '...';
            result.synopsis = synopsis;
            break;
          }
        }

        // Strategy 2: heading's parent's next siblings (Show Score's actual pattern)
        if (!result.synopsis && container) {
          let parentSibling = container.nextElementSibling;
          let checked = 0;
          while (parentSibling && !result.synopsis && checked < 3) {
            const paragraphs = parentSibling.querySelectorAll('p');
            const texts = Array.from(paragraphs)
              .map(p => (p.textContent || '').trim())
              .filter(t => t.length > 10);
            if (texts.length > 0) {
              let synopsis = texts.join(' ').trim();
              if (synopsis.length > 800) synopsis = synopsis.slice(0, 797) + '...';
              result.synopsis = synopsis;
              break;
            }
            const sibText = (parentSibling.textContent || '').trim();
            if (sibText.length > 20) {
              let synopsis = sibText;
              if (synopsis.length > 800) synopsis = synopsis.slice(0, 797) + '...';
              result.synopsis = synopsis;
              break;
            }
            parentSibling = parentSibling.nextElementSibling;
            checked++;
          }
        }

        // Strategy 3: heading's own next siblings (generic fallback)
        if (!result.synopsis) {
          let sibling = heading.nextElementSibling;
          while (sibling && !result.synopsis) {
            const text = (sibling.textContent || '').trim();
            if (text.length > 20) {
              let synopsis = text;
              if (synopsis.length > 800) synopsis = synopsis.slice(0, 797) + '...';
              result.synopsis = synopsis;
            }
            sibling = sibling.nextElementSibling;
            if (sibling && sibling.tagName && /^H[1-6]$/.test(sibling.tagName)) break;
          }
        }
        break;
      }
    }

    dom.window.close();
  } catch (e) {
    if (verbose) console.log(`  Metadata extraction error: ${e.message}`);
  }

  return result;
}

/**
 * Get cached Show Score URL for a show (cache-only, no discovery)
 */
function getCachedUrl(showId) {
  if (urlData.shows && urlData.shows[showId]) {
    return urlData.shows[showId];
  }
  return null;
}

/**
 * Process a single show (cache-only — URL must already be in show-score-urls.json)
 */
async function processShow(show) {
  // Multi-production guard: older productions only processed if they have their own page
  if (!isMostRecentProduction(show)) {
    const myUrl = getCachedUrl(show.id);
    const newestUrl = getNewestProductionUrl(show);
    if (!myUrl) {
      if (verbose) console.log(`\n  SKIP: ${show.id} — older production, no own ShowScore page`);
      return null;
    }
    if (newestUrl && myUrl === newestUrl) {
      console.log(`\n  SKIP: ${show.id} — same URL as newest production, removing duplicate`);
      if (urlData.shows) delete urlData.shows[show.id];
      if (!dryRun) saveUrlCache();
      return null;
    }
    console.log(`\n  ${show.id}: older production with own ShowScore page`);
  }

  const url = getCachedUrl(show.id);
  if (!url) {
    if (verbose) console.log(`\n  SKIP: ${show.title} — no cached URL`);
    return null;
  }

  console.log(`\nProcessing: ${show.title}`);
  console.log(`  URL: ${url}`);

  try {
    const html = await fetchWithFallback(url);

    // Validate page
    if (!html || html.includes('Page not found') || html.includes('404 -')) {
      console.log(`  SKIP: Show not found on Show Score`);
      return null;
    }

    if (!html.includes('show-score.com') && !html.includes('Show Score')) {
      console.log(`  SKIP: Page doesn't appear to be Show Score`);
      return null;
    }

    // Title validation: reject if page is for a different show
    const jsonLdName = extractJsonLdName(html);
    if (jsonLdName && !titlesMatch(jsonLdName, show.title)) {
      console.log(`  SKIP: Title mismatch — page="${jsonLdName}", expected="${show.title}"`);
      console.log(`  Removing bad cached URL for ${show.id}`);
      if (urlData.shows) delete urlData.shows[show.id];
      if (!dryRun) saveUrlCache();
      return null;
    }

    // Additional heading-based validation with LLM tiebreaker
    const pageValidation = await validatePageMatchesShow(html, show.title, { openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null });
    if (!pageValidation.valid) {
      console.log(`  SKIP: Page validator rejected — ${pageValidation.reason}`);
      console.log(`  Removing bad cached URL for ${show.id}`);
      if (urlData.shows) delete urlData.shows[show.id];
      if (!dryRun) saveUrlCache();
      return null;
    }

    const data = extractAudienceData(html, show.id);
    const metadata = extractMetadata(html);

    if (metadata.runtime) console.log(`  Runtime: ${metadata.runtime}`);
    if (metadata.synopsis) console.log(`  Synopsis: ${metadata.synopsis.slice(0, 80)}...`);

    if (!data.score && !metadata.runtime && !metadata.synopsis) {
      // Distinguish between "page exists but has no data" (Show-Score broken) vs truly empty
      const hasPageStructure = html.includes('show-page') || html.includes('aggregateRating') || html.includes('show-score.com');
      if (hasPageStructure) {
        console.log(`  SKIP: Page loaded but no data extracted (Show-Score may not be displaying reviews)`);
      } else {
        console.log(`  SKIP: No audience score or metadata found`);
      }
      return null;
    }

    if (data.score) {
      console.log(`  Score: ${data.score}%, Reviews: ${data.reviewCount || 'unknown'}`);
    }

    return {
      score: data.score,
      reviewCount: data.reviewCount || 0,
      metadata,
    };

  } catch (error) {
    console.error(`  ERROR: ${error.message}`);
    return null;
  }
}

// calculateCombinedScore imported from ./lib/audience-weighting.js

/**
 * Update audience-buzz.json with Show Score data
 */
function updateAudienceBuzz(showId, showTitle, showScoreData) {
  // Initialize show entry if it doesn't exist
  if (!audienceBuzz.shows[showId]) {
    audienceBuzz.shows[showId] = {
      title: showTitle,
      designation: null,
      combinedScore: null,
      sources: {
        showScore: null,
        mezzanine: null,
        reddit: null,
        theatr: null,
      }
    };
  }

  // Update Show Score data
  audienceBuzz.shows[showId].sources.showScore = {
    score: showScoreData.score,
    reviewCount: showScoreData.reviewCount,
  };

  // Recalculate combined score with dynamic weighting
  const sources = audienceBuzz.shows[showId].sources;
  const sd = showMapById[showId];
  const showInfo = sd ? { closingDate: sd.closingDate, status: sd.status, category: sd.category } : undefined;
  const { score, weights } = calculateCombinedScore(sources, showInfo);

  if (score !== null) {
    audienceBuzz.shows[showId].combinedScore = score;

    audienceBuzz.shows[showId].designation = getDesignation(score);

    // Log the weights used
    if (verbose) {
      console.log(`  Weights: SS ${weights.showScore}%, Mezz ${weights.mezzanine}%, Reddit ${weights.reddit}%, Theatr ${weights.theatr}%`);
    }
  }
}

/**
 * Main function
 */
async function main() {
  console.log('Show Score Audience Data Scraper');
  console.log('================================\n');

  // Check that at least one scraping method is available
  const hasScraper = SCRAPINGBEE_KEY || process.env.BRIGHTDATA_TOKEN;
  let hasPlaywright = false;
  try { require.resolve('playwright'); hasPlaywright = true; } catch (_) {}
  if (!hasScraper && !hasPlaywright) {
    console.error('Error: No scraping method available. Set SCRAPINGBEE_API_KEY, BRIGHTDATA_TOKEN, or install playwright.');
    process.exit(1);
  }
  if (!SCRAPINGBEE_KEY) {
    console.log('Note: SCRAPINGBEE_API_KEY not set — using fallback scrapers');
  }

  // Get shows to process — open shows only by default, --all includes closed
  const allActiveShows = showsData.shows.filter(s => s.status === 'open' || s.status === 'previews' || s.status === 'closed');
  let shows = includeAll ? allActiveShows : showsData.shows.filter(s => s.status === 'open' || s.status === 'previews');

  // Handle single show filter (can target any status)
  if (showFilter) {
    shows = allActiveShows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (shows.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
  } else if (showsArg) {
    // Handle multiple shows (comma-separated) or special keywords
    if (showsArg === 'missing') {
      // Filter to shows without Show Score data
      const base = includeAll ? allActiveShows : showsData.shows.filter(s => s.status === 'open');
      shows = base.filter(s => {
        const b = (audienceBuzz.shows || {})[s.id];
        return !b || !b.sources || !b.sources.showScore;
      });
      console.log(`Found ${shows.length} shows missing Show Score data${includeAll ? ' (all statuses)' : ' (open only)'}`);
    } else {
      const showIds = showsArg.split(',').map(s => s.trim()).filter(Boolean);
      shows = allActiveShows.filter(s => showIds.includes(s.id) || showIds.includes(s.slug));
      if (shows.length === 0) {
        console.error(`No shows found matching: ${showsArg}`);
        process.exit(1);
      }
      console.log(`Processing specific shows: ${shows.map(s => s.title).join(', ')}`);
    }
  } else if (!includeAll) {
    console.log(`Processing open shows only (${shows.length}). Use --all for all shows.`);
  }

  // Shard mode: partition shows across parallel workers
  if (shardMode) {
    shows = shows.filter((_, i) => i % totalShards === shard);
    console.log(`Shard ${shard}/${totalShards}: processing ${shows.length} shows`);
  }

  // Initialize shard output for incremental writing (survives timeout/crash)
  let shardOutput = null;
  let shardPath = null;
  if (shardMode && !dryRun) {
    const shardDir = path.join(__dirname, '../data/show-score-shards');
    if (!fs.existsSync(shardDir)) fs.mkdirSync(shardDir, { recursive: true });
    shardOutput = { discoveredUrls: {}, scores: {} };
    shardPath = path.join(shardDir, `shard-${shard}.json`);
  }

  if (showLimit) {
    shows = shows.slice(0, showLimit);
  }

  // ── Phase 0: Listings-based discovery (scrapes Show Score's actual listings pages) ──
  // This is the PRIMARY discovery method. Phase A (slug guessing) is a fallback.
  const uncachedBefore = shows.filter(s => !getCachedUrl(s.id)).length;
  if (uncachedBefore > 0 && !shardMode) {
    // Only run listings discovery in non-shard mode (shard runs are for scoring, not discovery)
    console.log(`\n── Listings Discovery Phase: ${uncachedBefore} uncached shows ──`);
    try {
      const { execSync } = require('child_process');
      const result = execSync('node scripts/discover-show-score-urls-from-listings.js', {
        cwd: path.join(__dirname, '..'),
        encoding: 'utf8',
        timeout: 120000,
      });
      console.log(result);
      // Reload URL cache after listings discovery
      const freshUrlData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
      urlData.shows = freshUrlData.shows;
      urlData._meta = freshUrlData._meta;
      urlData._discoveryAttempts = freshUrlData._discoveryAttempts || urlData._discoveryAttempts;
      const uncachedAfter = shows.filter(s => !getCachedUrl(s.id)).length;
      console.log(`Listings discovery resolved ${uncachedBefore - uncachedAfter} URLs (${uncachedAfter} still uncached)\n`);
    } catch (err) {
      console.error(`Listings discovery failed: ${err.message}`);
      console.log('Falling back to slug-based discovery...\n');
    }
  }

  // ── Phase A: Slug-based discovery fallback (uncached shows only, capped) ──
  const uncachedShows = shows.filter(s => !getCachedUrl(s.id));
  if (uncachedShows.length > 0) {
    // Filter out shows we attempted recently
    const now = Date.now();
    const discoveryTargets = uncachedShows.filter(s => {
      const meta = urlData._discoveryAttempts && urlData._discoveryAttempts[s.id];
      if (!meta) return true;
      return (now - new Date(meta).getTime()) > DISCOVERY_COOLDOWN_MS;
    }).slice(0, MAX_DISCOVERIES);

    if (discoveryTargets.length > 0) {
      console.log(`\n── Discovery Phase: ${discoveryTargets.length} uncached shows (max ${MAX_DISCOVERIES}) ──\n`);

      for (const show of discoveryTargets) {
        console.log(`Discovering: ${show.title} (${show.id})`);
        const url = await discoverShowScoreUrl(show);

        // Track attempt timestamp
        if (!urlData._discoveryAttempts) urlData._discoveryAttempts = {};
        urlData._discoveryAttempts[show.id] = new Date().toISOString();

        if (url) {
          // Cache immediately
          if (!urlData.shows) urlData.shows = {};
          urlData.shows[show.id] = url;
          if (!dryRun) saveUrlCache();
          // Update shard incrementally
          if (shardOutput) {
            shardOutput.discoveredUrls[show.id] = url;
            fs.writeFileSync(shardPath, JSON.stringify(shardOutput, null, 2));
          }
          console.log(`  ✓ Cached URL for ${show.id}`);
        } else {
          console.log(`  ✗ No Show Score page found for ${show.title}`);
          if (!dryRun) saveUrlCache(); // Save attempt timestamp
        }

        await sleep(3000);
      }
      console.log('');
    } else if (uncachedShows.length > 0) {
      console.log(`\n${uncachedShows.length} uncached shows skipped (discovery cooldown)\n`);
    }
  }

  // ── Phase B: Score scraping (cached URLs only) ──
  const showsWithUrls = shows.filter(s => getCachedUrl(s.id));
  console.log(`Processing ${showsWithUrls.length} shows with cached URLs...\n`);

  // Snapshot existing scores for guard comparison
  const previousScores = {};
  let previousScoredCount = 0;
  for (const show of showsWithUrls) {
    const existing = audienceBuzz.shows && audienceBuzz.shows[show.id];
    if (existing && existing.sources && existing.sources.showScore && existing.sources.showScore.score != null) {
      previousScores[show.id] = existing.sources.showScore.score;
      previousScoredCount++;
    }
  }

  let processed = 0;
  let successful = 0;
  let metadataEnriched = 0;
  const scoreDrops = [];
  // Track scraped results by title to detect cross-contamination:
  // when different URLs for same-title shows return identical data,
  // only the most recent production keeps it.
  const scrapedByTitle = new Map(); // normalized title → { showId, score, reviewCount }

  for (const show of showsWithUrls) {
    try {
      const data = await processShow(show);
      processed++;

      if (data) {
        // Check for score drops
        if (previousScores[show.id] != null && data.score == null) {
          scoreDrops.push(show.id);
        }

        // Cross-contamination guard: if a same-title sibling scraped identical
        // data from a different URL, this is likely the same Show-Score production.
        // Keep only the most recent/relevant show's data.
        if (data.score) {
          const titleBase = show.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\(.*?\)\s*$/, '').trim();
          const key = `${titleBase}|${data.score}|${data.reviewCount}`;
          const existing = scrapedByTitle.get(key);
          if (existing && existing.showId !== show.id) {
            // Compare: prefer open/previews, then most recent opening
            const isBetter = (show.status === 'open' || show.status === 'previews') &&
              existing.status !== 'open' && existing.status !== 'previews' ||
              (show.openingDate || '') > (existing.openingDate || '');
            if (isBetter) {
              console.log(`  Superseding ${existing.showId} — this show is more recent`);
              // Clear the older show's data from audience-buzz
              if (audienceBuzz.shows[existing.showId]?.sources?.showScore) {
                audienceBuzz.shows[existing.showId].sources.showScore = null;
              }
              scrapedByTitle.set(key, { showId: show.id, score: data.score, reviewCount: data.reviewCount, status: show.status, openingDate: show.openingDate });
            } else {
              console.log(`  SKIP audience data: identical to ${existing.showId} (same Show-Score production)`);
              data.score = null; // prevent writing to audience-buzz
            }
          } else {
            scrapedByTitle.set(key, { showId: show.id, score: data.score, reviewCount: data.reviewCount, status: show.status, openingDate: show.openingDate });
          }
        }

        if (!dryRun) {
          if (data.score) {
            updateAudienceBuzz(show.id, show.title, data);
          }
          successful++;

          // ── Metadata enrichment: fill missing runtime/synopsis in shows.json ──
          if (data.metadata) {
            let enriched = false;
            if (data.metadata.runtime && !show.runtime) {
              show.runtime = data.metadata.runtime;
              enriched = true;
              console.log(`  ✓ Enriched runtime: ${data.metadata.runtime}`);
            }
            if (data.metadata.synopsis && !show.synopsis) {
              show.synopsis = data.metadata.synopsis;
              enriched = true;
              console.log(`  ✓ Enriched synopsis (${data.metadata.synopsis.length} chars)`);
            }
            if (enriched) metadataEnriched++;
          }

          // Save incrementally after each successful show
          audienceBuzz._meta.lastUpdated = new Date().toISOString();
          audienceBuzz._meta.sources = ['Show Score', 'Mezzanine', 'Reddit'];
          audienceBuzz._meta.notes = 'Proportional weighting by reviewCount volume (max 80% single source)';
          fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));
          // Update shard incrementally (survives timeout)
          if (shardOutput) {
            const entry = audienceBuzz.shows && audienceBuzz.shows[show.id];
            if (entry && entry.sources && entry.sources.showScore) {
              shardOutput.scores[show.id] = entry.sources.showScore;
            }
            const cachedUrl = getCachedUrl(show.id);
            if (cachedUrl) shardOutput.discoveredUrls[show.id] = cachedUrl;
            fs.writeFileSync(shardPath, JSON.stringify(shardOutput, null, 2));
          }
          console.log(`  ✓ Saved (${successful}/${showsWithUrls.length})`);
        } else {
          successful++;
          // Log metadata findings in dry-run mode
          if (data.metadata) {
            if (data.metadata.runtime && !show.runtime) console.log(`  [dry-run] Would enrich runtime: ${data.metadata.runtime}`);
            if (data.metadata.synopsis && !show.synopsis) console.log(`  [dry-run] Would enrich synopsis (${data.metadata.synopsis.length} chars)`);
          }
        }
      } else if (previousScores[show.id] != null) {
        scoreDrops.push(show.id);
      }
    } catch (e) {
      console.error(`Error processing ${show.title}:`, e.message);
    }

    // Rate limiting
    await sleep(3000);
  }

  // ── Validation guards ──
  if (showsWithUrls.length > 0) {
    const successRate = successful / showsWithUrls.length;
    if (successRate < 0.5) {
      console.error(`\nGUARD: Only ${successful}/${showsWithUrls.length} shows returned scores (${(successRate * 100).toFixed(0)}% < 50% minimum)`);
      console.error('Possible systemic failure. Check ScrapingBee and Show Score status.');
    }
  }

  if (scoreDrops.length > 0) {
    console.warn(`\n⚠ ${scoreDrops.length} shows lost their score this run:`);
    for (const id of scoreDrops) {
      console.warn(`  - ${id} (was: ${previousScores[id]})`);
    }
  }

  if (previousScoredCount > 0 && successful < previousScoredCount - 5) {
    console.warn(`\n⚠ Score count dropped: ${successful} (was ${previousScoredCount}, delta: -${previousScoredCount - successful})`);
  }

  // Log shard summary (data already written incrementally above)
  if (shardOutput) {
    console.log(`\nShard ${shard} output: ${Object.keys(shardOutput.scores).length} scores, ${Object.keys(shardOutput.discoveredUrls).length} URLs`);
  }

  // ── Save shows.json if metadata was enriched ──
  if (metadataEnriched > 0 && !dryRun) {
    fs.writeFileSync(showsPath, JSON.stringify(showsData, null, 2) + '\n');
    console.log(`\nshows.json updated with ${metadataEnriched} metadata enrichments.`);
  }

  // Clean up Playwright browser if it was started
  await cleanupPlaywright();

  console.log(`\nDone! Processed ${processed} shows, ${successful} with Show Score data.`);
  if (metadataEnriched > 0) console.log(`  Metadata enriched: ${metadataEnriched} shows (runtime/synopsis)`);
  console.log(`  Cached URLs: ${Object.keys(urlData.shows || {}).length}`);
  console.log(`  Uncached shows: ${uncachedShows.length}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
