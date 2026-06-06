#!/usr/bin/env node
/**
 * scrape-lottery-rush.js — Robust Lottery/Rush Data System
 *
 * Scrapes lottery/rush data from three sources:
 * 1. BwayRush.com — Broadway current prices (ScrapingBee/Bright Data markdown extraction)
 * 2. Playbill — Broadway detailed policies/instructions (LLM-powered extraction)
 * 3. Twopenny Theatre — West End lottery/rush/day seats (LLM-powered extraction)
 *
 * Key design principles:
 * - Incremental merge (never wholesale replace)
 * - Pre-write backup with rotation
 * - High-confidence show matching only
 * - Fail-safe: any failure preserves existing data
 *
 * Usage:
 *   node scripts/scrape-lottery-rush.js                    # Full scrape
 *   node scripts/scrape-lottery-rush.js --source=bwayrush   # Single source
 *   node scripts/scrape-lottery-rush.js --source=playbill   # Single source
 *   node scripts/scrape-lottery-rush.js --source=twopenny   # West End only
 *   node scripts/scrape-lottery-rush.js --dry-run           # Preview only
 *   node scripts/scrape-lottery-rush.js --verbose           # Verbose logging
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { matchTitleToShow, loadShows } = require('./lib/show-matching');
const { cleanSearchTitle } = require('./lib/title-normalization');
const { CLAUDE_SONNET } = require('./lib/models');

// ==================== Configuration ====================

const BWAYRUSH_URL = 'https://bwayrush.com/';
const PLAYBILL_URL = 'https://playbill.com/article/broadway-rush-lottery-and-standing-room-only-policies-com-116003';
const OUTPUT_PATH = path.join(__dirname, '../data/lottery-rush.json');
const SCHEDULE_PATH = path.join(__dirname, '../data/show-schedules.json');
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');

// CLI args
const args = process.argv.slice(2);
const sourceFilter = args.find(a => a.startsWith('--source='))?.split('=')[1];
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const forceGuard = args.includes('--force');

// API keys
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const BRIGHTDATA_TOKEN = process.env.BRIGHTDATA_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// Load shows data for matching
const allLoadedShows = loadShows();
const allShows = allLoadedShows.filter(s => !s.category || s.category === 'broadway');
const weShows = allLoadedShows.filter(s => s.category === 'west-end' || s.category === 'off-west-end');

// Override map for titles fuzzy matching can't handle
const TITLE_OVERRIDES = {
  '& Juliet': 'and-juliet-2022',
  'Titaníque': 'titanique-2026',
};

const WE_TITLE_OVERRIDES = {
  'Titaníque': 'titanique-west-end-2024',
  'Harry Potter and the Cursed Child': 'harry-potter-and-the-cursed-child-both-parts-west-end-2021',
  'My Neighbour Totoro': 'my-neighbour-totoro-west-end-2025',
};

// ==================== HTTP Utilities ====================

function httpsRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(90000, () => req.destroy(new Error('Request timeout')));

    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Fetch a URL as markdown (Bright Data) or HTML (ScrapingBee fallback).
 * Returns { content, format } or null.
 */
async function fetchContent(url, { renderJs = true, premiumProxy = false } = {}) {
  // Try Bright Data first (returns markdown natively)
  if (BRIGHTDATA_TOKEN) {
    try {
      const result = await httpsRequest('https://api.brightdata.com/request', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${BRIGHTDATA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ zone: 'mcp_browser', url, format: 'raw' }),
      });
      if (result && result.length > 500) {
        if (verbose) console.log(`  [Bright Data] Success (${result.length} chars HTML)`);
        return { content: result, format: 'html' };
      }
    } catch (err) {
      console.error(`  [Bright Data] Failed: ${err.message}`);
    }
  }

  // Fallback: ScrapingBee (returns HTML, converted to pseudo-markdown for link parsing)
  if (SCRAPINGBEE_KEY) {
    try {
      const params = new URLSearchParams({
        api_key: SCRAPINGBEE_KEY,
        url,
        render_js: String(renderJs),
      });
      if (premiumProxy) params.set('premium_proxy', 'true');
      const apiUrl = `https://app.scrapingbee.com/api/v1/?${params}`;
      const result = await httpsRequest(apiUrl);
      if (result && result.length > 500) {
        if (verbose) console.log(`  [ScrapingBee] Success (${result.length} chars HTML)`);
        return { content: result, format: 'html' };
      }
    } catch (err) {
      console.error(`  [ScrapingBee] Failed: ${err.message}`);
    }
  }

  // Last resort: direct fetch (no proxy — works for sites that don't block)
  try {
    if (verbose) console.log(`  [Direct] Trying direct fetch for ${url}...`);
    const result = await httpsRequest(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (result && result.length > 500) {
      if (verbose) console.log(`  [Direct] Success (${result.length} chars HTML)`);
      return { content: result, format: 'html' };
    }
  } catch (err) {
    console.error(`  [Direct] Failed: ${err.message}`);
  }

  return null;
}

/**
 * Fetch a JSON endpoint through the proxy chain (Bright Data web_unlocker2 → ScrapingBee → direct).
 * Used for the bwayrush /api/calendar endpoint, which Cloudflare blocks on datacenter IPs
 * including GitHub Actions runners. Returns parsed JSON or null.
 *
 * Why web_unlocker2 (not mcp_browser): JSON APIs don't need JS rendering, and web_unlocker2
 * is the zone currently configured in .env for cheap HTML fetches.
 */
