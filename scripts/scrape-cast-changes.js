#!/usr/bin/env node
/**
 * scrape-cast-changes.js — Broadway Cast Change Tracker
 *
 * Three data sources:
 * 1. Article scraper (Playbill + BroadwayWorld casting news)
 * 2. Official show website cast page diffing
 * 3. Reddit r/Broadway monitoring
 *
 * Key design principles:
 * - Incremental merge (never wholesale replace)
 * - Pre-write backup with rotation
 * - Idempotent expired event cleanup (appliedAt flag)
 * - Time-budgeted scraping to stay within CI timeout
 * - Production filter to exclude tour/regional/West End content
 *
 * Usage:
 *   node scripts/scrape-cast-changes.js                          # Full scrape
 *   node scripts/scrape-cast-changes.js --source=articles        # Single source
 *   node scripts/scrape-cast-changes.js --source=reddit          # Single source
 *   node scripts/scrape-cast-changes.js --source=official-sites  # Single source
 *   node scripts/scrape-cast-changes.js --shows=X,Y,Z            # Specific shows
 *   node scripts/scrape-cast-changes.js --show=X                 # Single show
 *   node scripts/scrape-cast-changes.js --dry-run                # Preview only
 *   node scripts/scrape-cast-changes.js --verbose                # Verbose logging
 *   node scripts/scrape-cast-changes.js --high-freq-only         # Only high-rotation shows
 *   node scripts/scrape-cast-changes.js --force                  # Bypass stability guards
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { serpQuery } = require('./lib/url-discovery');
const { matchTitleToShow, loadShows } = require('./lib/show-matching');
const { isNotBroadway } = require('./lib/content-filters');
const { isLondonMarket } = require('./lib/venue-classification');

// ==================== Configuration ====================

const OUTPUT_PATH = path.join(__dirname, '../data/cast-changes.json');
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');
const AUDIT_DIR = path.join(__dirname, '../data/audit');

// CLI args
const args = process.argv.slice(2);
const sourceFilter = args.find(a => a.startsWith('--source='))?.split('=')[1] || 'all';
const showsArg = args.find(a => a.startsWith('--shows='))?.split('=')[1];
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const highFreqOnly = args.includes('--high-freq-only');
const forceRun = args.includes('--force');

// API keys
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

// High-frequency rotation shows (checked more aggressively)
const HIGH_FREQ_SHOWS = new Set([
  'chicago-1996', 'six-2021', 'hadestown-2019', 'the-great-gatsby-2024',
]);

// Time budget (in ms) — article scraping gets 45 minutes to cover all open shows
const ARTICLE_TIME_BUDGET = 45 * 60 * 1000;
const TOTAL_START_TIME = Date.now();

// Today's date string
const TODAY = new Date().toISOString().split('T')[0];

// Load shows data
const allShows = loadShows();

// Stats tracking
const stats = {
  articlesSearched: 0,
  articlesFetched: 0,
  articlesExtracted: 0,
  redditSearches: 0,
  redditPostsAnalyzed: 0,
  officialSitesChecked: 0,
  eventsAdded: 0,
  eventsUpgraded: 0,
  eventsCleaned: 0,
  showsCleaned: 0,
  errors: [],
};

// ==================== HTTP Utilities ====================

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Sanitize text to remove problematic Unicode characters
 */
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return text;
  let sanitized = text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  return sanitized;
}

/**
 * Generic HTTPS request helper (follows lottery-rush.js pattern)
 */
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
    req.setTimeout(60000, () => req.destroy(new Error('Request timeout')));

    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

/**
 * Fetch HTML via ScrapingBee with retry
 */