async function fetchJson(url) {
  // Bright Data web_unlocker2 — cheap residential proxy that bypasses Cloudflare
  if (BRIGHTDATA_TOKEN) {
    try {
      const result = await httpsRequest('https://api.brightdata.com/request', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${BRIGHTDATA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ zone: 'web_unlocker2', url, format: 'raw' }),
      });
      if (result) {
        try {
          const json = JSON.parse(result);
          if (verbose) console.log(`  [Bright Data] JSON fetch OK (${result.length} chars)`);
          return json;
        } catch {
          if (verbose) console.warn(`  [Bright Data] Non-JSON response (${result.length} chars, head: ${result.slice(0, 100)})`);
        }
      }
    } catch (err) {
      console.error(`  [Bright Data] JSON fetch failed: ${err.message}`);
    }
  }

  // ScrapingBee fallback — no JS rendering for JSON endpoints
  if (SCRAPINGBEE_KEY) {
    try {
      const params = new URLSearchParams({
        api_key: SCRAPINGBEE_KEY,
        url,
        render_js: 'false',
      });
      const apiUrl = `https://app.scrapingbee.com/api/v1/?${params}`;
      const result = await httpsRequest(apiUrl);
      if (result) {
        try {
          const json = JSON.parse(result);
          if (verbose) console.log(`  [ScrapingBee] JSON fetch OK (${result.length} chars)`);
          return json;
        } catch {
          if (verbose) console.warn(`  [ScrapingBee] Non-JSON response`);
        }
      }
    } catch (err) {
      console.error(`  [ScrapingBee] JSON fetch failed: ${err.message}`);
    }
  }

  // Last resort: direct — rarely works for Cloudflare-protected endpoints but cheap to try
  try {
    const result = await httpsRequest(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept': 'application/json,*/*;q=0.8',
      },
    });
    return JSON.parse(result);
  } catch (err) {
    if (verbose) console.error(`  [Direct] JSON fetch failed: ${err.message}`);
  }

  return null;
}

function htmlToText(html) {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Convert HTML to pseudo-markdown preserving link structure.
 * Converts <a href="url" title="tooltip">text</a> to [text](url "tooltip")
 * This allows the same parseBwayRushMarkdown() to work on both formats.
 */
function htmlToMarkdownLinks(html) {
  return html
    // Strip scripts and styles
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    // Convert <a> tags to markdown links, preserving title attribute
    .replace(/<a\s+[^>]*?href="([^"]*)"[^>]*?title="([^"]*)"[^>]*?>(.*?)<\/a>/gi,
      (_, href, title, text) => `[${text.replace(/<[^>]*>/g, '').trim()}](${href} "${title}")`)
    // Convert remaining <a> tags without title
    .replace(/<a\s+[^>]*?href="([^"]*)"[^>]*?>(.*?)<\/a>/gi,
      (_, href, text) => `[${text.replace(/<[^>]*>/g, '').trim()}](${href})`)
    // Block elements to newlines
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n\n')
    // Strip remaining tags
    .replace(/<[^>]*>/g, '')
    // Decode entities
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ==================== Show ID Resolution ====================

function resolveShowId(externalTitle) {
  // Check overrides first
  if (TITLE_OVERRIDES[externalTitle]) {
    return { id: TITLE_OVERRIDES[externalTitle], confidence: 'override' };
  }

  // BwayRush.com is Broadway-only, and lotteries are for currently-running shows
  const match = matchTitleToShow(externalTitle, allShows, { market: 'broadway', prefer: 'open' });

  // Only accept high-confidence matches
  if (match && match.confidence === 'high') {
    return { id: match.show.id, confidence: match.confidence };
  }

  return null;
}

function resolveWeShowId(externalTitle) {
  if (WE_TITLE_OVERRIDES[externalTitle]) {
    return { id: WE_TITLE_OVERRIDES[externalTitle], confidence: 'override' };
  }
  const match = matchTitleToShow(externalTitle, weShows, { market: 'west-end', prefer: 'open' });
  if (match && match.confidence === 'high') {
    return { id: match.show.id, confidence: match.confidence };
  }
  return null;
}

// ==================== Platform Detection ====================

function detectPlatform(url) {
  if (!url) return null;
  const lower = url.toLowerCase();
  if (lower.includes('todaytix.com')) return 'TodayTix';
  if (lower.includes('luckyseat.com')) return 'LuckySeat';
  if (lower.includes('broadwaydirect.com')) return 'Broadway Direct';
  if (lower.includes('socialtoaster.com') || lower.includes('rush.telecharge.com')) return 'Telecharge';
  if (lower.includes('hamiltonmusical.com')) return 'Hamilton App';
  return null;
}

// ==================== BwayRush Extraction ====================

async function scrapeBwayRush() {
  console.log('\n[BwayRush] Fetching current prices...');
  const result = await fetchContent(BWAYRUSH_URL, { renderJs: true, premiumProxy: true });

  if (!result) {
    console.error('[BwayRush] Failed to fetch page — skipping');
    return {};
  }

  // Extract schedule data from raw HTML before markdown conversion (independent try/catch)
  if (result.format === 'html') {
    try {
      await extractAndWriteScheduleData(result.content);
    } catch (err) {
      console.error(`[Schedule] Extraction failed (non-fatal): ${err.message}`);
      if (verbose) console.error(err.stack);
    }
  }

  // Convert HTML to pseudo-markdown if needed (preserving link structure)
  if (result.format === 'html') {
    if (verbose) console.log('[BwayRush] Converting HTML to markdown links...');
    result.content = htmlToMarkdownLinks(result.content);
    result.format = 'markdown';
  }

  if (result.content.length < 500) {
    console.error(`[BwayRush] Response too short (${result.content.length} chars) — skipping`);
    return {};
  }

  const rawData = parseBwayRushMarkdown(result.content);
  const showCount = Object.keys(rawData).length;

  if (showCount < 5) {
    console.error(`[BwayRush] Only found ${showCount} shows — something is wrong, skipping`);
    return {};
  }

  console.log(`[BwayRush] Parsed ${showCount} shows from markdown`);
  return mapBwayRushToShows(rawData);
}

// ==================== Schedule Extraction ====================

/**
 * Extract schedule data from bwayrush.com.
 * 1. Parse initial HTML for thisweek + build bwayrush-ID-to-title mapping
 * 2. Fetch future weeks via /api/calendar?currentMonday=X&direction=next
 * 3. Store all weeks (current + future) per show
 */
async function extractAndWriteScheduleData(html) {
  console.log('\n[Schedule] Extracting schedule data from HTML...');

  const mondayMatch = html.match(/currentMonday:"(\d{8})"/);
  if (!mondayMatch) {
    console.error('[Schedule] Could not find currentMonday in HTML — skipping');
    return;
  }
  const currentMonday = mondayMatch[1];
  console.log(`[Schedule] Current Monday: ${currentMonday}`);

  const mondayDate = new Date(
    parseInt(currentMonday.slice(0, 4)),
    parseInt(currentMonday.slice(4, 6)) - 1,
    parseInt(currentMonday.slice(6, 8))
  );
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysSinceMonday = Math.floor((today - mondayDate) / (1000 * 60 * 60 * 24));
  if (daysSinceMonday > 10) {
    console.warn(`[Schedule] currentMonday is ${daysSinceMonday} days old — data may be stale`);
  }

  // Extract the shows array from the JS payload using bracket matching
  const showsStart = html.indexOf('shows:[');
  if (showsStart === -1) {
    console.error('[Schedule] Could not find shows array in HTML — skipping');
    return;
  }
  const arrayStart = showsStart + 6;
  let depth = 0;
  let arrayEnd = -1;
  for (let i = arrayStart; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { arrayEnd = i + 1; break; } }
  }
  if (arrayEnd === -1) {
    console.error('[Schedule] Could not find end of shows array — skipping');
    return;
  }
  let showsJs = html.slice(arrayStart, arrayEnd);

  showsJs = showsJs.replace(/void 0/g, 'null');
  showsJs = showsJs.replace(/([{,])\s*(\w+)\s*:/g, '$1"$2":');
  showsJs = showsJs.replace(/,\s*([}\]])/g, '$1');

  let shows;
  try {
    shows = JSON.parse(showsJs);
  } catch (err) {
    console.error(`[Schedule] JSON parse failed: ${err.message}`);
    if (verbose) {
      const pos = parseInt(err.message.match(/position (\d+)/)?.[1] || '0');
      console.error(`[Schedule] Near position ${pos}: ...${showsJs.slice(Math.max(0, pos - 50), pos + 50)}...`);
    }
    return;
  }

  if (!Array.isArray(shows) || shows.length < 15) {
    console.error(`[Schedule] Only found ${shows?.length || 0} shows — expected 15+, skipping write`);
    return;
  }

  // Build bwayrush numeric ID → our show ID mapping, and store thisweek data
  const bwayIdToOurId = {};  // bwayrush numeric id → our show id
  const scheduleShows = {};
  const unmatched = [];

  for (const show of shows) {
    if (!show.title || !show.id) continue;

    const resolved = resolveShowId(show.title);
    if (!resolved) {
      unmatched.push(show.title);
      continue;
    }

    bwayIdToOurId[show.id] = resolved.id;

    if (show.thisweek && Array.isArray(show.thisweek) && show.thisweek.length === 7) {
      scheduleShows[resolved.id] = {
        weeks: {
          [currentMonday]: show.thisweek,
        },
      };
    }
  }

  const matchedCount = Object.keys(scheduleShows).length;
  console.log(`[Schedule] Matched ${matchedCount} shows, ${unmatched.length} unmatched`);

  if (unmatched.length > 0 && verbose) {
    console.log('[Schedule] Unmatched titles:');
    unmatched.forEach(t => console.log(`  - ${t}`));
  }

  if (matchedCount < 15) {
    console.error(`[Schedule] Only matched ${matchedCount} shows — expected 15+, skipping write`);
    return;
  }

  // Fetch future weeks via bwayrush calendar API.
  // Route through fetchJson() (Bright Data / ScrapingBee) — direct fetch() is 403'd by
  // Cloudflare on all IPs including GitHub Actions runners. Silent-1-week-write bug was
  // caused by using native fetch() here while the HTML was (correctly) going through BD.
  const MAX_FUTURE_WEEKS = 7;
  let fetchMonday = currentMonday;
  let futureWeeksFetched = 0;

  for (let w = 0; w < MAX_FUTURE_WEEKS; w++) {
    const url = `https://bwayrush.com/api/calendar?currentMonday=${fetchMonday}&direction=next`;
    const data = await fetchJson(url);
    if (!data) {
      console.warn(`[Schedule] Calendar API fetch returned no data for ${fetchMonday} — stopping`);
      break;
    }
    if (!data.currentMonday || !Array.isArray(data.calendar)) {
      console.warn('[Schedule] Unexpected calendar API response shape — stopping');
      break;
    }

    const weekMonday = data.currentMonday;
    let weekMatched = 0;

    for (const entry of data.calendar) {
      const ourId = bwayIdToOurId[entry.id];
      if (!ourId || !Array.isArray(entry.calendar) || entry.calendar.length !== 7) continue;

      if (!scheduleShows[ourId]) {
        scheduleShows[ourId] = { weeks: {} };
      }
      scheduleShows[ourId].weeks[weekMonday] = entry.calendar;
      weekMatched++;
    }

    console.log(`[Schedule] Week ${weekMonday}: ${weekMatched} shows`);
    fetchMonday = weekMonday;
    futureWeeksFetched++;
  }

  console.log(`[Schedule] Fetched ${futureWeeksFetched} future weeks`);

  // Fail loudly if future-week fetch got zero results. One week means week-nav arrows
  // on the Showtimes card are always disabled — a user-visible regression. Better to
  // refuse the write (keep existing multi-week data) than ship a silently-degraded file.
  if (futureWeeksFetched === 0) {
    console.error('::error::[Schedule] Calendar API returned 0 future weeks — refusing to overwrite show-schedules.json with single-week data.');
    console.error('[Schedule] Likely causes: Cloudflare re-block on proxy (check Bright Data zone), API shape change, or expired/rotated token.');
    console.error('[Schedule] Existing show-schedules.json preserved. Fix upstream or re-run with a working proxy.');
    // Set non-zero exit so the workflow's notify-failure step fires (Discord + email alert).
    // Don't throw — let lottery/playbill/twopenny scrapers finish their own work first.
    process.exitCode = 1;
    return;
  }

  if (dryRun) {
    console.log(`[Schedule] [Dry Run] Would write ${matchedCount} shows to show-schedules.json`);
    return;
  }

  // Filter out closed/announced shows (BWayRush sometimes returns stale entries)
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const ACTIVE_STATUSES = new Set(['open', 'previews', 'upcoming']);
  let removedSchedules = 0;
  for (const showId of Object.keys(scheduleShows)) {
    const show = showsData.shows.find(s => s.id === showId);
    if (show && !ACTIVE_STATUSES.has(show.status)) {
      delete scheduleShows[showId];
      removedSchedules++;
    }
  }
  if (removedSchedules > 0) {
    console.log(`[Schedule] Removed ${removedSchedules} non-active shows from schedules`);
  }

  // Write schedule data (overwrite entirely — always trust source of truth)
  const output = {
    lastUpdated: new Date().toISOString(),
    source: 'https://bwayrush.com/',
    currentMonday,
    shows: scheduleShows,
  };

  fs.writeFileSync(SCHEDULE_PATH, JSON.stringify(output, null, 2) + '\n');
  console.log(`[Schedule] Wrote show-schedules.json with ${Object.keys(scheduleShows).length} shows, ${futureWeeksFetched + 1} weeks`);
}

function parseBwayRushMarkdown(markdown) {
  // Preprocess: join multi-line markdown links into single lines
  // e.g., [$49\n\nin-person](url) → [$49 in-person](url)
  const text = markdown.replace(/\[(\$[^\]]*?)\]\(([^)]+)\)/g, (_match, content, url) => {
    const joined = content.replace(/\n+/g, ' ').trim();
    return `[${joined}](${url})`;
  });

  const shows = {};

  // Find show title links: [Title](url "Title at Theatre")
  // URL pattern excludes ) and " to prevent matching across link boundaries
  const titlePattern = /\[([^\]]+)\]\(([^)"]+)\s+"([^"]+)"\)/g;
  const titleMatches = [...text.matchAll(titlePattern)];

  for (let i = 0; i < titleMatches.length; i++) {
    const match = titleMatches[i];
    const title = match[1];
    const tooltip = match[3];

    // Get block between this show and next
    const startIdx = match.index + match[0].length;
    const endIdx = i < titleMatches.length - 1 ? titleMatches[i + 1].index : text.length;
    const block = text.slice(startIdx, endIdx);

    // Stop at FAQ section
    if (title === 'FAQ' || block.includes('What is rush?')) break;

    // Extract prices from the block
    const prices = extractPrices(block);

    shows[title] = { tooltip, prices };
  }

  return shows;
}

function extractPrices(block) {
  const prices = [];

  // 1. Extract linked prices: [$XX descriptor](url)
  const linkPattern = /\[(\$[^\]]+)\]\(([^)]+)\)/g;
  const linkRanges = [];
  let match;

  while ((match = linkPattern.exec(block)) !== null) {
    linkRanges.push({ start: match.index, end: match.index + match[0].length });

    const content = match[1]; // "$49 in-person" (after preprocessing)
    const url = match[2];

    // Split: first token is price, rest is descriptor
    const spaceIdx = content.indexOf(' ');
    const priceStr = spaceIdx > 0 ? content.slice(0, spaceIdx) : content;
    const descriptor = spaceIdx > 0 ? content.slice(spaceIdx + 1).trim() : '';

    const parsed = parsePriceStr(priceStr);
    if (parsed) {
      prices.push({ ...parsed, descriptor, url });
    }
  }

  // 2. Extract unlinked prices: $XX on their own line (not inside brackets)
  let cleanBlock = block;
  for (const range of [...linkRanges].reverse()) {
    cleanBlock = cleanBlock.slice(0, range.start) + cleanBlock.slice(range.end);
  }

  const lines = cleanBlock.split('\n').map(l => l.trim()).filter(l => l);
  for (let i = 0; i < lines.length; i++) {
    const priceMatch = lines[i].match(/^\$([\d.]+(?:\/[\d.]+)?)$/);
    if (priceMatch) {
      const parsed = parsePriceStr('$' + priceMatch[1]);
      if (parsed && parsed.price > 0) {
        // Check next non-empty line for descriptor
        let descriptor = '';
        if (i + 1 < lines.length && isKnownDescriptor(lines[i + 1])) {
          descriptor = lines[i + 1];
        }
        prices.push({ ...parsed, descriptor, url: null });
      }
    }
  }

  return prices;
}

function parsePriceStr(priceStr) {
  const cleaned = priceStr.replace(/^\$/, '').replace(/\s*\+fee$/i, '');

  // Handle "$55/65" format (weekday/weekend)
  const slashMatch = cleaned.match(/^([\d.]+)\/([\d.]+)$/);
  if (slashMatch) {
    return { price: parseFloat(slashMatch[1]), priceWeekend: parseFloat(slashMatch[2]) };
  }

  const price = parseFloat(cleaned);
  return isNaN(price) ? null : { price };
}

function isKnownDescriptor(text) {
  const lower = text.toLowerCase().trim();
  const patterns = [
    'in-person', 'mobile', 'digital', 'student', '30 under 30', 'under 30',
    'ponyboy', 'military', 'mtc', 'hiptix', 'linctix', 'college',
    'general', 'anniv', 'club 2064',
  ];
  return patterns.some(p => lower.includes(p));
}

/**
 * Classify a price entry into our schema field type.
 * Uses descriptor text and URL patterns.
 */
function classifyPrice(descriptor, url) {
  const desc = (descriptor || '').toLowerCase().trim();
  const urlLower = (url || '').toLowerCase();

  // Special programs (descriptor-based, highest priority)
  if (desc.includes('college') || desc.includes('student')) return { field: 'studentRush' };
  if (desc.includes('30 under 30') || desc.includes('under 30')) return { field: 'under30' };
  if (desc.includes('ponyboy')) return { field: 'special', name: 'Ponyboy Seat' };
  if (desc.includes('military')) return { field: 'militaryTickets' };
  if (desc.includes('mtc')) return { field: 'special', name: 'MTC $35' };
  if (desc.includes('hiptix')) return { field: 'special', name: 'HipTix' };
  if (desc.includes('linctix')) return { field: 'special', name: 'LincTix' };
  if (desc.includes('anniv')) return { field: 'specialLottery', name: descriptor };
  if (desc.includes('club 2064')) return { field: 'specialLottery', name: 'Club 2064' };

  // In-person rush
  if (desc.includes('in-person')) return { field: 'rush', rushType: 'general' };

  // Mobile — usually TodayTix rush, but Hamilton lottery uses "mobile" too
  if (desc.includes('mobile')) {
    if (urlLower.includes('lottery')) return { field: 'lottery' };
    return { field: 'rush', rushType: 'digital' };
  }

  // Digital — lottery or digital rush depending on URL
  if (desc.includes('digital')) {
    if (urlLower.includes('rush_select')) return { field: 'digitalRush' };
    return { field: 'lottery' };
  }

  // No descriptor — SRO (standing room)
  if (!desc) return { field: 'standingRoom' };

  if (verbose) console.log(`  [Classify] Unknown descriptor: "${descriptor}"`);
  return { field: 'unknown' };
}

function mapBwayRushToShows(rawData) {
  const result = {};
  const unmatched = [];

  for (const [title, showData] of Object.entries(rawData)) {
    if (showData.prices.length === 0) {
      if (verbose) console.log(`  [Skip] ${title} (no prices)`);
      continue;
    }

    const resolved = resolveShowId(title);
    if (!resolved) {
      unmatched.push(title);
      continue;
    }

    const entry = {};

    for (const p of showData.prices) {
      const cls = classifyPrice(p.descriptor, p.url);

      switch (cls.field) {
        case 'lottery':
          if (!entry.lottery) {
            entry.lottery = {
              type: 'digital',
              platform: detectPlatform(p.url),
              url: p.url,
              price: p.price,
            };
            if (p.priceWeekend) entry.lottery.priceWeekend = p.priceWeekend;
          }
          break;

        case 'rush':
          if (!entry.rush) {
            entry.rush = {
              type: cls.rushType || 'general',
              price: p.price,
            };
            if (cls.rushType === 'digital') {
              entry.rush.platform = detectPlatform(p.url);
              entry.rush.url = p.url;
            }
          } else if (cls.rushType === 'digital' && entry.rush.type === 'general') {
            // General rush exists, add digital as separate field
            entry.digitalRush = {
              platform: detectPlatform(p.url),
              url: p.url,
              price: p.price,
            };
          }
          break;

        case 'digitalRush':
          if (!entry.digitalRush) {
            entry.digitalRush = {
              platform: detectPlatform(p.url),
              url: p.url,
              price: p.price,
            };
          }
          break;

        case 'studentRush':
          if (!entry.studentRush) {
            entry.studentRush = { price: p.price };
          }
          break;

        case 'standingRoom':
          if (!entry.standingRoom) {
            entry.standingRoom = { price: p.price };
          }
          break;

        case 'specialLottery':
          if (!entry.specialLottery) {
            entry.specialLottery = {
              name: cls.name || 'Special Lottery',
              platform: detectPlatform(p.url),
              url: p.url,
              price: p.price,
            };
          }
          break;

        case 'under30':
          if (!entry.under30) {
            entry.under30 = { price: p.price };
          }
          break;

        case 'special':
          if (!entry.special) {
            entry.special = { name: cls.name, price: p.price };
          }
          break;

        case 'militaryTickets':
          if (!entry.militaryTickets) {
            entry.militaryTickets = { price: p.price };
          }
          break;
      }
    }

    result[resolved.id] = entry;
  }

  if (unmatched.length > 0) {
    console.log(`\n[BwayRush] ${unmatched.length} unmatched titles:`);
    unmatched.forEach(t => console.log(`  ? "${t}"`));
  }

  console.log(`[BwayRush] Mapped ${Object.keys(result).length} shows to IDs`);
  return result;
}