async function fetchViaScrapingBee(url, options = {}) {
  if (!SCRAPINGBEE_KEY) throw new Error('SCRAPINGBEE_API_KEY required');

  const maxRetries = options.maxRetries || 2;
  const premiumProxy = options.premiumProxy ? '&premium_proxy=true' : '';
  const renderJs = options.renderJs ? '&render_js=true' : '&render_js=false';

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}${renderJs}${premiumProxy}`;
      return await new Promise((resolve, reject) => {
        const req = https.get(apiUrl, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              resolve(data);
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
            }
          });
        });
        req.on('error', reject);
        req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
      });
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        const delay = 5000 * (attempt + 1);
        if (verbose) console.log(`    Retry ${attempt + 1}/${maxRetries} after ${delay / 1000}s: ${e.message}`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/**
 * Fetch Reddit JSON via ScrapingBee premium proxy (same pattern as reddit scraper)
 */
async function fetchRedditJson(url, maxRetries = 2) {
  if (!SCRAPINGBEE_KEY) throw new Error('SCRAPINGBEE_API_KEY required');

  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=false&premium_proxy=true`;
      const data = await new Promise((resolve, reject) => {
        https.get(apiUrl, (res) => {
          let d = '';
          res.on('data', chunk => d += chunk);
          res.on('end', () => {
            if (res.statusCode === 200) {
              try { resolve(JSON.parse(d)); }
              catch (e) {
                if (d.includes('<html') || d.includes('<!DOCTYPE')) {
                  reject(new Error('Got HTML instead of JSON — Reddit may be blocking'));
                } else {
                  reject(new Error(`Failed to parse JSON: ${d.slice(0, 100)}`));
                }
              }
            } else {
              reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 100)}`));
            }
          });
        }).on('error', reject);
      });
      return data;
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        const delay = 5000 * (attempt + 1);
        if (verbose) console.log(`    Reddit retry ${attempt + 1}/${maxRetries}: ${e.message}`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/**
 * Google search via shared SERP provider chain (Bright Data first → ScrapingBee fallback)
 */
async function googleSearch(query) {
  try {
    const results = await serpQuery(query, { nbResults: 10 });
    if (!results) return [];
    return results.map(r => ({
      url: r.url,
      title: r.title || '',
      description: r.snippet || '',
    }));
  } catch (e) {
    if (verbose) console.log(`  [Google] Search failed: ${e.message}`);
    stats.errors.push(`Google search: ${e.message}`);
    return [];
  }
}

/**
 * Call Claude API for structured extraction
 */
async function callClaude(prompt, maxTokens = 4000) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY required');

  const response = await httpsRequest('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const parsed = JSON.parse(response);
  const text = parsed.content?.[0]?.text;
  if (!text) throw new Error('No text in Claude response');
  return text;
}

/**
 * Extract and validate JSON array from Claude response
 */
function parseClaudeJsonArray(text) {
  // Try to find a JSON array in the response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(parsed)) return [];
    return parsed;
  } catch (e) {
    // Cleanup attempt: remove trailing commas
    try {
      const cleaned = jsonMatch[0].replace(/,\s*([}\]])/g, '$1');
      const parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch (e2) {
      return [];
    }
  }
}

/**
 * Validate a cast change event object
 */
function validateEvent(event) {
  if (!event || typeof event !== 'object') return false;

  const validTypes = ['departure', 'arrival', 'absence', 'note'];
  if (!validTypes.includes(event.type)) return false;

  if (event.type !== 'note') {
    if (!event.name || typeof event.name !== 'string') return false;
  }

  // Validate date format if present
  if (event.date && !/^\d{4}-\d{2}-\d{2}$/.test(event.date) && !/^\d{4}-\d{2}$/.test(event.date)) {
    return false;
  }
  if (event.endDate && !/^\d{4}-\d{2}-\d{2}$/.test(event.endDate) && !/^\d{4}-\d{2}$/.test(event.endDate)) {
    return false;
  }

  return true;
}

/**
 * Strip HTML to plain text (simple version for article content)
 */
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// isNotBroadway() imported from ./lib/content-filters

/**
 * Additional tour-specific text checks for cast articles
 */
function isTourArticle(text) {
  const lower = text.toLowerCase();
  const tourPatterns = [
    /\b(national|north american|u\.?s\.?)\s+tour\b/,
    /\btour\s+(cast|company|production)\b/,
    /\btouring\s+(cast|company|production|schedule)\b/,
    /\b(first|second|third)\s+national\s+tour\b/,
    /\btour\s+stop\b/,
  ];
  return tourPatterns.some(p => p.test(lower));
}

// ==================== Source 1: Article Scraper ====================

/**
 * Search for and extract cast change events from Playbill + BroadwayWorld articles
 */
async function scrapeArticles(targetShows) {
  console.log('\n--- Source 1: Article Scraper (Playbill + BroadwayWorld) ---');

  if (!SCRAPINGBEE_KEY) {
    console.log('[Skip] No SCRAPINGBEE_API_KEY');
    return {};
  }
  if (!ANTHROPIC_KEY) {
    console.log('[Skip] No ANTHROPIC_API_KEY');
    return {};
  }

  const results = {};
  const startTime = Date.now();
  const seenUrls = new Set();

  // Process high-freq shows first
  const sortedShows = [...targetShows].sort((a, b) => {
    const aHigh = HIGH_FREQ_SHOWS.has(a.id) ? 0 : 1;
    const bHigh = HIGH_FREQ_SHOWS.has(b.id) ? 0 : 1;
    return aHigh - bHigh;
  });

  for (const show of sortedShows) {
    // Check time budget
    if (Date.now() - startTime > ARTICLE_TIME_BUDGET) {
      console.log(`[Budget] Article scraping time budget exceeded (${Math.round(ARTICLE_TIME_BUDGET / 60000)}min). Skipping remaining shows.`);
      break;
    }

    if (verbose) console.log(`\n  [Articles] Searching for ${show.title} (${show.id})`);

    // Build search queries
    const queries = [
      `site:playbill.com "${show.title}" (cast OR joining OR leaving OR replacing OR departure OR "final performance" OR "new star")`,
      `site:broadwayworld.com "${show.title}" broadway cast (change OR joining OR leaving OR replacing OR departure)`,
    ];

    // High-freq shows get extra queries
    if (HIGH_FREQ_SHOWS.has(show.id)) {
      queries.push(`site:playbill.com "${show.title}" broadway (starring OR "new cast" OR "stunt casting")`);
      queries.push(`site:broadwayworld.com "${show.title}" broadway (star OR starring OR "new cast")`);
    }

    // Collect article URLs from search results
    const articleUrls = [];
    for (const query of queries) {
      try {
        const searchResults = await googleSearch(query);
        stats.articlesSearched++;

        for (const result of searchResults) {
          if (!result.url) continue;
          if (seenUrls.has(result.url)) continue;
          seenUrls.add(result.url);

          // Filter: must be an article URL
          if (!result.url.includes('/article/') && !result.url.includes('/article-')) continue;

          // Filter: check title/description for tour/non-Broadway content
          const searchText = `${result.title} ${result.description}`;
          if (isNotBroadway(searchText, { allowOffBroadway: show.category === 'off-broadway', allowWestEnd: isLondonMarket(show.category) })) {
            if (verbose) console.log(`    [Skip] Non-Broadway: ${result.title}`);
            continue;
          }
          if (isTourArticle(searchText)) {
            if (verbose) console.log(`    [Skip] Tour article: ${result.title}`);
            continue;
          }

          articleUrls.push(result);
        }

        await sleep(2000); // Rate limit between search queries
      } catch (e) {
        if (verbose) console.log(`    [Error] Search failed: ${e.message}`);
        stats.errors.push(`Article search for ${show.id}: ${e.message}`);
      }
    }

    if (articleUrls.length === 0) {
      if (verbose) console.log(`    No casting articles found`);
      continue;
    }

    if (verbose) console.log(`    Found ${articleUrls.length} candidate articles`);

    // Fetch and extract from top articles (limit to 5 per show to control cost)
    const maxArticles = HIGH_FREQ_SHOWS.has(show.id) ? 5 : 3;
    for (const article of articleUrls.slice(0, maxArticles)) {
      try {
        // Fetch article HTML
        const html = await fetchViaScrapingBee(article.url);
        stats.articlesFetched++;

        const articleText = sanitizeText(htmlToText(html));
        if (!articleText || articleText.length < 200) {
          if (verbose) console.log(`    [Skip] Article too short: ${article.url}`);
          continue;
        }

        // Double-check: full text production filter
        if (isTourArticle(articleText)) {
          if (verbose) console.log(`    [Skip] Tour content in body: ${article.url}`);
          continue;
        }

        // Determine sourceType from URL
        let sourceType = 'article';
        if (article.url.includes('playbill.com')) sourceType = 'playbill';
        else if (article.url.includes('broadwayworld.com')) sourceType = 'broadwayworld';
        else if (article.url.includes('theatermania.com')) sourceType = 'theatermania';
        else if (article.url.includes('broadwaydirect.com')) sourceType = 'broadway-direct';
        else if (article.url.includes('broadwaynews.com')) sourceType = 'broadway-news';
        else if (article.url.includes('deadline.com')) sourceType = 'deadline';

        // LLM extraction
        const events = await extractCastEventsFromArticle(show, articleText, article.url, sourceType);
        stats.articlesExtracted++;

        if (events.length > 0) {
          if (!results[show.id]) results[show.id] = [];
          results[show.id].push(...events);
          if (verbose) console.log(`    [Extracted] ${events.length} events from ${article.url}`);
        }

        await sleep(500); // Rate limit between Claude calls
      } catch (e) {
        if (verbose) console.log(`    [Error] ${article.url}: ${e.message}`);
        stats.errors.push(`Article fetch ${show.id}: ${e.message}`);
      }

      await sleep(2000); // Rate limit between page fetches
    }
  }

  console.log(`[Articles] Searched ${stats.articlesSearched} queries, fetched ${stats.articlesFetched}, extracted from ${stats.articlesExtracted}`);
  return results;
}

/**
 * Extract cast change events from article text via Claude
 */
async function extractCastEventsFromArticle(show, articleText, articleUrl, sourceType) {
  // Truncate very long articles to stay within context
  const truncatedText = articleText.slice(0, 6000);

  const prompt = `You are extracting structured cast change events from a Broadway news article.

The article is about or mentions the show "${show.title}" (show ID: "${show.id}").

Extract ALL cast change events mentioned for this specific Broadway production. For each event, return:
{
  "type": "departure" or "arrival" or "absence" or "note",
  "name": "Person's full name",
  "role": "Character/role name",
  "date": "YYYY-MM-DD format (best guess from article)",
  "endDate": "YYYY-MM-DD (only for limited engagements with a known end date)",
  "note": "Brief context (max 100 chars)"
}

Classification rules:
- "departure" = actor leaving a role (final performance, stepping down, contract ending)
- "arrival" = actor joining a show in a role (new cast, replacement, celebrity guest, returning)
- "absence" = temporary planned time off (vacation, medical, scheduled days off) — include a "dates" array of YYYY-MM-DD strings
- "note" = general cast news (e.g., "new cast TBA", "casting search underway")

Date handling:
- If article says "March 2026" without a specific day, use "2026-03-01"
- If article says "this spring" with no date, omit the date field
- For "final performance" dates, that IS the departure date

CRITICAL RULES:
- Only extract events for the BROADWAY production, not tours, West End, or film
- Do not include understudies, swings, or standbys unless they're being promoted to principal
- Do not invent events not mentioned in the article
- Return ONLY a JSON array. If no cast changes found, return []

Article text:
${truncatedText}`;

  try {
    const response = await callClaude(prompt, 2000);
    const events = parseClaudeJsonArray(response);

    // Validate and enrich each event
    const validEvents = [];
    for (const event of events) {
      if (!validateEvent(event)) continue;

      // Enrich with source metadata
      event.sourceUrl = articleUrl;
      event.sourceType = sourceType;
      event.addedDate = TODAY;

      // Truncate note if too long
      if (event.note && event.note.length > 150) {
        event.note = event.note.slice(0, 147) + '...';
      }

      validEvents.push(event);
    }

    return validEvents;
  } catch (e) {
    if (verbose) console.log(`    [LLM Error] ${e.message}`);
    stats.errors.push(`LLM extraction for ${show.id}: ${e.message}`);
    return [];
  }
}

// ==================== Source 2: Official Site Cast Pages ====================

/**
 * Scrape official show websites for cast page changes
 */
async function scrapeOfficialSites(targetShows, existing) {
  console.log('\n--- Source 2: Official Show Website Cast Pages ---');

  if (!SCRAPINGBEE_KEY) {
    console.log('[Skip] No SCRAPINGBEE_API_KEY');
    return {};
  }
  if (!ANTHROPIC_KEY) {
    console.log('[Skip] No ANTHROPIC_API_KEY');
    return {};
  }

  const results = {};

  // Only process shows that have officialUrl AND existing currentCast baseline
  const eligible = targetShows.filter(s => {
    if (!s.officialUrl) return false;
    const showData = existing.shows[s.id];
    return showData && showData.currentCast && showData.currentCast.length > 0;
  });

  console.log(`[Official] ${eligible.length} shows eligible (have officialUrl + currentCast baseline)`);

  for (const show of eligible) {
    if (verbose) console.log(`\n  [Official] Checking ${show.title}`);

    const baseUrl = show.officialUrl.replace(/\/$/, '');
    const urlVariants = [
      `${baseUrl}/cast`,
      `${baseUrl}/cast-creative`,
      `${baseUrl}/cast-creative/`,
    ];

    let pageText = null;
    let castUrl = null;

    for (const url of urlVariants) {
      try {
        const html = await fetchViaScrapingBee(url, { renderJs: true });
        if (html && html.length > 500 && !html.includes('Page Not Found') && !html.includes('404')) {
          pageText = sanitizeText(htmlToText(html));
          castUrl = url;
          break;
        }
      } catch (e) {
        if (verbose) console.log(`    ${url}: ${e.message}`);
      }
      await sleep(2000);
    }

    if (!pageText || pageText.length < 200) {
      if (verbose) console.log(`    No cast page found`);
      continue;
    }

    stats.officialSitesChecked++;

    // Extract cast from page via LLM
    try {
      const extractedCast = await extractCastFromPage(show, pageText);
      if (!extractedCast || extractedCast.length === 0) continue;

      // Compare against baseline
      const baseline = existing.shows[show.id].currentCast;
      const diffs = diffCast(baseline, extractedCast, show.id, castUrl);

      if (diffs.length > 0) {
        results[show.id] = diffs;
        if (verbose) console.log(`    [Diff] ${diffs.length} changes detected`);
      } else {
        if (verbose) console.log(`    No changes from baseline`);
      }

      await sleep(500); // Rate limit Claude calls
    } catch (e) {
      if (verbose) console.log(`    [Error] ${e.message}`);
      stats.errors.push(`Official site ${show.id}: ${e.message}`);
    }
  }

  console.log(`[Official] Checked ${stats.officialSitesChecked} sites`);
  return results;
}

/**
 * Extract principal cast from official show website page via Claude
 */
async function extractCastFromPage(show, pageText) {
  const truncated = pageText.slice(0, 4000);

  const prompt = `Extract the principal cast members from this show's official website cast page.

Show: "${show.title}"

Return ONLY a JSON array of cast members:
[{"name": "Full Name", "role": "Character Name"}, ...]

Rules:
- Only include principal/named roles, not ensemble/swings/standbys/understudies
- Use the actor's full name as listed
- Use the character/role name as listed
- If the page shows both current and past cast, only include current cast
- If no cast information is found, return []

Page content:
${truncated}`;

  const response = await callClaude(prompt, 1500);
  const cast = parseClaudeJsonArray(response);

  // Basic validation
  return cast.filter(c => c.name && typeof c.name === 'string' && c.role && typeof c.role === 'string');
}

/**
 * Diff two cast lists and produce flagged events
 */
function diffCast(baseline, scraped, showId, sourceUrl) {
  const events = [];

  const normalName = n => n.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();

  const baselineNames = new Set(baseline.map(c => normalName(c.name)));
  const scrapedNames = new Set(scraped.map(c => normalName(c.name)));

  // People in baseline but not on website = potential departures
  for (const member of baseline) {
    if (!scrapedNames.has(normalName(member.name))) {
      events.push({
        type: 'departure',
        name: member.name,
        role: member.role,
        note: '[AUTO-FLAGGED] Not found on official cast page — verify before trusting',
        sourceUrl,
        sourceType: 'official-site',
        addedDate: TODAY,
      });
    }
  }

  // People on website but not in baseline = potential arrivals
  for (const member of scraped) {
    if (!baselineNames.has(normalName(member.name))) {
      events.push({
        type: 'arrival',
        name: member.name,
        role: member.role,
        note: '[AUTO-FLAGGED] Found on official cast page but not in baseline — verify',
        sourceUrl,
        sourceType: 'official-site',
        addedDate: TODAY,
      });
    }
  }

  return events;
}

// ==================== Source 4: Playbill Cast Pages ====================

/**
 * Scrape Playbill production pages for current cast.
 * Playbill pages have clearly labeled tabs: "Cast <span>Current</span>",
 * "Cast <span>Opening Night</span>", "Production Credits".
 * We extract /person/ links from the Current Cast tab only.
 */
async function scrapePlaybillCast(targetShows, existing) {
  console.log('\n--- Source 4: Playbill Cast Pages ---');

  // Load Playbill URLs
  const playbillUrlsPath = path.join(__dirname, '../data/playbill-urls.json');
  let playbillUrls = {};
  try {
    const data = JSON.parse(fs.readFileSync(playbillUrlsPath, 'utf8'));
    playbillUrls = data.shows || {};
  } catch {
    console.log('[Skip] No playbill-urls.json found. Run discover-playbill-urls.js first.');
    return {};
  }

  // Filter to Broadway-only shows with Playbill URLs
  const eligible = targetShows.filter(s => {
    if (s.category) return false; // Broadway shows have no category
    return !!playbillUrls[s.id];
  });

  console.log(`[Playbill] ${eligible.length} Broadway shows with Playbill URLs`);

  const results = {};
  let fetchPage;
  try {
    fetchPage = require('./lib/scraper').fetchPage;
  } catch (e) {
    console.log(`[Skip] Could not load fetchPage: ${e.message}`);
    // Fallback to ScrapingBee direct if fetchPage unavailable (e.g., missing env vars)
    fetchPage = async (url) => {
      const html = await fetchViaScrapingBee(url, { renderJs: false });
      return { content: html };
    };
  }

  for (const show of eligible) {
    const playbillUrl = playbillUrls[show.id];
    if (verbose) console.log(`\n  [Playbill] ${show.title}`);

    try {
      // Fetch page
      const result = await fetchPage(playbillUrl, { renderJs: false });
      if (!result || !result.content || result.content.length < 500) {
        if (verbose) console.log(`    Page too short or empty`);
        continue;
      }

      const html = result.content;

      // Extract current cast from the "Cast Current" tab
      const castMembers = extractPlaybillCurrentCast(html);
      if (castMembers.length === 0) {
        if (verbose) console.log(`    No cast members extracted`);
        continue;
      }

      if (verbose) console.log(`    Extracted ${castMembers.length} cast members`);

      // Initialize baseline for shows with no existing data
      if (!existing.shows[show.id] || !existing.shows[show.id].currentCast || existing.shows[show.id].currentCast.length === 0) {
        // First time seeing this show — set baseline, don't generate events
        if (castMembers.length >= 3) { // Minimum threshold to trust the data
          existing.shows[show.id] = existing.shows[show.id] || { currentCast: [], upcoming: [] };
          existing.shows[show.id].currentCast = castMembers.map(name => ({
            name,
            role: 'Unknown', // Playbill doesn't always show roles inline
            since: TODAY,
          }));
          if (verbose) console.log(`    Set baseline: ${castMembers.length} cast members (no events generated)`);
          stats.eventsAdded += 0; // No events — just baseline
        } else {
          if (verbose) console.log(`    Too few cast members (${castMembers.length}) — skipping baseline`);
        }
        continue;
      }

      // Diff against existing baseline
      const baseline = existing.shows[show.id].currentCast;
      const scrapedCast = castMembers.map(name => ({ name, role: 'Unknown' }));
      const diffs = diffCastPlaybill(baseline, scrapedCast, show.id, playbillUrl);

      if (diffs.length > 0) {
        results[show.id] = diffs;
        if (verbose) console.log(`    ${diffs.length} changes detected`);
      } else {
        if (verbose) console.log(`    No changes from baseline`);
      }
    } catch (e) {
      if (verbose) console.log(`    Error: ${e.message}`);
      stats.errors.push(`Playbill ${show.id}: ${e.message}`);
    }

    await sleep(2000); // Rate limit between page fetches
  }

  const totalEvents = Object.values(results).reduce((s, arr) => s + arr.length, 0);
  console.log(`[Playbill] Checked ${eligible.length} shows, found ${totalEvents} changes`);
  return results;
}

/**
 * Extract current cast names from Playbill production page HTML.
 * Looks for the "Cast Current" tab and extracts /person/ link title attributes.
 */
function extractPlaybillCurrentCast(html) {
  const lines = html.split('\n');

  // Find "Cast Current" tab start and end
  let castStart = -1;
  let castEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes('Cast') && lines[i].includes('Current') && lines[i].includes('data-nav-title')) {
      castStart = i;
    } else if (castStart >= 0 && castEnd < 0 && i > castStart && lines[i].includes('data-nav-title')) {
      castEnd = i;
      break;
    }
  }

  if (castStart < 0) {
    // Fallback: no tab structure, try extracting all /person/ links with bsp-list-promo-title
    if (verbose) console.log(`    No "Cast Current" tab found — using fallback`);
    const names = new Set();
    const re = /\/person\/[^"]*"[^>]*title="([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const name = m[1].replace(/\s*\(.*\)$/, '').trim(); // Remove "(Performer, Writer)" suffix
      if (name && name.length > 1 && !name.includes('View All')) {
        names.add(name);
      }
    }
    return [...names];
  }

  // Extract from the Current Cast section only
  const section = lines.slice(castStart, castEnd).join('\n');
  const names = new Set();
  const re = /\/person\/[^"]*"[^>]*title="([^"]+)"/g;
  let m;
  while ((m = re.exec(section)) !== null) {
    const name = m[1].replace(/\s*\(.*\)$/, '').trim();
    if (name && name.length > 1 && !name.includes('View All')) {
      names.add(name);
    }
  }

  return [...names];
}

/**
 * Diff baseline cast against Playbill-scraped cast.
 * Same logic as diffCast() but with playbill-specific sourceType.
 */
function diffCastPlaybill(baseline, scraped, showId, sourceUrl) {
  const events = [];
  const normalName = n => n.toLowerCase().replace(/[^a-z\s]/g, '').replace(/\s+/g, ' ').trim();

  const baselineNames = new Set(baseline.map(c => normalName(c.name)));
  const scrapedNames = new Set(scraped.map(c => normalName(c.name)));

  for (const member of baseline) {
    if (!scrapedNames.has(normalName(member.name))) {
      events.push({
        type: 'departure',
        name: member.name,
        role: member.role || 'Unknown',
        note: '[AUTO-FLAGGED] Not found on Playbill current cast — verify',
        sourceUrl,
        sourceType: 'playbill-cast',
        addedDate: TODAY,
      });
    }
  }

  for (const member of scraped) {
    if (!baselineNames.has(normalName(member.name))) {
      events.push({
        type: 'arrival',
        name: member.name,
        role: member.role || 'Unknown',
        note: '[AUTO-FLAGGED] Found on Playbill current cast but not in baseline — verify',
        sourceUrl,
        sourceType: 'playbill-cast',
        addedDate: TODAY,
      });
    }
  }

  return events;
}

// ==================== Source 3: Reddit Monitoring ====================

/**
 * Search r/Broadway for cast change discussions
 */
async function scrapeReddit(targetShows) {
  console.log('\n--- Source 3: Reddit r/Broadway Monitoring ---');

  if (!SCRAPINGBEE_KEY) {
    console.log('[Skip] No SCRAPINGBEE_API_KEY');
    return {};
  }
  if (!ANTHROPIC_KEY) {
    console.log('[Skip] No ANTHROPIC_API_KEY');
    return {};
  }

  const results = {};
  let consecutiveEmpty = 0;

  // General cast change searches
  const generalQueries = [
    'cast change broadway',
    '"final performance" broadway',
    '"joining" broadway cast',
    '"leaving" broadway',
    '"replacing" broadway',
    '"new cast" broadway',
  ];

  // Per high-freq show searches
  const highFreqShows = targetShows.filter(s => HIGH_FREQ_SHOWS.has(s.id));
  for (const show of highFreqShows) {
    const cleanTitle = show.title.replace(/[()!]/g, '').trim();
    generalQueries.push(`"${cleanTitle}" cast`);
    generalQueries.push(`"${cleanTitle}" leaving OR joining OR replacing`);
  }

  // Collect posts from all searches
  const allPosts = [];
  const seenPostIds = new Set();

  for (const query of generalQueries) {
    // Graceful fallback: if Reddit is blocking, stop trying
    if (consecutiveEmpty >= 3) {
      console.log('[Reddit] 3+ consecutive empty results — likely being blocked. Skipping remaining queries.');
      break;
    }

    try {
      const encoded = encodeURIComponent(query);
      const url = `https://old.reddit.com/r/broadway/search.json?q=${encoded}&sort=new&t=month&restrict_sr=on&limit=25`;

      const data = await fetchRedditJson(url);
      stats.redditSearches++;

      const posts = data?.data?.children || [];
      if (posts.length === 0) {
        consecutiveEmpty++;
        continue;
      }
      consecutiveEmpty = 0;

      for (const post of posts) {
        const pd = post.data;
        if (!pd || seenPostIds.has(pd.id)) continue;
        seenPostIds.add(pd.id);

        // Filter: must have casting-related flair or title keywords
        const titleLower = (pd.title || '').toLowerCase();
        const flairLower = (pd.link_flair_text || '').toLowerCase();

        const castKeywords = ['cast', 'leaving', 'joining', 'replacing', 'departure',
          'final performance', 'new star', 'stunt cast', 'last show', 'stepping down'];

        const isRelevant = flairLower.includes('cast') || flairLower.includes('news') ||
          castKeywords.some(kw => titleLower.includes(kw));

        if (!isRelevant) continue;

        allPosts.push({
          title: sanitizeText(pd.title),
          selftext: sanitizeText(pd.selftext || '').slice(0, 1000),
          score: pd.score || 0,
          url: `https://reddit.com${pd.permalink}`,
          created: new Date(pd.created_utc * 1000).toISOString().split('T')[0],
        });
      }

      await sleep(3000); // Rate limit between Reddit queries
    } catch (e) {
      if (verbose) console.log(`  [Reddit] Search failed: ${e.message}`);
      stats.errors.push(`Reddit search: ${e.message}`);
      consecutiveEmpty++;
    }
  }

  console.log(`[Reddit] Searched ${stats.redditSearches} queries, found ${allPosts.length} relevant posts`);

  if (allPosts.length === 0) return results;

  // LLM batch extraction
  const batchSize = 10;
  for (let i = 0; i < allPosts.length; i += batchSize) {
    const batch = allPosts.slice(i, i + batchSize);
    stats.redditPostsAnalyzed += batch.length;

    const batchText = batch.map((p, idx) =>
      `--- Post ${idx + 1} (${p.created}, score: ${p.score}) ---\nTitle: ${p.title}\n${p.selftext ? `Body: ${p.selftext}` : ''}\nURL: ${p.url}`
    ).join('\n\n');

    const prompt = `You are scanning Reddit r/Broadway posts for cast change information about currently running Broadway shows.

For each post that mentions a CONFIRMED cast change (not rumors or questions), extract:
{
  "showTitle": "Show name mentioned",
  "type": "departure" or "arrival" or "absence" or "note",
  "name": "Person's full name",
  "role": "Role name if mentioned, otherwise null",
  "date": "YYYY-MM-DD if mentioned, otherwise null",
  "note": "What the post says (max 100 chars)",
  "redditUrl": "the post URL",
  "confidence": "high" or "medium" or "low"
}

Confidence levels:
- "high": Names specific people, dates, and shows; cites official announcement
- "medium": Names people and shows but details are vague
- "low": Rumors, speculation, unnamed sources, questions about cast

Rules:
- Only extract CONFIRMED announcements or news, not questions or speculation
- Ignore understudy/swing reports and "who was on tonight" posts
- Only extract Broadway productions, not tours or West End
- Return ONLY a JSON array. Return [] if no confirmed cast changes found.

Posts to analyze:
${batchText}`;

    try {
      const response = await callClaude(prompt, 3000);
      const leads = parseClaudeJsonArray(response);

      // Filter by confidence and validate
      for (const lead of leads) {
        if (!lead.confidence || lead.confidence === 'low') continue;
        if (!lead.showTitle || !lead.name) continue;

        // Match show title to show ID
        const match = matchTitleToShow(lead.showTitle, allShows, { market: 'broadway', prefer: 'open' });
        if (!match) {
          if (verbose) console.log(`    [Reddit] No show match for "${lead.showTitle}"`);
          continue;
        }

        const showId = match.show.id;
        if (!results[showId]) results[showId] = [];

        results[showId].push({
          type: lead.type || 'note',
          name: lead.name,
          role: lead.role || 'Unknown',
          date: lead.date || null,
          note: lead.note ? lead.note.slice(0, 150) : 'Reported on Reddit',
          sourceUrl: lead.redditUrl || '',
          sourceType: 'reddit',
          addedDate: TODAY,
        });
      }

      await sleep(500); // Rate limit Claude
    } catch (e) {
      if (verbose) console.log(`  [Reddit LLM] Batch extraction failed: ${e.message}`);
      stats.errors.push(`Reddit LLM: ${e.message}`);
    }
  }

  const totalEvents = Object.values(results).reduce((s, arr) => s + arr.length, 0);
  console.log(`[Reddit] Extracted ${totalEvents} events from ${stats.redditPostsAnalyzed} posts`);
  return results;
}

// ==================== Merge & Dedup ====================

/**
 * Source priority map — higher = more trusted
 */
const SOURCE_PRIORITY = {
  playbill: 3, broadwayworld: 3, 'broadway-direct': 3, shubert: 3,
  theatermania: 3, 'ny-theatre-guide': 3, 'broadway-news': 3, 'broadway.com': 3,
  deadline: 3, article: 3,
  'official-site': 2,
  reddit: 1,
};

/**
 * Merge new events into existing data with dedup
 */
function mergeEvents(existing, newEvents, source) {
  const changes = [];

  for (const [showId, events] of Object.entries(newEvents)) {
    if (!existing.shows[showId]) {
      existing.shows[showId] = { currentCast: [], upcoming: [] };
    }

    const showData = existing.shows[showId];
    if (!showData.upcoming) showData.upcoming = [];
    if (!showData.currentCast) showData.currentCast = [];

    for (const event of events) {
      if (!validateEvent(event)) continue;

      // Check for exact duplicate
      const exactDupe = showData.upcoming.find(e =>
        e.name === event.name &&
        e.role === event.role &&
        e.type === event.type &&
        e.date === event.date
      );

      if (exactDupe) {
        // Check if we should upgrade the source
        const existingPriority = SOURCE_PRIORITY[exactDupe.sourceType] || 0;
        const newPriority = SOURCE_PRIORITY[event.sourceType] || 0;

        if (newPriority > existingPriority) {
          Object.assign(exactDupe, event);
          changes.push({ showId, type: 'upgraded', event, source });
          stats.eventsUpgraded++;
        }
        continue;
      }

      // Check for fuzzy duplicate (same person+role+type, date within 7 days)
      const fuzzyDupe = showData.upcoming.find(e => {
        if (e.name !== event.name || e.role !== event.role || e.type !== event.type) return false;
        if (!e.date || !event.date) return false;
        const diff = Math.abs(new Date(e.date) - new Date(event.date));
        return diff <= 7 * 24 * 60 * 60 * 1000; // 7 days
      });

      if (fuzzyDupe) {
        // Keep the one with more specific date
        const existingPriority = SOURCE_PRIORITY[fuzzyDupe.sourceType] || 0;
        const newPriority = SOURCE_PRIORITY[event.sourceType] || 0;

        if (newPriority > existingPriority) {
          Object.assign(fuzzyDupe, event);
          changes.push({ showId, type: 'upgraded-fuzzy', event, source });
          stats.eventsUpgraded++;
        }
        continue;
      }

      // New event — add it
      showData.upcoming.push(event);
      changes.push({ showId, type: 'added', event, source });
      stats.eventsAdded++;
    }
  }

  return changes;
}

// ==================== Expired Event Cleanup ====================

/**
 * Clean up past events — idempotent via appliedAt flag
 */
function cleanExpiredEvents(existing) {
  const changes = [];

  for (const [showId, showData] of Object.entries(existing.shows)) {
    if (!showData.upcoming) continue;

    const kept = [];

    for (const event of showData.upcoming) {
      // Skip already-applied events (idempotency guard)
      if (event.appliedAt) {
        // Already processed — don't keep in upcoming
        continue;
      }

      // Handle absence type
      if (event.type === 'absence') {
        if (event.dates && Array.isArray(event.dates)) {
          const futureDates = event.dates.filter(d => d >= TODAY);
          if (futureDates.length === 0) {
            changes.push({ showId, type: 'cleaned-absence', event });
            stats.eventsCleaned++;
            continue;
          }
          event.dates = futureDates;
        }
        kept.push(event);
        continue;
      }

      const eventDate = event.date;
      if (!eventDate || eventDate >= TODAY) {
        // Future or undated event — keep
        kept.push(event);
        continue;
      }

      // Event has passed — process it
      if (event.type === 'departure') {
        // Remove from currentCast
        showData.currentCast = (showData.currentCast || []).filter(c =>
          !(c.name === event.name && c.role === event.role)
        );
        event.appliedAt = TODAY;
        changes.push({ showId, type: 'applied-departure', event });
        stats.eventsCleaned++;
      } else if (event.type === 'arrival') {
        if (event.endDate && event.endDate < TODAY) {
          // Limited engagement is over — don't add to currentCast
          event.appliedAt = TODAY;
          changes.push({ showId, type: 'cleaned-expired-arrival', event });
          stats.eventsCleaned++;
        } else {
          // Add to currentCast
          const alreadyInCast = (showData.currentCast || []).some(c =>
            c.name === event.name && c.role === event.role
          );
          if (!alreadyInCast) {
            showData.currentCast = showData.currentCast || [];
            showData.currentCast.push({
              name: event.name,
              role: event.role,
              since: event.date,
            });
          }
          event.appliedAt = TODAY;
          changes.push({ showId, type: 'applied-arrival', event });
          stats.eventsCleaned++;
        }
      } else if (event.type === 'note') {
        changes.push({ showId, type: 'cleaned-note', event });
        stats.eventsCleaned++;
        continue; // Don't keep
      }

      // Applied events are NOT kept in upcoming (they've been processed)
      // But we don't re-add them — the appliedAt flag is just for the audit log
    }

    showData.upcoming = kept;
  }

  return changes;
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
    .filter(f => f.startsWith('cast-changes.backup-'))
    .sort()
    .reverse();
  for (const old of backups.slice(5)) {
    fs.unlinkSync(path.join(dir, old));
  }
}

/**
 * Guard: abort if show IDs changed too dramatically.
 * Threshold scales with data staleness — if the file hasn't been updated
 * in weeks, more new shows are expected and the guard relaxes accordingly.
 */
function validateShowStability(original, updated) {
  const oldIds = new Set(Object.keys(original.shows || {}));
  // Only count shows with upcoming events as "new" — baseline-only shows
  // (currentCast set, empty upcoming) are just initialization, not real changes
  const newIds = new Set(Object.keys(updated.shows || {}).filter(id => {
    if (oldIds.has(id)) return true; // Existing show — always count
    const data = updated.shows[id];
    return data.upcoming && data.upcoming.length > 0; // New show with events
  }));

  const added = [...newIds].filter(id => !oldIds.has(id));
  const removed = [...oldIds].filter(id => !newIds.has(id));

  // Scale add threshold by staleness: base 10, +5 per week stale, max 50
  const lastUpdated = original.lastUpdated;
  let staleDays = 0;
  if (lastUpdated) {
    staleDays = Math.floor((Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60 * 24));
  }
  const staleWeeks = Math.floor(staleDays / 7);
  const addThreshold = Math.min(10 + staleWeeks * 5, 50);
  const removeThreshold = 5;

  if (staleDays > 14 && verbose) {
    console.log(`[Guard] Data is ${staleDays} days stale — add threshold raised to ${addThreshold}`);
  }

  if (added.length > addThreshold || removed.length > removeThreshold) {
    // Warn but don't abort — new shows appearing is expected with multiple sources.
    // The guard exists to catch data corruption, not normal growth.
    console.warn(`\n[Guard] WARNING: Show ID changes exceed threshold (${added.length} added, ${removed.length} removed, threshold: ${addThreshold})`);
    if (added.length > 0) console.warn(`  Added: ${added.join(', ')}`);
    if (removed.length > 0 && removed.length > removeThreshold) {
      // Removals ARE dangerous (data loss) — abort unless forced
      if (!forceRun) {
        console.error(`[Guard] ABORT: ${removed.length} shows removed exceeds threshold of ${removeThreshold}`);
        process.exit(1);
      }
    }
  }

  if (verbose && (added.length > 0 || removed.length > 0)) {
    console.log(`[Guard] Show ID changes: +${added.length} -${removed.length} (threshold: ${addThreshold})`);
  }
}

/**
 * Guard: abort if currentCast members drop too much.
 * Skipped when data is >30 days stale (baselines are meaningless after that long).
 */
function validateCastMemberStability(original, updated) {
  // Skip entirely if data is very stale — baselines are meaningless
  const lastUpdated = original.lastUpdated;
  if (lastUpdated) {
    const staleDays = Math.floor((Date.now() - new Date(lastUpdated).getTime()) / (1000 * 60 * 60 * 24));
    if (staleDays > 30) {
      if (verbose) console.log(`[Guard] Skipping cast member stability check — data is ${staleDays} days stale (baselines unreliable)`);
      return;
    }
  }

  let totalDropped = 0;

  for (const [showId, showData] of Object.entries(updated.shows || {})) {
    const origShow = original.shows?.[showId];
    if (!origShow) continue;

    const origCount = (origShow.currentCast || []).length;
    const newCount = (showData.currentCast || []).length;
    const dropped = origCount - newCount;

    if (dropped > 3) {
      if (forceRun) {
        console.warn(`[Guard] WARNING: ${showId} lost ${dropped} cast members (${origCount} → ${newCount}) — proceeding due to --force`);
      } else {
        console.error(`[Guard] ABORT: ${showId} lost ${dropped} cast members in one run (${origCount} → ${newCount})`);
        process.exit(1);
      }
    }
    if (dropped > 0) totalDropped += dropped;
  }

  if (totalDropped > 15) {
    if (forceRun) {
      console.warn(`[Guard] WARNING: Total cast member drop of ${totalDropped} exceeds threshold — proceeding due to --force`);
    } else {
      console.error(`[Guard] ABORT: Total cast member drop of ${totalDropped} exceeds threshold of 15`);
      process.exit(1);
    }
  }

  if (verbose && totalDropped > 0) {
    console.log(`[Guard] Cast member changes: -${totalDropped} total (within limits)`);
  }
}

/**
 * Remove entries for shows that have closed
 */
function cleanClosedShows(existing) {
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const changes = [];

  for (const showId of Object.keys(existing.shows)) {
    const show = showsData.shows.find(s => s.id === showId);
    if (show && show.status === 'closed') {
      delete existing.shows[showId];
      changes.push({ showId, type: 'removed-closed' });
      stats.showsCleaned++;
    } else if (!show) {
      delete existing.shows[showId];
      changes.push({ showId, type: 'removed-orphan' });
      stats.showsCleaned++;
    }
  }

  return changes;
}

// ==================== Audit Diff ====================

/**
 * Write audit diff summarizing all changes from this run
 */
function writeAuditDiff(allChanges) {
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  }

  const diff = {
    timestamp: new Date().toISOString(),
    summary: {
      eventsAdded: stats.eventsAdded,
      eventsUpgraded: stats.eventsUpgraded,
      eventsCleaned: stats.eventsCleaned,
      showsCleaned: stats.showsCleaned,
      totalChanges: allChanges.length,
      errors: stats.errors.length,
    },
    changes: allChanges.map(c => ({
      showId: c.showId,
      changeType: c.type,
      eventType: c.event?.type,
      name: c.event?.name,
      role: c.event?.role,
      date: c.event?.date,
      source: c.source,
    })),
    stats,
  };

  const diffPath = path.join(AUDIT_DIR, 'cast-changes-diff.json');
  fs.writeFileSync(diffPath, JSON.stringify(diff, null, 2) + '\n');
  console.log(`[Audit] Wrote diff to ${path.basename(diffPath)}`);
}

// ==================== Main ====================

async function main() {
  console.log('='.repeat(60));
  console.log('Broadway Cast Changes Scraper');
  console.log('='.repeat(60));
  console.log(`Date: ${TODAY}`);
  if (dryRun) console.log('[Mode] DRY RUN');
  if (sourceFilter !== 'all') console.log(`[Mode] Source: ${sourceFilter}`);
  if (highFreqOnly) console.log('[Mode] High-frequency shows only');

  // Step 1: Load existing data
  let existing = { lastUpdated: '', shows: {} };
  if (fs.existsSync(OUTPUT_PATH)) {
    existing = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  }
  const originalSnapshot = JSON.parse(JSON.stringify(existing));

  // Step 2: Validate loaded data structure
  for (const [showId, showData] of Object.entries(existing.shows)) {
    if (!Array.isArray(showData.currentCast)) {
      console.log(`[Warn] ${showId} missing currentCast array — initializing`);
      showData.currentCast = [];
    }
    if (!Array.isArray(showData.upcoming)) {
      console.log(`[Warn] ${showId} missing upcoming array — initializing`);
      showData.upcoming = [];
    }
  }

  // Step 3: Determine target shows
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  let targetShows = showsData.shows.filter(s => s.status === 'open' || s.status === 'previews');

  if (showFilter) {
    targetShows = targetShows.filter(s => s.id === showFilter || s.slug === showFilter);
  } else if (showsArg) {
    const ids = showsArg.split(',').map(s => s.trim());
    targetShows = targetShows.filter(s => ids.includes(s.id) || ids.includes(s.slug));
  } else if (highFreqOnly) {
    targetShows = targetShows.filter(s => HIGH_FREQ_SHOWS.has(s.id));
  }

  console.log(`\nTarget shows: ${targetShows.length}`);

  const allChanges = [];

  // Step 4: Clean expired events (idempotent via appliedAt)
  const cleanupChanges = cleanExpiredEvents(existing);
  allChanges.push(...cleanupChanges);
  if (cleanupChanges.length > 0) {
    console.log(`[Cleanup] Applied ${cleanupChanges.length} expired event changes`);
  }

  // Step 5: Scrape sources
  if (sourceFilter === 'all' || sourceFilter === 'articles') {
    const articleEvents = await scrapeArticles(targetShows);
    const changes = mergeEvents(existing, articleEvents, 'articles');
    allChanges.push(...changes);
  }

  if (sourceFilter === 'all' || sourceFilter === 'official-sites') {
    const officialEvents = await scrapeOfficialSites(targetShows, existing);
    const changes = mergeEvents(existing, officialEvents, 'official-sites');
    allChanges.push(...changes);
  }

  if (sourceFilter === 'all' || sourceFilter === 'playbill-cast') {
    const playbillEvents = await scrapePlaybillCast(targetShows, existing);
    const changes = mergeEvents(existing, playbillEvents, 'playbill-cast');
    allChanges.push(...changes);
  }

  if (sourceFilter === 'all' || sourceFilter === 'reddit') {
    const redditEvents = await scrapeReddit(targetShows);
    const changes = mergeEvents(existing, redditEvents, 'reddit');
    allChanges.push(...changes);
  }

  // Step 6: Clean closed shows
  const closedChanges = cleanClosedShows(existing);
  allChanges.push(...closedChanges);

  // Step 7: Update metadata
  existing.lastUpdated = TODAY;

  // Step 8: Validate stability guards
  validateShowStability(originalSnapshot, existing);
  validateCastMemberStability(originalSnapshot, existing);

  // Step 9: Print summary
  console.log('\n' + '='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`  Events added:     ${stats.eventsAdded}`);
  console.log(`  Events upgraded:  ${stats.eventsUpgraded}`);
  console.log(`  Events cleaned:   ${stats.eventsCleaned}`);
  console.log(`  Shows cleaned:    ${stats.showsCleaned}`);
  console.log(`  Total changes:    ${allChanges.length}`);
  console.log(`  Errors:           ${stats.errors.length}`);

  if (stats.errors.length > 0 && verbose) {
    console.log('\nErrors:');
    stats.errors.forEach(e => console.log(`  - ${e}`));
  }

  if (allChanges.length === 0) {
    console.log('\n[Result] No changes detected');
    return;
  }

  // Step 10: Write audit diff
  if (!dryRun) {
    writeAuditDiff(allChanges);
  } else {
    console.log('\n[Dry Run] Would write audit diff');
  }

  // Step 11: Backup + write
  if (dryRun) {
    console.log(`[Dry Run] Would write ${Object.keys(existing.shows).length} shows to cast-changes.json`);

    // Show what would change
    for (const change of allChanges) {
      if (change.event) {
        console.log(`  [${change.type}] ${change.showId}: ${change.event.type || ''} ${change.event.name || ''} ${change.event.role || ''}`);
      } else {
        console.log(`  [${change.type}] ${change.showId}`);
      }
    }
    return;
  }

  backupExisting();
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(existing, null, 2) + '\n');
  console.log(`\n[Output] Wrote cast-changes.json with ${Object.keys(existing.shows).length} shows`);

  const elapsed = ((Date.now() - TOTAL_START_TIME) / 1000).toFixed(1);
  console.log(`[Done] Completed in ${elapsed}s`);
}

main().catch(err => {
  console.error('[Fatal]', err);
  process.exit(1);
});