// ==================== Playbill Extraction ====================

async function scrapePlaybill() {
  if (!ANTHROPIC_KEY) {
    console.error('[Playbill] ANTHROPIC_API_KEY not set — skipping');
    return {};
  }

  console.log('\n[Playbill] Fetching article...');
  const result = await fetchContent(PLAYBILL_URL, { renderJs: false });

  if (!result) {
    console.error('[Playbill] Failed to fetch article — skipping');
    return {};
  }

  // Convert HTML to text if needed (reduces tokens for LLM)
  let articleText = result.content;
  if (result.format === 'html') {
    articleText = htmlToText(articleText);
  }

  if (articleText.length < 1000) {
    console.error(`[Playbill] Article too short (${articleText.length} chars) — skipping`);
    return {};
  }

  console.log(`[Playbill] Got article (${articleText.length} chars), extracting via LLM...`);

  const extracted = await extractPlaybillWithLLM(articleText);
  if (!extracted || extracted.length === 0) {
    console.error('[Playbill] LLM extraction returned no results — skipping');
    return {};
  }

  console.log(`[Playbill] LLM extracted ${extracted.length} valid shows`);
  return mapPlaybillToShows(extracted);
}

async function extractPlaybillWithLLM(articleText) {
  const prompt = `Extract lottery/rush/SRO data from this Playbill article.

Return ONLY a JSON array (no markdown fences, no explanation). Each element:
{
  "title": "Show Title",
  "lottery": { "type": "digital", "platform": "...", "url": "...", "price": 49, "time": "...", "instructions": "..." } or null,
  "rush": { "type": "general|digital", "price": 49, "time": "...", "location": "...", "instructions": "..." } or null,
  "digitalRush": { "platform": "...", "url": "...", "price": 49, "time": "...", "instructions": "..." } or null,
  "standingRoom": { "price": 45, "time": "...", "instructions": "..." } or null,
  "studentRush": { "price": 39, "time": "...", "instructions": "..." } or null,
  "specialLottery": { "name": "...", "platform": "...", "url": "...", "price": 15, "instructions": "..." } or null
}

CRITICAL classification rules:
- LOTTERY = random drawing/selection. Winners are chosen randomly. Platforms: Broadway Direct, LuckySeat, Telecharge lottery, Hamilton App. Uses words like "lottery", "enter", "winners selected/drawn/notified".
- RUSH = first-come first-served. No random drawing. Platforms: TodayTix (always rush, never lottery), box office window. Uses words like "rush", "available", "first-come".
- DIGITAL RUSH = rush tickets via app/website. TodayTix is ALWAYS digitalRush, never lottery.
- GENERAL RUSH = in-person at box office window.
- STANDING ROOM = standing-only tickets sold when show is sold out. Must explicitly say "standing room" or "SRO". Do NOT classify LincTix, HipTix, or other named discount programs as standing room.
- SPECIAL LOTTERY = a secondary/novelty lottery alongside the main one (e.g., "$15 anniversary lottery"). Only use if a show ALSO has a regular lottery.
- If a show has only ONE lottery program, put it in "lottery" (not "specialLottery"), even if it has a special name.

Other rules:
- price must be a number (not a string with $)
- Only include fields that actually exist in the article
- Do not invent data not in the article
- Do NOT include null-valued fields — omit them entirely
- Do NOT create duplicate entries: if the same program appears in multiple fields (e.g., same price and platform in both "lottery" and "rush"), keep only the correct one

Article:
${articleText}`;

  try {
    const response = await httpsRequest('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_SONNET,
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const parsed = JSON.parse(response);
    const text = parsed.content?.[0]?.text;

    if (!text) throw new Error('No text in LLM response');

    // Extract JSON array (handle potential markdown wrapping)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in LLM response');

    const shows = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(shows)) throw new Error('LLM response is not an array');

    // Validate: each entry must have a title and at least one program
    const valid = shows.filter(entry => {
      if (!entry.title || typeof entry.title !== 'string') return false;
      return !!(entry.lottery || entry.rush || entry.digitalRush ||
                entry.standingRoom || entry.studentRush || entry.specialLottery ||
                entry.under30 || entry.special || entry.studentTickets || entry.militaryTickets);
    });

    console.log(`  [LLM] ${shows.length} extracted, ${valid.length} valid`);
    return valid;

  } catch (err) {
    console.error(`[Playbill] LLM extraction failed: ${err.message}`);
    return null;
  }
}

/**
 * Post-process LLM-extracted data to fix common misclassifications.
 * Runs on each show entry before mapping to show IDs.
 */
function postProcessPlaybillEntry(entry) {
  // 1. Remove explicitly null fields
  for (const key of Object.keys(entry)) {
    if (entry[key] === null) delete entry[key];
  }

  // 2. TodayTix entries: usually rush, but can be lottery if it involves random drawing
  if (entry.lottery && entry.lottery.platform === 'TodayTix') {
    const lotteryText = JSON.stringify(entry.lottery).toLowerCase();
    const hasLotteryLanguage = /\b(winner|drawing|drawn|selected|enter|entries|lottery)\b/.test(lotteryText);

    if (hasLotteryLanguage) {
      // Genuine lottery that uses TodayTix as platform (e.g., Harry Potter Friday Forty)
      if (verbose) console.log(`  [PostProcess] ${entry.title}: Keeping TodayTix lottery (has lottery language)`);
    } else {
      // Plain TodayTix rush misclassified as lottery → move to digitalRush
      if (!entry.digitalRush) {
        entry.digitalRush = { ...entry.lottery };
        delete entry.digitalRush.type;
      } else if (!entry.rush) {
        entry.rush = {
          type: 'digital',
          platform: 'TodayTix',
          url: entry.lottery.url,
          price: entry.lottery.price,
          time: entry.lottery.time,
          instructions: entry.lottery.instructions,
        };
      }
      delete entry.lottery;
      if (verbose) console.log(`  [PostProcess] ${entry.title}: Moved TodayTix from lottery → digitalRush`);
    }
  }

  // 2b. If digitalRush has lottery language and no lottery exists, promote it to lottery
  if (entry.digitalRush && !entry.lottery) {
    const drText = JSON.stringify(entry.digitalRush).toLowerCase();
    const hasLotteryLanguage = /\b(winner|drawing|drawn|selected|entries\s+accepted)\b/.test(drText);
    if (hasLotteryLanguage) {
      entry.lottery = {
        type: 'digital',
        platform: entry.digitalRush.platform,
        url: entry.digitalRush.url,
        price: entry.digitalRush.price,
        time: entry.digitalRush.time,
        instructions: entry.digitalRush.instructions,
      };
      delete entry.digitalRush;
      if (verbose) console.log(`  [PostProcess] ${entry.title}: Promoted digitalRush → lottery (has lottery language)`);
    }
  }

  // 3. Deduplicate lottery & specialLottery when same price (with tolerance)
  if (entry.lottery && entry.specialLottery) {
    const normPlatform = (p) => (p || '').toLowerCase().replace(/\s*(lottery|digital)\s*/g, '').trim();
    const samePlatform = normPlatform(entry.lottery.platform) === normPlatform(entry.specialLottery.platform);
    const priceDiff = Math.abs(entry.lottery.price - entry.specialLottery.price);
    const priceClose = priceDiff < 2 || priceDiff / Math.max(entry.lottery.price, entry.specialLottery.price) < 0.1;
    if (priceClose && samePlatform) {
      // If specialLottery has a distinctive name, it's the real program — remove lottery
      if (entry.specialLottery.name && entry.specialLottery.name !== 'Special Lottery') {
        delete entry.lottery;
        if (verbose) console.log(`  [PostProcess] ${entry.title}: Removed lottery (duplicate of named specialLottery "${entry.specialLottery.name}")`);
      } else {
        delete entry.specialLottery;
        if (verbose) console.log(`  [PostProcess] ${entry.title}: Removed duplicate specialLottery (same as lottery)`);
      }
    }
  }

  // 4. If only specialLottery exists (no lottery), promote it to lottery
  if (entry.specialLottery && !entry.lottery) {
    entry.lottery = {
      type: 'digital',
      platform: entry.specialLottery.platform,
      url: entry.specialLottery.url,
      price: entry.specialLottery.price,
      time: entry.specialLottery.time || entry.specialLottery.instructions,
      instructions: entry.specialLottery.instructions,
    };
    delete entry.specialLottery;
    if (verbose) console.log(`  [PostProcess] ${entry.title}: Promoted specialLottery → lottery (only lottery program)`);
  }

  // 5. Deduplicate rush & lottery when same price+platform (keep lottery if it's a real lottery)
  if (entry.lottery && entry.rush) {
    if (entry.lottery.price === entry.rush.price &&
        (entry.rush.type === 'digital' || !entry.rush.location)) {
      // Digital rush duplicating lottery → remove rush
      delete entry.rush;
      if (verbose) console.log(`  [PostProcess] ${entry.title}: Removed duplicate rush (same as lottery)`);
    }
  }

  // 6. Deduplicate digitalRush & rush when both exist and are TodayTix
  if (entry.digitalRush && entry.rush) {
    if (entry.rush.type === 'digital' &&
        entry.rush.platform === entry.digitalRush.platform &&
        entry.rush.price === entry.digitalRush.price) {
      delete entry.rush;
      if (verbose) console.log(`  [PostProcess] ${entry.title}: Removed duplicate rush (same as digitalRush)`);
    }
  }

  // 7. Remove standingRoom if price matches a special program (LincTix, HipTix, etc.)
  if (entry.standingRoom && entry.special) {
    if (entry.standingRoom.price === entry.special.price) {
      delete entry.standingRoom;
      if (verbose) console.log(`  [PostProcess] ${entry.title}: Removed standingRoom (duplicate of special program)`);
    }
  }
  // Also check for non-integer SRO prices that suggest misclassification
  if (entry.standingRoom && !Number.isInteger(entry.standingRoom.price)) {
    if (verbose) console.log(`  [PostProcess] ${entry.title}: Suspicious SRO price $${entry.standingRoom.price} (non-integer)`);
    // If there's no explicit "standing room" in instructions, likely misclassified
    const sroText = JSON.stringify(entry.standingRoom).toLowerCase();
    if (!sroText.includes('standing') && !sroText.includes('sro') && !sroText.includes('sold out')) {
      delete entry.standingRoom;
      if (verbose) console.log(`  [PostProcess] ${entry.title}: Removed non-integer SRO (likely misclassified)`);
    }
  }

  return entry;
}

// ==================== Twopenny Theatre (West End) ====================

const TWOPENNY_URL = 'https://twopennytheatre.com/the-best-discounts-for-every-show-in-london/';

async function scrapeTwopenny() {
  if (!ANTHROPIC_KEY) {
    console.error('[Twopenny] ANTHROPIC_API_KEY not set — skipping');
    return {};
  }

  console.log('\n[Twopenny] Fetching West End lottery/rush data...');
  const result = await fetchContent(TWOPENNY_URL, { renderJs: false });

  if (!result) {
    console.error('[Twopenny] Failed to fetch page — skipping');
    return {};
  }

  let pageText = result.content;
  if (result.format === 'html') {
    pageText = htmlToText(pageText);
  }

  if (pageText.length < 1000) {
    console.error(`[Twopenny] Page too short (${pageText.length} chars) — skipping`);
    return {};
  }

  console.log(`[Twopenny] Got page (${pageText.length} chars), extracting via LLM...`);

  const extracted = await extractTwopennyWithLLM(pageText);
  if (!extracted || extracted.length === 0) {
    console.error('[Twopenny] LLM extraction returned no results — skipping');
    return {};
  }

  console.log(`[Twopenny] LLM extracted ${extracted.length} valid shows`);
  return mapTwopennyToShows(extracted);
}

async function extractTwopennyWithLLM(pageText) {
  const prompt = `Extract lottery/rush/day seat data from this London West End theatre discount page.

Return ONLY a JSON array (no markdown fences, no explanation). Each element:
{
  "title": "Show Title",
  "lottery": { "type": "digital", "platform": "...", "price": 25, "time": "...", "instructions": "..." } or null,
  "rush": { "type": "general|digital", "platform": "...", "price": 30, "time": "...", "instructions": "..." } or null,
  "digitalRush": { "platform": "...", "price": 30, "time": "...", "instructions": "..." } or null
}

CRITICAL classification rules for London/West End:
- LOTTERY = random drawing/selection. Winners are chosen randomly. Uses words like "lottery", "draw", "winners selected".
- RUSH / DAY SEATS = first-come first-served. No random drawing. Uses words like "rush", "day seats", "released", "available".
- DIGITAL RUSH = rush tickets available via app (TodayTix). If the platform is TodayTix and tickets are first-come, classify as "digitalRush".
- GENERAL RUSH = rush tickets from box office or show website.
- If a show has BOTH a TodayTix rush AND a website rush, include BOTH: TodayTix as "digitalRush" and website as "rush".

Other rules:
- price must be a number (no £ symbol)
- platform should be one of: "TodayTix", "show website", "InYouGo", "Disney website", "National Theatre website", or the specific site name
- Only include fields that actually exist in the text
- Do not invent data not in the text
- Do NOT include null-valued fields — omit them entirely

Article:
${pageText}`;

  try {
    const response = await httpsRequest('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_SONNET,
        max_tokens: 8000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const parsed = JSON.parse(response);
    const text = parsed.content?.[0]?.text;

    if (!text) throw new Error('No text in LLM response');

    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array found in LLM response');

    const shows = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(shows)) throw new Error('LLM response is not an array');

    const valid = shows.filter(entry => {
      if (!entry.title || typeof entry.title !== 'string') return false;
      return !!(entry.lottery || entry.rush || entry.digitalRush);
    });

    console.log(`  [LLM] ${shows.length} extracted, ${valid.length} valid`);
    return valid;

  } catch (err) {
    console.error(`[Twopenny] LLM extraction failed: ${err.message}`);
    return null;
  }
}

function mapTwopennyToShows(extracted) {
  const result = {};
  const unmatched = [];

  for (const entry of extracted) {
    // Post-process: TodayTix rush → digitalRush (but keep lotteries as lotteries — WE has TodayTix lotteries)
    if (entry.rush && entry.rush.platform === 'TodayTix') {
      entry.digitalRush = entry.rush;
      entry.digitalRush.type = 'digital';
      delete entry.rush;
    }

    const resolved = resolveWeShowId(entry.title);
    if (!resolved) {
      unmatched.push(entry.title);
      continue;
    }

    const showEntry = {};
    for (const field of ['lottery', 'rush', 'digitalRush']) {
      if (entry[field]) showEntry[field] = entry[field];
    }

    result[resolved.id] = showEntry;
  }

  if (unmatched.length > 0) {
    console.log(`\n[Twopenny] ${unmatched.length} unmatched titles:`);
    unmatched.forEach(t => console.log(`  ? "${t}"`));
  }

  console.log(`[Twopenny] Mapped ${Object.keys(result).length} shows to WE IDs`);
  return result;
}

// ==================== Playbill Show Mapping ====================

function mapPlaybillToShows(extracted) {
  const result = {};
  const unmatched = [];

  for (const entry of extracted) {
    // Post-process to fix common LLM misclassifications
    postProcessPlaybillEntry(entry);

    const resolved = resolveShowId(entry.title);
    if (!resolved) {
      unmatched.push(entry.title);
      continue;
    }

    const showEntry = {};
    const fields = [
      'lottery', 'rush', 'digitalRush', 'standingRoom', 'studentRush',
      'specialLottery', 'under30', 'special', 'studentTickets', 'militaryTickets',
    ];
    for (const field of fields) {
      if (entry[field]) showEntry[field] = entry[field];
    }

    result[resolved.id] = showEntry;
  }

  if (unmatched.length > 0) {
    console.log(`\n[Playbill] ${unmatched.length} unmatched titles:`);
    unmatched.forEach(t => console.log(`  ? "${t}"`));
  }

  console.log(`[Playbill] Mapped ${Object.keys(result).length} shows to IDs`);
  return result;
}

// ==================== Backup & Safety ====================

function backupExisting() {
  if (!fs.existsSync(OUTPUT_PATH)) return;

  const backupPath = OUTPUT_PATH.replace('.json', `.backup-${Date.now()}.json`);
  fs.copyFileSync(OUTPUT_PATH, backupPath);
  console.log(`[Backup] Saved to ${path.basename(backupPath)}`);

  // Keep only last 5 backups
  const dir = path.dirname(OUTPUT_PATH);
  const backups = fs.readdirSync(dir)
    .filter(f => f.startsWith('lottery-rush.backup-'))
    .sort()
    .reverse();
  for (const old of backups.slice(5)) {
    fs.unlinkSync(path.join(dir, old));
  }
}

/**
 * Incrementally merge scraped data into existing data.
 * A scraper can add or update fields, but never delete them.
 * Sub-field level merge: new prices update, but existing time/instructions are preserved.
 */
function mergeIntoExisting(existing, scraped, source) {
  const changes = [];

  for (const [showId, newData] of Object.entries(scraped)) {
    if (!existing.shows[showId]) {
      // New show — add it with metadata
      existing.shows[showId] = {
        ...newData,
        _lastScrapedFrom: source,
        _lastScrapedAt: new Date().toISOString(),
      };
      changes.push({ showId, type: 'added', source });
      continue;
    }

    const current = existing.shows[showId];
    const allFields = [
      'lottery', 'rush', 'digitalRush', 'studentRush', 'standingRoom',
      'specialLottery', 'under30', 'special', 'studentTickets', 'militaryTickets',
    ];

    // Respect _skipFields: fields manually verified as not applicable for this show
    const skipFields = new Set(current._skipFields || []);

    for (const field of allFields) {
      if (!newData[field]) continue; // Source didn't have this — preserve existing
      if (skipFields.has(field)) {
        console.log(`  [Merge] Skipping ${showId}.${field}: in _skipFields`);
        continue;
      }

      if (!current[field]) {
        // New field for this show
        current[field] = newData[field];
        changes.push({ showId, type: 'added-field', field, source });
      } else {
        // Merge sub-fields: update price/url/platform, preserve time/instructions
        let changed = false;
        for (const [key, value] of Object.entries(newData[field])) {
          if (value !== null && value !== undefined && value !== '') {
            if (current[field][key] !== value) {
              // Don't replace a specific URL with a generic one
              if (key === 'url' && current[field][key] && !current[field][key].match(/^https?:\/\/[^/]+\/?$/)) {
                // Current URL has a path (specific) — only replace if new URL also has a path
                if (typeof value === 'string' && value.match(/^https?:\/\/[^/]+\/?$/)) {
                  continue; // Skip: new URL is generic, current is specific
                }
              }
              if (key === 'price') {
                const oldPrice = current[field][key];
                // Skip if price is manually pinned (with 90-day TTL)
                if (current[field]._verifiedPrice === oldPrice && value !== oldPrice) {
                  const verifiedAt = current[field]._verifiedAt ? new Date(current[field]._verifiedAt) : null;
                  const daysSinceVerified = verifiedAt ? (Date.now() - verifiedAt.getTime()) / (1000 * 60 * 60 * 24) : 0;
                  if (daysSinceVerified > 90) {
                    console.warn(`  ⚠️  [Pin Expired] ${showId}.${field}: pin was set ${Math.round(daysSinceVerified)}d ago — allowing update $${oldPrice} → $${value}`);
                    delete current[field]._verifiedPrice;
                    delete current[field]._verifiedAt;
                  } else {
                    console.log(`  [Merge] Skipping ${showId}.${field}.price: pinned at $${oldPrice} (${source} says $${value}, pin ${verifiedAt ? Math.round(daysSinceVerified) + 'd old' : 'no expiry date'})`);
                    continue;
                  }
                }
                const drift = oldPrice > 0 ? Math.abs(value - oldPrice) / oldPrice : 0;
                changes.push({
                  showId, type: 'updated', field, key,
                  old: oldPrice, new: value, source,
                });
                if (drift > 0.3) {
                  console.warn(`  ⚠️  [Price Drift] ${showId}.${field}: $${oldPrice} → $${value} (${(drift * 100).toFixed(0)}% change from ${source}) — verify manually`);
                }
              }
              current[field][key] = value;
              changed = true;
            }
          }
        }
        if (changed && verbose) {
          console.log(`  [Merge] Updated ${showId}.${field} from ${source}`);
        }
      }
    }

    // Update provenance metadata
    current._lastScrapedFrom = source;
    current._lastScrapedAt = new Date().toISOString();
  }

  return changes;
}

/**
 * Guard: abort if the set of show IDs changed too dramatically.
 */
function validateShowIdStability(original, updated) {
  const oldIds = new Set(Object.keys(original.shows || {}));
  const newIds = new Set(Object.keys(updated.shows || {}));

  const added = [...newIds].filter(id => !oldIds.has(id));
  const removed = [...oldIds].filter(id => !newIds.has(id));

  if (added.length > 5 || removed.length > 3) {
    if (forceGuard) {
      console.warn(`\n[Guard] WARNING: ${added.length} added, ${removed.length} removed — bypassed with --force`);
    } else {
      console.error(`\n[Guard] ABORT: Too many ID changes (${added.length} added, ${removed.length} removed)`);
      if (added.length > 0) console.error(`  Added: ${added.join(', ')}`);
      if (removed.length > 0) console.error(`  Removed: ${removed.join(', ')}`);
      process.exit(1);
    }
  }

  if (verbose && (added.length > 0 || removed.length > 0)) {
    console.log(`[Guard] ID changes: +${added.length} -${removed.length} (within limits)`);
  }
}

/**
 * Remove entries for shows that have closed.
 * This is a lifecycle cleanup step, separate from the "scrapers never delete" rule.
 */
function cleanClosedShows(existing) {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const changes = [];

  for (const showId of Object.keys(existing.shows)) {
    const show = showsData.shows.find(s => s.id === showId);
    if (show && show.status === 'closed') {
      delete existing.shows[showId];
      changes.push({ showId, type: 'removed-closed' });
    } else if (!show) {
      // Orphaned entry — show ID not in shows.json at all
      delete existing.shows[showId];
      changes.push({ showId, type: 'removed-orphan' });
    }
  }

  return changes;
}

// ==================== URL & Price Sanitization ====================

/** Known generic/useless URLs that don't link to a specific show */
const GENERIC_URLS = [
  'my.socialtoaster.com/st/rush_select/',
  'my.socialtoaster.com/st/lottery_select/',
];

/** URLs that are platform homepages (not show-specific) — unhelpful for users.
 *  Exceptions: Telecharge rush portal and LuckySeat are valid destinations
 *  because their show pages are behind auth/JS and not directly linkable. */
function isGenericPlatformUrl(url) {
  if (!url) return false;
  const trimmed = url.trim();
  // Telecharge rush portal lists all shows with rush policies
  if (/rush\.telecharge\.com/i.test(trimmed)) return false;
  // LuckySeat show pages are behind auth/JS — homepage is the entry point
  if (/luckyseat\.com/i.test(trimmed)) return false;
  // A URL with no path (just domain) is generic and useless
  return /^https?:\/\/[^/]+\/?$/.test(trimmed);
}

function isGenericUrl(url) {
  if (!url) return false;
  const lower = url.toLowerCase();
  return GENERIC_URLS.some(g => lower.includes(g));
}

/**
 * Normalize a URL: ensure https:// prefix, strip trailing whitespace.
 * Returns null for generic/useless URLs.
 */
function normalizeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  url = url.trim();
  if (isGenericUrl(url)) return null;
  if (!/^https?:\/\//i.test(url)) {
    url = 'https://' + url;
  }
  // Normalize domain to lowercase (paths may be case-sensitive)
  try {
    const parsed = new URL(url);
    url = parsed.protocol + '//' + parsed.host.toLowerCase() + parsed.pathname + parsed.search + parsed.hash;
  } catch { /* keep as-is if unparseable */ }
  // Reject generic platform homepages (todaytix.com/, etc.)
  if (isGenericPlatformUrl(url)) return null;
  return url;
}

/** Known intentional fractional prices (e.g., Club 2064 = $20.64) */
const ALLOWED_FRACTIONAL_PRICES = new Set([20.64, 29.5, 37.5]); // WE prices like £29.50, £37.50

/** Validate a price: must be positive, integer (for lottery/rush/SRO), and within range. */
function validatePrice(price, field, showId) {
  if (typeof price !== 'number' || isNaN(price)) return null;
  if (price <= 0) {
    console.warn(`  [Sanitize] ${showId}.${field}: Removed $0 price`);
    return null;
  }
  if (price > 200) {
    console.warn(`  [Sanitize] ${showId}.${field}: Removed $${price} price (>$200, likely error)`);
    return null;
  }
  // Lottery, rush, and SRO prices are almost always whole dollars.
  // Allow known intentional fractional prices (e.g., $20.64 for Club 2064).
  if (!Number.isInteger(price) && !ALLOWED_FRACTIONAL_PRICES.has(price)) {
    const rounded = Math.round(price);
    console.warn(`  [Sanitize] ${showId}.${field}: Rounded $${price} → $${rounded}`);
    return rounded;
  }
  return price;
}

/**
 * Sanitize all data before writing. Catches classes of problems:
 * 1. Empty entries (metadata only, zero programs)
 * 2. Invalid/suspicious prices ($0, fractional, out-of-range)
 * 3. Missing https:// on URLs
 * 4. Generic SocialToaster URLs that don't link to a specific show
 * 5. Duplicate rush/digitalRush with same platform+price
 * 6. Null-valued fields
 */
function sanitizeData(existing) {
  const fixes = [];
  const PROGRAM_FIELDS = [
    'lottery', 'rush', 'digitalRush', 'studentRush', 'standingRoom',
    'specialLottery', 'under30', 'special', 'studentTickets', 'militaryTickets',
  ];

  for (const [showId, show] of Object.entries(existing.shows)) {
    // --- Remove null-valued top-level fields ---
    for (const key of Object.keys(show)) {
      if (show[key] === null && key !== '_lastScrapedFrom' && key !== '_lastScrapedAt') {
        delete show[key];
      }
    }

    // --- Validate prices and normalize URLs on every program field ---
    for (const field of PROGRAM_FIELDS) {
      if (!show[field]) continue;

      // Price validation
      if ('price' in show[field]) {
        const cleaned = validatePrice(show[field].price, field, showId);
        if (cleaned === null) {
          // Invalid price → remove the whole program (a program without a price is useless)
          delete show[field];
          fixes.push(`${showId}: Removed ${field} (invalid price)`);
          continue;
        }
        show[field].price = cleaned;
      }
      if ('priceWeekend' in show[field]) {
        const cleaned = validatePrice(show[field].priceWeekend, field + '.priceWeekend', showId);
        if (cleaned === null) {
          delete show[field].priceWeekend;
        } else {
          show[field].priceWeekend = cleaned;
        }
      }

      // URL normalization — replace generic URLs with null, add https://
      if ('url' in show[field]) {
        const normalized = normalizeUrl(show[field].url);
        if (normalized) {
          if (normalized !== show[field].url) {
            fixes.push(`${showId}.${field}: Fixed URL → ${normalized}`);
          }
          show[field].url = normalized;
        } else if (show[field].url) {
          fixes.push(`${showId}.${field}: Removed generic/invalid URL`);
          delete show[field].url;
        }
      }

      // Clean up null/empty sub-fields
      for (const k of Object.keys(show[field])) {
        if (show[field][k] === null || show[field][k] === '') {
          delete show[field][k];
        }
      }

      // Auto-populate URL for platforms where we know the destination
      if (show[field].platform && !show[field].url) {
        const platformLower = show[field].platform.toLowerCase();
        if (platformLower === 'telecharge') {
          show[field].url = 'https://rush.telecharge.com';
          fixes.push(`${showId}.${field}: Auto-populated Telecharge URL`);
        } else if (platformLower === 'broadway direct' && show[field].type === 'digital') {
          const slug = showId.replace(/-\d{4}$/, '').replace(/-broadway$/, '');
          show[field].url = `https://lottery.broadwaydirect.com/show/${slug}/`;
          fixes.push(`${showId}.${field}: Auto-populated Broadway Direct lottery URL`);
        } else if (platformLower === 'luckyseat') {
          // LuckySeat show pages are behind auth/JS — homepage is the entry point
          show[field].url = 'https://www.luckyseat.com';
          fixes.push(`${showId}.${field}: Auto-populated LuckySeat URL`);
        }
        // TodayTix and LuckySeat URLs are NOT predictable from show names
        // — leave blank rather than linking to a useless homepage
      }

      // Strip generic platform homepage URLs (no show-specific path)
      if (show[field].url && isGenericPlatformUrl(show[field].url)) {
        fixes.push(`${showId}.${field}: Removed generic homepage URL "${show[field].url}"`);
        delete show[field].url;
      }
    }

    // --- Deduplicate rush/digitalRush with same platform+price ---
    if (show.rush && show.digitalRush) {
      const samePlatform = show.rush.platform && show.digitalRush.platform &&
        show.rush.platform.toLowerCase() === show.digitalRush.platform.toLowerCase();
      if (samePlatform && show.rush.price === show.digitalRush.price) {
        // Keep digitalRush (has more detail typically), remove rush
        if (show.rush.type === 'digital' || !show.rush.location) {
          // Merge any extra fields from rush into digitalRush
          for (const k of ['time', 'instructions', 'location']) {
            if (show.rush[k] && !show.digitalRush[k]) show.digitalRush[k] = show.rush[k];
          }
          delete show.rush;
          fixes.push(`${showId}: Removed duplicate rush (same as digitalRush, ${show.digitalRush.platform} $${show.digitalRush.price})`);
        }
      }
    }

    // --- Deduplicate lottery/digitalRush with same platform+price ---
    if (show.lottery && show.digitalRush) {
      const samePlatform = show.lottery.platform && show.digitalRush.platform &&
        show.lottery.platform.toLowerCase() === show.digitalRush.platform.toLowerCase();
      const sameUrl = show.lottery.url && show.digitalRush.url &&
        show.lottery.url.toLowerCase() === show.digitalRush.url.toLowerCase();
      if ((samePlatform || sameUrl) && show.lottery.price === show.digitalRush.price) {
        // Keep lottery (primary), merge any extra fields from digitalRush
        for (const k of ['time', 'instructions']) {
          if (show.digitalRush[k] && !show.lottery[k]) show.lottery[k] = show.digitalRush[k];
        }
        delete show.digitalRush;
        fixes.push(`${showId}: Removed duplicate digitalRush (same as lottery, $${show.lottery.price})`);
      }
    }

    // --- Deduplicate rush that duplicates lottery (same price, digital rush without location) ---
    if (show.lottery && show.rush) {
      if (show.lottery.price === show.rush.price &&
          (show.rush.type === 'digital' || !show.rush.location) &&
          (!show.rush.platform || !show.rush.url)) {
        delete show.rush;
        fixes.push(`${showId}: Removed rush (duplicate of lottery, same price $${show.lottery.price})`);
      }
    }

    // --- Remove non-integer standingRoom prices (SRO is always whole dollars) ---
    if (show.standingRoom && !Number.isInteger(show.standingRoom.price)) {
      fixes.push(`${showId}: Removed standingRoom $${show.standingRoom.price} (non-integer, likely misclassified)`);
      delete show.standingRoom;
    }

    // --- Deduplicate lottery & specialLottery ---
    if (show.lottery && show.specialLottery) {
      const priceDiff = Math.abs(show.lottery.price - show.specialLottery.price);
      const priceClose = priceDiff < 2 || priceDiff / Math.max(show.lottery.price, show.specialLottery.price) < 0.1;
      const normPlatform = (p) => (p || '').toLowerCase().replace(/\s*(lottery|digital)\s*/g, '').trim();
      const platformMatch = !show.lottery.platform || !show.specialLottery.platform ||
        normPlatform(show.lottery.platform) === normPlatform(show.specialLottery.platform);
      if (priceClose && platformMatch) {
        if (show.specialLottery.name && show.specialLottery.name !== 'Special Lottery') {
          for (const k of ['platform', 'url', 'time', 'instructions']) {
            if (!show.specialLottery[k] && show.lottery[k]) {
              show.specialLottery[k] = show.lottery[k];
            }
          }
          delete show.lottery;
          fixes.push(`${showId}: Removed lottery (same as specialLottery "${show.specialLottery.name}")`);
        } else {
          delete show.specialLottery;
          fixes.push(`${showId}: Removed specialLottery (duplicate of lottery)`);
        }
      }
    }

    // --- Promote lone specialLottery → lottery ---
    if (show.specialLottery && !show.lottery) {
      show.lottery = {
        type: 'digital',
        platform: show.specialLottery.platform,
        url: show.specialLottery.url,
        price: show.specialLottery.price,
        time: show.specialLottery.time || show.specialLottery.instructions,
        instructions: show.specialLottery.instructions,
      };
      for (const k of Object.keys(show.lottery)) {
        if (show.lottery[k] === null || show.lottery[k] === undefined) delete show.lottery[k];
      }
      delete show.specialLottery;
      fixes.push(`${showId}: Promoted specialLottery → lottery (only lottery program)`);
    }

    // --- Remove empty entries (metadata only, zero programs) ---
    const hasPrograms = PROGRAM_FIELDS.some(f => show[f]);
    if (!hasPrograms) {
      delete existing.shows[showId];
      fixes.push(`${showId}: Removed empty entry (no programs)`);
    }
  }

  if (fixes.length > 0) {
    console.log(`\n[Sanitize] ${fixes.length} fixes applied:`);
    fixes.forEach(f => console.log(`  - ${f}`));
  }

  return fixes;
}

// ==================== Summary ====================

function printSummary(changes) {
  if (changes.length === 0) {
    console.log('\n[Summary] No changes');
    return;
  }

  console.log(`\n[Summary] ${changes.length} changes:`);
  for (const c of changes) {
    switch (c.type) {
      case 'added':
        console.log(`  + ${c.showId} (added from ${c.source})`);
        break;
      case 'added-field':
        console.log(`  + ${c.showId} ${c.field} (new field from ${c.source})`);
        break;
      case 'updated':
        console.log(`  ~ ${c.showId} ${c.field}.${c.key}: ${c.old} → ${c.new} (from ${c.source})`);
        break;
      case 'removed-closed':
        console.log(`  - ${c.showId} (removed, show closed)`);
        break;
      case 'removed-orphan':
        console.log(`  - ${c.showId} (removed, not in shows.json)`);
        break;
    }
  }
}

// ==================== TodayTix URL Resolution ====================

/**
 * For any TodayTix-platform entry missing a show-specific URL,
 * query the TodayTix public API to resolve the show's ID and build a URL.
 * TodayTix ID-based URLs (e.g., /nyc/shows/44515) auto-redirect to the
 * full slug URL (e.g., /nyc/shows/44515-dog-day-afternoon).
 */
async function resolveTodayTixUrls(existing) {
  const TODAYTIX_FIELDS = ['digitalRush', 'lottery', 'rush'];
  const toResolve = [];

  for (const [showId, show] of Object.entries(existing.shows)) {
    for (const field of TODAYTIX_FIELDS) {
      const entry = show[field];
      if (!entry) continue;
      if (entry.platform?.toLowerCase() !== 'todaytix') continue;
      if (entry.url && !isGenericPlatformUrl(entry.url)) continue; // Already has specific URL
      // Find show title — check both Broadway and WE show lists
      const matchedShow = allLoadedShows.find(s => s.id === showId);
      if (matchedShow) {
        const isWE = matchedShow.category === 'west-end' || matchedShow.category === 'off-west-end';
        toResolve.push({ showId, field, title: matchedShow.title, location: isWE ? 2 : 1, region: isWE ? 'london' : 'nyc' });
      }
    }
  }

  if (toResolve.length === 0) return 0;

  console.log(`\n[TodayTix] Resolving ${toResolve.length} missing URLs...`);
  let resolved = 0;

  // Revert an entry to platform='show website' when no TodayTix URL is available.
  // validate-data.js iterates {lottery, digitalRush}; both error on
  // known-platform-without-URL. Reverting downgrades to a warning and keeps
  // the entry visible. Also scrubs TodayTix mentions from instructions so the
  // UI doesn't show "Enter on show website" next to "via TodayTix app".
  const revertToShowWebsite = (showId, field, reason) => {
    if (field !== 'lottery' && field !== 'digitalRush') return; // rush keeps classification
    const entry = existing.shows[showId][field];
    entry.platform = 'show website';
    if (typeof entry.instructions === 'string' && /todaytix/i.test(entry.instructions)) {
      entry.instructions = entry.instructions.replace(/\s*(?:via |on |through )?todaytix(?:\s+app)?/gi, '').replace(/\s+/g, ' ').trim();
      if (!entry.instructions) delete entry.instructions;
    }
    console.log(`  ✗ ${showId}.${field}: ${reason} — reverted platform to "show website"`);
  };

  for (const { showId, field, title, location, region } of toResolve) {
    try {
      const url = `https://api.todaytix.com/api/v2/shows?query=${encodeURIComponent(cleanSearchTitle(title))}&location=${location}&limit=3`;
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn(`  [TodayTix] API error for "${title}": ${resp.status}`);
        revertToShowWebsite(showId, field, `TodayTix API ${resp.status} for "${title}"`);
        continue;
      }
      const data = await resp.json();
      const results = data.data || [];

      // Find best match: exact title match (case-insensitive)
      const match = results.find(r =>
        r.displayName?.toLowerCase() === title.toLowerCase()
      ) || results[0]; // Fallback to first result

      if (match && match.id) {
        const todaytixUrl = `https://www.todaytix.com/${region}/shows/${match.id}`;
        existing.shows[showId][field].url = todaytixUrl;
        resolved++;
        console.log(`  ✓ ${showId}.${field}: ${todaytixUrl} (matched "${match.displayName}")`);
      } else if (field === 'lottery' || field === 'digitalRush') {
        revertToShowWebsite(showId, field, `no TodayTix match for "${title}"`);
      } else {
        console.log(`  ✗ ${showId}.${field}: no TodayTix match for "${title}"`);
      }

      // Rate limit: 200ms between requests
      await new Promise(r => setTimeout(r, 200));
    } catch (e) {
      console.warn(`  [TodayTix] Failed for "${title}": ${e.message}`);
      revertToShowWebsite(showId, field, `TodayTix lookup threw for "${title}": ${e.message}`);
    }
  }
  return resolved;
}

// ==================== Cross-Source Price Comparison ====================

/**
 * After merging, report any price discrepancies between sources.
 * This catches cases where bwayrush and Playbill disagree.
 */
function printPriceComparisonReport(allChanges) {
  const priceChanges = allChanges.filter(c => c.type === 'updated' && c.key === 'price');
  if (priceChanges.length === 0) return;

  console.log('\n[Price Comparison] Source disagreements:');
  let conflicts = 0;

  for (const change of priceChanges) {
    const pctChange = change.old > 0 ? ((change.new - change.old) / change.old * 100).toFixed(0) : '∞';
    const marker = Math.abs(parseFloat(pctChange)) > 20 ? '⚠️' : '  ';
    console.log(`  ${marker} ${change.showId}.${change.field}: $${change.old} → $${change.new} (${pctChange}%, from ${change.source})`);
    if (Math.abs(parseFloat(pctChange)) > 20) conflicts++;
  }

  if (conflicts > 0) {
    console.log(`  → ${conflicts} significant discrepancies (>20%). Consider pinning verified prices with _verifiedPrice.`);
  } else {
    console.log(`  → All price changes are minor adjustments.`);
  }
}

// ==================== Main ====================

async function main() {
  console.log('='.repeat(60));
  console.log('Broadway Lottery/Rush Scraper — Robust System');
  console.log('='.repeat(60));
  if (dryRun) console.log('[Mode] DRY RUN — no files will be written\n');
  if (sourceFilter) console.log(`[Mode] Source filter: ${sourceFilter}\n`);

  // Load existing data
  let existing = { lastUpdated: '', source: '', shows: {} };
  if (fs.existsSync(OUTPUT_PATH)) {
    existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  }
  const originalSnapshot = JSON.parse(JSON.stringify(existing));

  const allChanges = [];

  // Scrape sources
  if (!sourceFilter || sourceFilter === 'bwayrush') {
    const bwayrushData = await scrapeBwayRush();
    if (Object.keys(bwayrushData).length > 0) {
      const changes = mergeIntoExisting(existing, bwayrushData, 'bwayrush');
      allChanges.push(...changes);
    }
  }

  if (!sourceFilter || sourceFilter === 'playbill') {
    const playbillData = await scrapePlaybill();
    if (Object.keys(playbillData).length > 0) {
      const changes = mergeIntoExisting(existing, playbillData, 'playbill');
      allChanges.push(...changes);
    }
  }

  if (!sourceFilter || sourceFilter === 'twopenny') {
    const twopennyData = await scrapeTwopenny();
    if (Object.keys(twopennyData).length > 0) {
      const changes = mergeIntoExisting(existing, twopennyData, 'twopenny');
      allChanges.push(...changes);
    }
  }

  // Sanitize all data: prices, URLs, duplicates, empty entries
  const sanitizeFixes = sanitizeData(existing);

  // Clean closed shows
  const closedChanges = cleanClosedShows(existing);
  allChanges.push(...closedChanges);

  // Resolve TodayTix URLs via API for entries missing show-specific links
  const urlsResolved = await resolveTodayTixUrls(existing);
  if (urlsResolved > 0) allChanges.push({ type: 'urls', count: urlsResolved });

  // Cross-source price comparison report
  printPriceComparisonReport(allChanges);

  // Update top-level metadata
  existing.lastUpdated = new Date().toISOString();
  existing.source = PLAYBILL_URL;

  // Validate stability against original
  validateShowIdStability(originalSnapshot, existing);

  // Summary
  printSummary(allChanges);

  if (allChanges.length === 0) {
    console.log('\n[Result] No changes — data is up to date');
    return;
  }

  if (dryRun) {
    console.log(`\n[Dry Run] Would write ${Object.keys(existing.shows).length} shows to lottery-rush.json`);
    return;
  }

  // Backup before writing
  backupExisting();

  // Write output
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(existing, null, 2) + '\n');
  console.log(`\n[Output] Wrote lottery-rush.json with ${Object.keys(existing.shows).length} shows`);

  // Run tag sync
  console.log('\n[Tags] Syncing tags in shows.json...');
  const syncScript = path.join(__dirname, 'sync-lottery-rush-tags.js');
  if (fs.existsSync(syncScript)) {
    const { execSync } = require('child_process');
    execSync(`node ${syncScript}`, { stdio: 'inherit' });
  }

  console.log('\n' + '='.repeat(60));
  console.log('Done!');
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('\n[Fatal]', err.message);
  if (verbose) console.error(err.stack);
  process.exit(1);
});
