#!/usr/bin/env node

/**
 * Automated Commercial Data Updater for Broadway Scorecard
 *
 * Gathers financial/commercial data from multiple sources:
 *   - Reddit r/Broadway Grosses Analysis posts (u/Boring_Waltz_9545)
 *   - Reddit r/Broadway financial discussion threads
 *   - Trade press articles (Deadline, Variety, Playbill, etc.)
 *
 * Then uses Claude AI to propose changes to data/commercial.json,
 * applies them with confidence filtering, and creates a GitHub issue
 * summarizing the changes.
 *
 * Environment variables:
 *   SCRAPINGBEE_API_KEY  - For web scraping (required)
 *   ANTHROPIC_API_KEY    - For AI analysis (not required if --gather-only)
 *   GITHUB_TOKEN         - For creating issues (optional)
 *
 * Usage:
 *   node scripts/update-commercial-data.js [options]
 *
 * Options:
 *   --dry-run       Preview mode, don't write files
 *   --gather-reddit Only gather Reddit data
 *   --gather-trade  Only gather trade press data
 *   --gather-all    Gather all sources (default if no specific gather flag)
 *   --gather-only   Stop after gathering, don't run AI analysis
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const { parseGrossesAnalysisPost } = require('./lib/parse-grosses');

// ---------------------------------------------------------------------------
// CLI Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const GATHER_REDDIT = args.includes('--gather-reddit');
const GATHER_TRADE = args.includes('--gather-trade');
const GATHER_ALL = args.includes('--gather-all') || (!GATHER_REDDIT && !GATHER_TRADE);
const GATHER_ONLY = args.includes('--gather-only');

// ---------------------------------------------------------------------------
// Environment Variables
// ---------------------------------------------------------------------------
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

// ---------------------------------------------------------------------------
// Data Paths
// ---------------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, '..', 'data');
const COMMERCIAL_PATH = path.join(DATA_DIR, 'commercial.json');
const SHOWS_PATH = path.join(DATA_DIR, 'shows.json');
const GROSSES_PATH = path.join(DATA_DIR, 'grosses.json');
const CHANGELOG_PATH = path.join(DATA_DIR, 'commercial-changelog.json');
const DEBUG_DIR = path.join(DATA_DIR, 'debug');

// ---------------------------------------------------------------------------
// Known Aliases: Reddit show names -> slugs in commercial.json / shows.json
// ---------------------------------------------------------------------------
const KNOWN_ALIASES = {
  'harry potter and the cursed child': 'harry-potter',
  'harry potter': 'harry-potter',
  'cursed child': 'harry-potter',
  'the lion king': 'the-lion-king-1997',
  'lion king': 'the-lion-king-1997',
  'a beautiful noise': 'a-beautiful-noise-2022',
  'beautiful noise': 'a-beautiful-noise-2022',
  'the book of mormon': 'book-of-mormon',
  'book of mormon': 'book-of-mormon',
  'mj': 'mj',
  'mj the musical': 'mj',
  'six': 'six',
  'six the musical': 'six',
  'six: the musical': 'six',
  'chicago': 'chicago',
  'chicago the musical': 'chicago',
  'hamilton': 'hamilton',
  'wicked': 'wicked',
  'aladdin': 'aladdin',
  'moulin rouge': 'moulin-rouge',
  'moulin rouge!': 'moulin-rouge',
  'moulin rouge! the musical': 'moulin-rouge',
  'hadestown': 'hadestown',
  'the outsiders': 'the-outsiders',
  'the great gatsby': 'the-great-gatsby',
  'great gatsby': 'the-great-gatsby',
  'death becomes her': 'death-becomes-her',
  'stranger things': 'stranger-things',
  'stranger things: the first shadow': 'stranger-things',
  'buena vista social club': 'buena-vista-social-club',
  'operation mincemeat': 'operation-mincemeat',
  'just in time': 'just-in-time',
  'two strangers': 'two-strangers',
  'two strangers (carry a cake across new york)': 'two-strangers',
  'maybe happy ending': 'maybe-happy-ending',
  'and juliet': 'and-juliet',
  '& juliet': 'and-juliet',
  'oh, mary!': 'oh-mary',
  'oh mary': 'oh-mary',
  'oh mary!': 'oh-mary',
  'stereophonic': 'stereophonic',
  'the roommate': 'the-roommate',
  'our town': 'our-town',
  'the notebook': 'the-notebook',
  'back to the future': 'back-to-the-future',
  'back to the future: the musical': 'back-to-the-future',
  'boop! the musical': 'boop',
  'boop': 'boop',
  'betty boop': 'boop',
  'water for elephants': 'water-for-elephants',
  'suffs': 'suffs',
  "hell's kitchen": 'hells-kitchen',
  'hells kitchen': 'hells-kitchen',
  'cabaret': 'cabaret-2024',
  'cabaret at the kit kat club': 'cabaret-2024',
  'queen of versailles': 'queen-of-versailles',
  'the queen of versailles': 'queen-of-versailles',
  'ragtime': 'ragtime',
  'chess': 'chess',
  'liberation': 'liberation',
  'all out': 'all-out',
  'mamma mia': 'mamma-mia',
  'mamma mia!': 'mamma-mia',
  'bug': 'bug',
  'marjorie prime': 'marjorie-prime',
  'oedipus': 'oedipus',
  'swept away': 'swept-away',
  'sunset boulevard': 'sunset-blvd-2024',
  'sunset blvd.': 'sunset-blvd-2024',
  'sunset blvd': 'sunset-blvd-2024',
  'the hills of california': 'hills-of-california',
  'hills of california': 'hills-of-california',
  'left on tenth': 'left-on-tenth',
  'tammy faye': 'tammy-faye',
  'yellowface': 'yellowface',
  'eureka day': 'eureka-day',
  'gypsy': 'gypsy-2024',
  'once upon a mattress': 'once-upon-a-mattress-2024',
  'real friends of claridge county': 'real-friends-of-claridge-county',
};

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Simple promise-based delay.
 * @param {number} ms - Milliseconds to wait
 */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch a URL through ScrapingBee proxy.
 * Modeled after scrape-reddit-sentiment.js lines 49-78.
 *
 * @param {string} url - URL to fetch
 * @param {Object} options
 * @param {boolean} [options.renderJs=false] - Whether to render JavaScript
 * @param {boolean} [options.premiumProxy=true] - Whether to use premium proxy
 * @returns {Promise<string|Object>} Response body (parsed JSON if possible, otherwise string)
 */
function fetchViaScrapingBee(url, options = {}) {
  const renderJs = options.renderJs === true ? 'true' : 'false';
  const premiumProxy = options.premiumProxy !== false ? 'true' : 'false';

  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_KEY) {
      reject(new Error('SCRAPINGBEE_API_KEY must be set'));
      return;
    }

    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=${renderJs}&premium_proxy=${premiumProxy}`;

    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            // Not JSON -- return raw string
            resolve(data);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Make an HTTPS request (POST/GET) with full control.
 * Used for Claude API and GitHub API calls.
 *
 * @param {Object} reqOptions - Node https.request options
 * @param {string|null} body - Request body (JSON string)
 * @returns {Promise<Object>} Parsed JSON response
 */
function httpsRequest(reqOptions, body) {
  return new Promise((resolve, reject) => {
    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            resolve(data);
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Sprint 3 & 4: Reddit Grosses Analysis
// ---------------------------------------------------------------------------

/**
 * Fetch the latest Grosses Analysis post from u/Boring_Waltz_9545.
 *
 * Tries the search endpoint first, then falls back to the user submissions
 * endpoint if the search returns nothing.
 *
 * @returns {Promise<Object|null>} Post data or null
 */
async function fetchGrossesAnalysisPost() {
  console.log('Fetching latest Grosses Analysis post...');

  // Primary: search r/Broadway for the post
  const searchUrl = 'https://www.reddit.com/r/Broadway/search.json?q=author:Boring_Waltz_9545+Grosses+Analysis&sort=new&restrict_sr=1&limit=1&t=month';

  try {
    const response = await fetchViaScrapingBee(searchUrl);

    if (response?.data?.children?.length > 0) {
      const post = response.data.children[0].data;
      const title = post.title || '';
      const weekMatch = title.match(/Week Ending (\d{1,2}\/\d{1,2}\/\d{4})/i);

      console.log(`  Found: "${title}"`);
      return {
        selftext: post.selftext || '',
        title,
        weekEnding: weekMatch ? weekMatch[1] : null,
        permalink: post.permalink,
        createdUtc: post.created_utc
      };
    }
  } catch (e) {
    console.error(`  Search endpoint failed: ${e.message}`);
  }

  // Fallback: user submissions
  console.log('  Falling back to user submissions endpoint...');
  await sleep(2000);

  try {
    const userUrl = 'https://www.reddit.com/user/Boring_Waltz_9545/submitted.json?sort=new&limit=5&t=month';
    const response = await fetchViaScrapingBee(userUrl);

    if (response?.data?.children) {
      for (const child of response.data.children) {
        const post = child.data;
        if (/grosses\s*analysis/i.test(post.title || '')) {
          const title = post.title || '';
          const weekMatch = title.match(/Week Ending (\d{1,2}\/\d{1,2}\/\d{4})/i);

          console.log(`  Found via user profile: "${title}"`);
          return {
            selftext: post.selftext || '',
            title,
            weekEnding: weekMatch ? weekMatch[1] : null,
            permalink: post.permalink,
            createdUtc: post.created_utc
          };
        }
      }
    }
  } catch (e) {
    console.error(`  User submissions endpoint failed: ${e.message}`);
  }

  console.log('  No Grosses Analysis post found');
  return null;
}

/**
 * Parse the Grosses Analysis post using regex first, falling back to
 * Claude Sonnet if regex extraction finds fewer than 10 shows.
 *
 * @param {string} selftext - Post body
 * @returns {Promise<Object[]>} Parsed show data
 */
async function parseGrossesPost(selftext) {
  // First try: regex parser from lib/parse-grosses.js
  const regexResults = parseGrossesAnalysisPost(selftext);
  console.log(`  Regex parser found ${regexResults.length} shows`);

  if (regexResults.length >= 10) {
    return regexResults;
  }

  // Fallback: Claude Sonnet extraction (if API key available)
  if (!ANTHROPIC_KEY) {
    console.log('  ANTHROPIC_API_KEY not set, skipping LLM fallback');
    return regexResults;
  }

  console.log('  Fewer than 10 shows found, trying Claude Sonnet extraction...');

  try {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: `Extract structured financial data from this Reddit grosses analysis post. For EACH show mentioned, extract:

- showName (string)
- weeklyGross (number or null, in dollars e.g. 1300000)
- capacity (number or null, percentage e.g. 81.5)
- atp (number or null, average ticket price in dollars)
- grossLessFees (number or null, in dollars)
- estimatedWeeklyCost (number or null, in dollars)
- estimatedProfitLoss (number or null, in dollars, negative for losses)
- estimatedRecoupmentPct (array of two numbers [low, high] or null)
- commentary (string, any additional notes about the show)

Return a JSON array of objects. Only return the JSON array, no other text.

Post text:
${selftext.slice(0, 12000)}`
      }]
    });

    const response = await httpsRequest({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      }
    }, body);

    const text = response.content?.[0]?.text || '';
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed) && parsed.length > regexResults.length) {
        console.log(`  Claude found ${parsed.length} shows (vs ${regexResults.length} from regex)`);
        return parsed;
      }
    }
  } catch (e) {
    console.error(`  Claude extraction failed: ${e.message}`);
  }

  return regexResults;
}

/**
 * Fetch top-level comments from a Reddit post.
 *
 * @param {string} permalink - Reddit permalink (e.g. /r/Broadway/comments/abc123/...)
 * @returns {Promise<Object[]>} Top 20 comments sorted by score desc
 */
async function fetchPostComments(permalink) {
  if (!permalink) return [];

  const url = `https://www.reddit.com${permalink}.json`;

  try {
    const response = await fetchViaScrapingBee(url);

    // Reddit returns [post, comments] array
    if (!Array.isArray(response) || response.length < 2) {
      return [];
    }

    const commentData = response[1]?.data?.children || [];
    const comments = commentData
      .filter(c => c.kind === 't1' && c.data?.body && c.data.body !== '[deleted]' && c.data.body !== '[removed]')
      .map(c => ({
        author: c.data.author || '[unknown]',
        body: c.data.body,
        score: c.data.score || 0,
        createdUtc: c.data.created_utc
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);

    console.log(`  Fetched ${comments.length} comments from post`);
    return comments;
  } catch (e) {
    console.error(`  Failed to fetch post comments: ${e.message}`);
    return [];
  }
}

/**
 * Match a show name (from Reddit) to a slug in our data.
 *
 * Matching order:
 *   1. Exact slug match
 *   2. Known aliases map
 *   3. Normalized match (strip articles, "The Musical", etc.)
 *   4. Title containment
 *   5. null with console.warn
 *
 * @param {string} showName - Show name from Reddit
 * @param {string[]} allSlugs - All slugs in commercial.json
 * @param {Object[]} allShows - All shows from shows.json
 * @returns {{ slug: string, confidence: 'high' | 'medium' } | null}
 */
function matchShowToSlug(showName, allSlugs, allShows) {
  if (!showName) return null;

  const lowerName = showName.toLowerCase().trim();

  // 1. Exact slug match: "Hamilton" -> "hamilton"
  const directSlug = lowerName.replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
  if (allSlugs.includes(directSlug)) {
    return { slug: directSlug, confidence: 'high' };
  }

  // 2. Known aliases
  if (KNOWN_ALIASES[lowerName]) {
    return { slug: KNOWN_ALIASES[lowerName], confidence: 'high' };
  }

  // 3. Normalized match: strip leading "The ", "A ", trailing ": The Musical", etc.
  const normalized = lowerName
    .replace(/^(the|a|an)\s+/i, '')
    .replace(/:\s*(the\s*)?musical$/i, '')
    .replace(/\s+the\s+musical$/i, '')
    .replace(/\s+on\s+broadway$/i, '')
    .replace(/[!?.,'"]/g, '')
    .trim()
    .replace(/\s+/g, '-');

  for (const slug of allSlugs) {
    const normalizedSlug = slug
      .replace(/^(the-|a-|an-)/i, '')
      .replace(/-\d{4}$/, '');  // Strip year suffix
    if (normalized === normalizedSlug) {
      return { slug, confidence: 'high' };
    }
  }

  // 4. Title containment: check shows.json titles
  for (const show of allShows) {
    const showTitle = (show.title || '').toLowerCase();
    const showSlug = show.slug || show.id;

    if (showTitle === lowerName || lowerName === showTitle) {
      if (allSlugs.includes(showSlug)) {
        return { slug: showSlug, confidence: 'high' };
      }
    }

    // Partial containment
    if (showTitle.includes(lowerName) || lowerName.includes(showTitle)) {
      if (allSlugs.includes(showSlug)) {
        return { slug: showSlug, confidence: 'medium' };
      }
    }
  }

  console.warn(`  [WARN] Could not match show name: "${showName}"`);
  return null;
}

// ---------------------------------------------------------------------------
// Sprint 5: Reddit Financial Threads + Trade Press
// ---------------------------------------------------------------------------

/**
 * Search r/Broadway for financial discussion threads (past 7 days).
 *
 * Runs 4 search queries with 2s delay between each, deduplicates,
 * and fetches top 5 comments per unique post.
 *
 * @param {string|null} grossesPostPermalink - Permalink to exclude (the main GA post)
 * @returns {Promise<Object[]>} Financial discussion posts
 */
async function searchRedditFinancial(grossesPostPermalink) {
  console.log('Searching r/Broadway for financial discussion threads...');

  const queries = [
    'recouped OR recoupment',
    'capitalization OR investment Broadway',
    'closing OR "final performance"',
    '"running costs" OR "weekly nut"'
  ];

  const seenIds = new Set();
  const posts = [];

  for (const query of queries) {
    const encoded = encodeURIComponent(query);
    const url = `https://www.reddit.com/r/Broadway/search.json?q=${encoded}&restrict_sr=1&sort=new&t=week&limit=10`;

    try {
      const response = await fetchViaScrapingBee(url);
      if (response?.data?.children) {
        for (const child of response.data.children) {
          const post = child.data;

          // Skip duplicates and the Grosses Analysis post
          if (seenIds.has(post.id)) continue;
          if (grossesPostPermalink && post.permalink === grossesPostPermalink) continue;

          seenIds.add(post.id);
          posts.push({
            title: post.title || '',
            selftext: (post.selftext || '').slice(0, 2000),
            score: post.score || 0,
            url: `https://www.reddit.com${post.permalink}`,
            permalink: post.permalink,
            createdUtc: post.created_utc,
            comments: []
          });
        }
      }
    } catch (e) {
      console.error(`  Search query "${query}" failed: ${e.message}`);
    }

    await sleep(2000);
  }

  console.log(`  Found ${posts.length} unique financial threads`);

  // Fetch top 5 comments per post
  for (const post of posts.slice(0, 10)) {
    try {
      const url = `https://www.reddit.com${post.permalink}.json`;
      const response = await fetchViaScrapingBee(url);

      if (Array.isArray(response) && response[1]?.data?.children) {
        post.comments = response[1].data.children
          .filter(c => c.kind === 't1' && c.data?.body && c.data.body !== '[deleted]')
          .map(c => ({
            author: c.data.author || '[unknown]',
            body: (c.data.body || '').slice(0, 1000),
            score: c.data.score || 0
          }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);
      }
    } catch (e) {
      // Non-fatal
    }

    await sleep(2000);
  }

  return posts;
}

/**
 * Search trade press for Broadway financial news using ScrapingBee Google search.
 *
 * @returns {Promise<Object[]>} Array of { title, url, snippet, source }
 */
async function searchTradePress() {
  console.log('Searching trade press for Broadway financial news...');

  if (!SCRAPINGBEE_KEY) {
    console.error('  SCRAPINGBEE_API_KEY required for trade press search');
    return [];
  }

  const queries = [
    'Broadway show recouped investment 2026',
    'Broadway musical closing capitalization 2026',
    'Broadway box office recoupment weekly gross 2026',
    'Broadway production budget investors profit 2026'
  ];

  const sites = 'site:deadline.com OR site:variety.com OR site:broadwayjournal.com OR site:playbill.com OR site:nytimes.com OR site:forbes.com';
  const results = [];
  const seenUrls = new Set();

  for (const query of queries) {
    const fullQuery = `${query} ${sites}`;
    const apiUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${SCRAPINGBEE_KEY}&search=${encodeURIComponent(fullQuery)}`;

    try {
      const response = await fetchViaScrapingBee(apiUrl, { premiumProxy: false });

      // ScrapingBee Google search returns organic_results array
      const organicResults = response?.organic_results || response?.results || [];
      if (Array.isArray(organicResults)) {
        for (const result of organicResults) {
          const url = result.url || result.link || '';
          if (!url || seenUrls.has(url)) continue;
          seenUrls.add(url);

          // Detect source from URL
          let source = 'unknown';
          if (url.includes('deadline.com')) source = 'Deadline';
          else if (url.includes('variety.com')) source = 'Variety';
          else if (url.includes('broadwayjournal.com')) source = 'Broadway Journal';
          else if (url.includes('playbill.com')) source = 'Playbill';
          else if (url.includes('nytimes.com')) source = 'New York Times';
          else if (url.includes('forbes.com')) source = 'Forbes';

          results.push({
            title: result.title || '',
            url,
            snippet: result.snippet || result.description || '',
            source
          });
        }
      }
    } catch (e) {
      console.error(`  Trade press search failed for "${query.slice(0, 40)}...": ${e.message}`);
    }

    await sleep(1000);
  }

  console.log(`  Found ${results.length} trade press articles`);
  return results;
}

/**
 * Scrape the text of a trade press article with fallback.
 *
 * @param {string} url - Article URL
 * @param {string} fallbackSnippet - Snippet to return if scraping fails
 * @returns {Promise<string>} Article text (truncated to 3000 chars)
 */
async function scrapeArticle(url, fallbackSnippet) {
  // Try ScrapingBee with JS rendering
  try {
    const result = await fetchViaScrapingBee(url, { renderJs: true, premiumProxy: true });
    if (typeof result === 'string' && result.length > 200) {
      // Strip HTML tags for plain text extraction
      const text = result
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (text.length > 200) {
        return text.slice(0, 3000);
      }
    }
  } catch (e) {
    // Fall through to snippet
  }

  return (fallbackSnippet || '').slice(0, 3000);
}

// ---------------------------------------------------------------------------
// Sprint 5: Build Analysis Context
// ---------------------------------------------------------------------------

/**
 * Build a structured text document with all gathered data for Claude analysis.
 *
 * @param {Object} data - All gathered data
 * @param {Object} data.commercial - Current commercial.json data
 * @param {Object} data.grosses - Current grosses.json data
 * @param {Object[]} data.shows - Shows from shows.json
 * @param {Object|null} data.grossesPost - Parsed grosses analysis post
 * @param {Object[]} data.grossesPostParsed - Parsed show data from grosses post
 * @param {Object[]} data.grossesComments - Comments on grosses post
 * @param {Object[]} data.redditFinancial - Reddit financial threads
 * @param {Object[]} data.tradeArticles - Trade press articles with text
 * @returns {string} Context document
 */
function buildAnalysisContext(data) {
  const sections = [];

  // Section A: Current Commercial Data
  sections.push('=== SECTION A: CURRENT COMMERCIAL DATA (commercial.json) ===');
  const commercial = data.commercial;
  for (const [slug, entry] of Object.entries(commercial.shows || {})) {
    const parts = [`${slug}: designation=${entry.designation}`];
    if (entry.capitalization) parts.push(`cap=$${(entry.capitalization / 1e6).toFixed(1)}M`);
    if (entry.weeklyRunningCost) parts.push(`weeklyCost=$${(entry.weeklyRunningCost / 1e3).toFixed(0)}k`);
    if (entry.recouped != null) parts.push(`recouped=${entry.recouped}`);
    if (entry.recoupedDate) parts.push(`recoupedDate=${entry.recoupedDate}`);
    if (entry.estimatedRecoupmentPct) parts.push(`estRecoup=${entry.estimatedRecoupmentPct.join('-')}%`);
    if (entry.notes) parts.push(`notes="${entry.notes.slice(0, 150)}"`);
    sections.push(parts.join(', '));
  }

  // Section B: Box Office Math
  sections.push('\n=== SECTION B: BOX OFFICE MATH (grosses.json) ===');
  sections.push(`Week ending: ${data.grosses?.weekEnding || 'unknown'}`);
  for (const [slug, g] of Object.entries(data.grosses?.shows || {})) {
    if (!g.thisWeek) continue;
    const tw = g.thisWeek;
    const cap = commercial.shows?.[slug]?.capitalization;
    const allTimeGross = g.allTime?.gross;
    let ratioStr = '';
    if (cap && allTimeGross) {
      const ratio = (allTimeGross / cap).toFixed(1);
      ratioStr = ` grossToCapRatio=${ratio}x`;
    }
    sections.push(`${slug}: gross=$${tw.gross}, cap=${tw.capacity}%, atp=$${tw.atp}${ratioStr}`);
  }

  // Section C: Grosses Analysis Post Data
  if (data.grossesPost) {
    sections.push('\n=== SECTION C: GROSSES ANALYSIS POST ===');
    sections.push(`Title: ${data.grossesPost.title}`);
    sections.push(`Week: ${data.grossesPost.weekEnding || 'unknown'}`);
    sections.push(`Permalink: https://www.reddit.com${data.grossesPost.permalink}`);
    sections.push('');

    for (const show of (data.grossesPostParsed || [])) {
      const parts = [`${show.showName}:`];
      if (show.weeklyGross) parts.push(`gross=$${show.weeklyGross}`);
      if (show.capacity) parts.push(`cap=${show.capacity}%`);
      if (show.atp) parts.push(`atp=$${show.atp}`);
      if (show.grossLessFees) parts.push(`gLessFees=$${show.grossLessFees}`);
      if (show.estimatedWeeklyCost) parts.push(`weeklyCost=$${show.estimatedWeeklyCost}`);
      if (show.estimatedProfitLoss != null) parts.push(`profitLoss=$${show.estimatedProfitLoss}`);
      if (show.estimatedRecoupmentPct) parts.push(`recoup=${show.estimatedRecoupmentPct.join('-')}%`);
      if (show.commentary) parts.push(`commentary="${show.commentary.slice(0, 200)}"`);
      sections.push(parts.join(', '));
    }
  }

  // Section D: Grosses Analysis Comments
  if (data.grossesComments && data.grossesComments.length > 0) {
    sections.push('\n=== SECTION D: GROSSES ANALYSIS POST COMMENTS ===');
    for (const c of data.grossesComments.slice(0, 15)) {
      sections.push(`[score:${c.score}] u/${c.author}: ${c.body.slice(0, 500)}`);
      sections.push('---');
    }
  }

  // Section E: Reddit Financial Threads
  if (data.redditFinancial && data.redditFinancial.length > 0) {
    sections.push('\n=== SECTION E: REDDIT FINANCIAL DISCUSSION THREADS ===');
    for (const post of data.redditFinancial.slice(0, 10)) {
      sections.push(`[score:${post.score}] ${post.title}`);
      if (post.selftext) sections.push(post.selftext.slice(0, 500));
      if (post.comments.length > 0) {
        sections.push('  Top comments:');
        for (const c of post.comments) {
          sections.push(`    [score:${c.score}] u/${c.author}: ${c.body.slice(0, 300)}`);
        }
      }
      sections.push('---');
    }
  }

  // Section F: Trade Press Articles
  if (data.tradeArticles && data.tradeArticles.length > 0) {
    sections.push('\n=== SECTION F: TRADE PRESS ARTICLES ===');
    for (const article of data.tradeArticles.slice(0, 10)) {
      sections.push(`[${article.source}] ${article.title}`);
      sections.push(`URL: ${article.url}`);
      if (article.text) {
        sections.push(article.text.slice(0, 1500));
      } else if (article.snippet) {
        sections.push(article.snippet);
      }
      sections.push('---');
    }
  }

  // Section G: Shows Without Commercial Data
  sections.push('\n=== SECTION G: SHOWS WITHOUT COMMERCIAL DATA ===');
  const commercialSlugs = new Set(Object.keys(commercial.shows || {}));
  const openShows = (data.shows || []).filter(s => s.status === 'open' || s.status === 'previews');
  for (const show of openShows) {
    const slug = show.slug || show.id;
    if (!commercialSlugs.has(slug)) {
      sections.push(`${slug} (${show.title}) - status: ${show.status}, venue: ${show.venue}`);
    }
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Sprint 6: Claude Analysis + Confidence Filtering
// ---------------------------------------------------------------------------

/**
 * Send the analysis context to Claude Sonnet and get proposed changes.
 *
 * @param {string} contextDocument - The full context from buildAnalysisContext
 * @returns {Promise<Object>} { proposedChanges, newShowEntries, shadowClassifierNotes }
 */
async function analyzeWithClaude(contextDocument) {
  console.log('Sending context to Claude for analysis...');

  if (!ANTHROPIC_KEY) {
    throw new Error('ANTHROPIC_API_KEY must be set for AI analysis');
  }

  const systemPrompt = `You are a Broadway financial analyst maintaining the commercial.json database for Broadway Scorecard.

Your task: Review the gathered data and propose SPECIFIC, SOURCED changes to commercial.json.

RULES:
1. Every proposed change must cite a specific source (section + detail).
2. Confidence levels:
   - "high": Directly stated in a credible source (trade press, SEC filing, official announcement)
   - "medium": Strongly implied by multiple data points or the Reddit Grosses Analysis post
   - "low": Inferred from a single Reddit comment, speculation, or unclear data
3. NEVER auto-upgrade a designation to "Miracle" -- that requires extraordinary long-term proof.
4. You MAY upgrade TBD -> Windfall if the show has CONFIRMED recoupment (high or medium confidence).
5. You MAY upgrade TBD -> Fizzle or Flop if the show has CONFIRMED closing without recouping.
6. Designation changes between non-TBD categories (e.g., Fizzle -> Windfall) should be flagged, not auto-applied.
7. productionType changes should be flagged, not auto-applied.
8. For estimatedRecoupmentPct: use [low, high] ranges. Cite source.
9. For weeklyRunningCost: mark as estimate if from Reddit (isEstimate: { weeklyRunningCost: true }).
10. For capitalization: prefer SEC filings > trade press > Reddit estimates.

Respond with ONLY valid JSON (no markdown code fences):
{
  "proposedChanges": [
    {
      "slug": "show-slug",
      "field": "fieldName",
      "oldValue": <current value or null>,
      "newValue": <proposed value>,
      "confidence": "high|medium|low",
      "source": "Section X: description of evidence",
      "reason": "Brief explanation"
    }
  ],
  "newShowEntries": [
    {
      "slug": "show-slug",
      "data": {
        "designation": "TBD",
        "capitalization": null,
        "capitalizationSource": null,
        "weeklyRunningCost": null,
        "recouped": false,
        "recoupedDate": null,
        "recoupedWeeks": null,
        "recoupedSource": null,
        "notes": "..."
      },
      "confidence": "high|medium|low",
      "source": "where this info came from"
    }
  ],
  "shadowClassifierNotes": "Any observations about designation accuracy"
}`;

  const body = JSON.stringify({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{
      role: 'user',
      content: `Here is all the gathered data. Please analyze and propose changes.\n\n${contextDocument.slice(0, 100000)}`
    }]
  });

  const response = await httpsRequest({
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01'
    }
  }, body);

  const text = response.content?.[0]?.text || '';

  // Parse JSON (strip markdown fences if present)
  let jsonStr = text;
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1];
  }

  // Also try extracting raw JSON object
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (objMatch) {
    jsonStr = objMatch[0];
  }

  try {
    const parsed = JSON.parse(jsonStr);
    console.log(`  Claude proposed ${(parsed.proposedChanges || []).length} changes and ${(parsed.newShowEntries || []).length} new entries`);
    return parsed;
  } catch (e) {
    console.error(`  Failed to parse Claude response: ${e.message}`);
    console.error(`  Response text (first 500): ${text.slice(0, 500)}`);
    return { proposedChanges: [], newShowEntries: [], shadowClassifierNotes: '' };
  }
}

/**
 * Filter proposed changes by confidence and safety rules.
 *
 * - high/medium confidence -> applied
 * - low confidence -> skipped
 * - Designation changes to/from Miracle/Nonprofit/Tour Stop -> skipped
 * - Designation upgrades (non-TBD to non-TBD) -> flagged
 * - TBD -> Windfall/Fizzle/Flop with high/medium -> applied
 * - productionType changes -> flagged
 *
 * @param {Object[]} proposedChanges - From Claude analysis
 * @returns {{ applied: Object[], flagged: Object[], skipped: Object[] }}
 */
function filterByConfidence(proposedChanges) {
  const applied = [];
  const flagged = [];
  const skipped = [];

  const protectedDesignations = new Set(['Miracle', 'Nonprofit', 'Tour Stop']);

  for (const change of (proposedChanges || [])) {
    const { field, oldValue, newValue, confidence } = change;

    // Low confidence -> always skip
    if (confidence === 'low') {
      skipped.push({ ...change, skipReason: 'Low confidence' });
      continue;
    }

    // productionType changes -> flag
    if (field === 'productionType') {
      flagged.push({ ...change, flagReason: 'productionType changes require manual review' });
      continue;
    }

    // Designation changes
    if (field === 'designation') {
      // Changes to/from protected designations -> skip
      if (protectedDesignations.has(newValue) || protectedDesignations.has(oldValue)) {
        skipped.push({ ...change, skipReason: `Cannot auto-change designation to/from ${protectedDesignations.has(newValue) ? newValue : oldValue}` });
        continue;
      }

      // TBD -> something with high/medium -> apply
      if (oldValue === 'TBD') {
        applied.push(change);
        continue;
      }

      // Non-TBD to non-TBD -> flag for manual review
      flagged.push({ ...change, flagReason: 'Designation upgrade between non-TBD categories requires manual review' });
      continue;
    }

    // Everything else with high/medium -> apply
    applied.push(change);
  }

  return { applied, flagged, skipped };
}

/**
 * Apply approved changes to the commercial data object.
 * Updates _meta.lastUpdated. If DRY_RUN, prints but doesn't write.
 *
 * @param {Object[]} applied - Changes to apply
 * @param {Object[]} newEntries - New show entries to add
 * @param {Object} commercial - commercial.json data (mutated in place)
 */
function applyChanges(applied, newEntries, commercial) {
  let changeCount = 0;

  for (const change of applied) {
    const { slug, field, newValue } = change;

    if (!commercial.shows[slug]) {
      console.log(`  [SKIP] Show "${slug}" not in commercial.json`);
      continue;
    }

    const current = commercial.shows[slug][field];
    commercial.shows[slug][field] = newValue;
    changeCount++;
    console.log(`  [APPLY] ${slug}.${field}: ${JSON.stringify(current)} -> ${JSON.stringify(newValue)}`);

    // For weekly running cost, add isEstimate if from Reddit
    if (field === 'weeklyRunningCost' && change.source?.toLowerCase().includes('reddit')) {
      if (!commercial.shows[slug].isEstimate) {
        commercial.shows[slug].isEstimate = {};
      }
      commercial.shows[slug].isEstimate.weeklyRunningCost = true;
    }

    // For estimatedRecoupmentPct, add source + date
    if (field === 'estimatedRecoupmentPct') {
      commercial.shows[slug].estimatedRecoupmentSource = change.source || 'Automated update';
      commercial.shows[slug].estimatedRecoupmentDate = new Date().toISOString().split('T')[0];
    }
  }

  // Add new show entries
  for (const entry of (newEntries || [])) {
    if (entry.confidence === 'low') continue;
    if (!entry.slug || commercial.shows[entry.slug]) continue;

    commercial.shows[entry.slug] = entry.data;
    changeCount++;
    console.log(`  [NEW] Added ${entry.slug} (${entry.data.designation})`);
  }

  // Update metadata
  commercial._meta.lastUpdated = new Date().toISOString().split('T')[0];

  if (DRY_RUN) {
    console.log(`\n  [DRY RUN] Would apply ${changeCount} changes (not writing)`);
  } else if (changeCount > 0) {
    fs.writeFileSync(COMMERCIAL_PATH, JSON.stringify(commercial, null, 2));
    console.log(`\n  Wrote ${changeCount} changes to commercial.json`);
  } else {
    console.log('\n  No changes to apply');
  }

  return changeCount;
}

// ---------------------------------------------------------------------------
// Sprint 6: Shadow Classifier
// ---------------------------------------------------------------------------

/**
 * Heuristic designation validator.
 *
 * For each show (skip Nonprofit, Tour Stop):
 *   - Calculate all-time gross / capitalization ratio
 *   - Apply heuristic rules to predict a designation
 *   - Compare with actual designation
 *   - Report disagreements
 *
 * Rules:
 *   - recouped && ratio >= 20x = Miracle
 *   - recouped && ratio >= 5x = Windfall
 *   - recouped && ratio >= 2x = Windfall
 *   - recouped && ratio >= 1x = Trickle or Easy Winner
 *   - closed && not recouped && recoupmentPct < 30% = Flop
 *   - closed && not recouped && recoupmentPct >= 30% = Fizzle
 *   - still running && not recouped = TBD
 *
 * @param {Object} commercial - commercial.json data
 * @param {Object} grosses - grosses.json data
 * @param {Object[]} shows - shows.json shows array
 * @returns {Object[]} Disagreements: { slug, current, predicted, reason }
 */
function shadowClassifier(commercial, grosses, shows) {
  const disagreements = [];
  const skipDesignations = new Set(['Nonprofit', 'Tour Stop']);

  const showStatusMap = {};
  for (const s of shows) {
    showStatusMap[s.slug || s.id] = s.status;
  }

  for (const [slug, entry] of Object.entries(commercial.shows || {})) {
    if (skipDesignations.has(entry.designation)) continue;

    const cap = entry.capitalization;
    const recouped = entry.recouped;
    const status = showStatusMap[slug] || 'unknown';
    const allTimeGross = grosses?.shows?.[slug]?.allTime?.gross;

    // Calculate gross-to-cap ratio
    let ratio = null;
    if (cap && cap > 0 && allTimeGross) {
      ratio = allTimeGross / cap;
    }

    // Predict designation
    let predicted = null;
    let reason = '';

    if (recouped === true) {
      if (ratio !== null) {
        if (ratio >= 20) {
          predicted = 'Miracle';
          reason = `Recouped + ${ratio.toFixed(1)}x gross-to-cap ratio (>= 20x)`;
        } else if (ratio >= 5) {
          predicted = 'Windfall';
          reason = `Recouped + ${ratio.toFixed(1)}x gross-to-cap ratio (>= 5x)`;
        } else if (ratio >= 2) {
          predicted = 'Windfall';
          reason = `Recouped + ${ratio.toFixed(1)}x gross-to-cap ratio (>= 2x)`;
        } else {
          predicted = 'Trickle';
          reason = `Recouped but only ${ratio.toFixed(1)}x gross-to-cap ratio`;
        }
      } else {
        predicted = 'Windfall';
        reason = 'Recouped (no cap data for ratio)';
      }
    } else if (recouped === false && status === 'closed') {
      // Closed without recouping
      const recoupPct = entry.estimatedRecoupmentPct;
      if (recoupPct) {
        const midpoint = (recoupPct[0] + recoupPct[1]) / 2;
        if (midpoint < 30) {
          predicted = 'Flop';
          reason = `Closed, est. ${recoupPct.join('-')}% recouped (< 30%)`;
        } else {
          predicted = 'Fizzle';
          reason = `Closed, est. ${recoupPct.join('-')}% recouped (>= 30%)`;
        }
      } else if (ratio !== null) {
        if (ratio < 0.3) {
          predicted = 'Flop';
          reason = `Closed, ratio ${ratio.toFixed(2)}x (< 0.3x)`;
        } else {
          predicted = 'Fizzle';
          reason = `Closed, ratio ${ratio.toFixed(2)}x (>= 0.3x)`;
        }
      } else {
        predicted = 'Fizzle';
        reason = 'Closed without recouping (insufficient data for Flop/Fizzle)';
      }
    } else if (recouped === false && (status === 'open' || status === 'previews')) {
      predicted = 'TBD';
      reason = 'Still running, not yet recouped';
    } else {
      // recouped === null or unknown status
      predicted = 'TBD';
      reason = 'Insufficient data';
    }

    // Compare with actual
    if (predicted && predicted !== entry.designation) {
      // Don't flag Easy Winner since it's hard to predict heuristically
      if (entry.designation === 'Easy Winner') continue;
      // Don't flag Trickle vs Windfall -- close enough
      if ((entry.designation === 'Trickle' && predicted === 'Windfall') ||
          (entry.designation === 'Windfall' && predicted === 'Trickle')) continue;

      disagreements.push({
        slug,
        current: entry.designation,
        predicted,
        reason
      });
    }
  }

  return disagreements;
}

// ---------------------------------------------------------------------------
// Sprint 6: Changelog
// ---------------------------------------------------------------------------

/**
 * Append an entry to commercial-changelog.json.
 *
 * @param {Object} entry - Changelog entry
 */
function writeChangelog(entry) {
  let changelog = [];
  if (fs.existsSync(CHANGELOG_PATH)) {
    try {
      changelog = JSON.parse(fs.readFileSync(CHANGELOG_PATH, 'utf8'));
    } catch (e) {
      changelog = [];
    }
  }

  if (!Array.isArray(changelog)) {
    changelog = [];
  }

  changelog.unshift(entry); // Newest first

  // Keep last 100 entries
  if (changelog.length > 100) {
    changelog = changelog.slice(0, 100);
  }

  if (!DRY_RUN) {
    fs.writeFileSync(CHANGELOG_PATH, JSON.stringify(changelog, null, 2));
    console.log('  Wrote changelog entry');
  } else {
    console.log('  [DRY RUN] Would write changelog entry');
  }
}

// ---------------------------------------------------------------------------
// Sprint 7: GitHub Issue
// ---------------------------------------------------------------------------

/**
 * Create a GitHub issue summarizing the update.
 *
 * @param {Object} summary - { applied, flagged, skipped, disagreements, newEntries, dateStr }
 */
async function createGitHubIssue(summary) {
  if (!GITHUB_TOKEN) {
    console.log('  GITHUB_TOKEN not set, skipping issue creation');
    return;
  }

  const { applied, flagged, skipped, disagreements, newEntries, dateStr } = summary;

  let body = `## Commercial Data Auto-Update: ${dateStr}\n\n`;

  // Applied changes table
  if (applied.length > 0) {
    body += `### Applied Changes (${applied.length})\n\n`;
    body += '| Show | Field | Old | New | Confidence | Source |\n';
    body += '|------|-------|-----|-----|------------|--------|\n';
    for (const c of applied) {
      const old = JSON.stringify(c.oldValue) || 'null';
      const val = JSON.stringify(c.newValue) || 'null';
      body += `| ${c.slug} | ${c.field} | ${old} | ${val} | ${c.confidence} | ${(c.source || '').slice(0, 50)} |\n`;
    }
    body += '\n';
  } else {
    body += '### No Changes Applied\n\n';
  }

  // New entries
  if (newEntries && newEntries.length > 0) {
    body += `### New Show Entries (${newEntries.length})\n\n`;
    for (const e of newEntries) {
      body += `- **${e.slug}**: ${e.data?.designation || 'TBD'} (${e.confidence})\n`;
    }
    body += '\n';
  }

  // Flagged changes
  if (flagged.length > 0) {
    body += `### Flagged for Manual Review (${flagged.length})\n\n`;
    body += '| Show | Field | Old | New | Reason |\n';
    body += '|------|-------|-----|-----|--------|\n';
    for (const c of flagged) {
      body += `| ${c.slug} | ${c.field} | ${JSON.stringify(c.oldValue)} | ${JSON.stringify(c.newValue)} | ${c.flagReason || ''} |\n`;
    }
    body += '\n';
  }

  // Skipped
  if (skipped.length > 0) {
    body += `<details><summary>Skipped Changes (${skipped.length})</summary>\n\n`;
    for (const c of skipped) {
      body += `- ${c.slug}.${c.field}: ${c.skipReason}\n`;
    }
    body += '\n</details>\n\n';
  }

  // Shadow classifier disagreements
  if (disagreements.length > 0) {
    body += `### Shadow Classifier Disagreements (${disagreements.length})\n\n`;
    body += '| Show | Current | Predicted | Reason |\n';
    body += '|------|---------|-----------|--------|\n';
    for (const d of disagreements) {
      body += `| ${d.slug} | ${d.current} | ${d.predicted} | ${d.reason} |\n`;
    }
    body += '\n';
  }

  body += '\n---\n*Generated by `scripts/update-commercial-data.js`*\n';

  const issueData = JSON.stringify({
    title: `Commercial Data Update: ${dateStr}`,
    body,
    labels: ['automation', 'commercial-data']
  });

  try {
    await httpsRequest({
      hostname: 'api.github.com',
      path: '/repos/thomaspryor/Broadwayscore/issues',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GITHUB_TOKEN}`,
        'User-Agent': 'BroadwayScorecard-Bot',
        'Accept': 'application/vnd.github.v3+json'
      }
    }, issueData);

    console.log('  Created GitHub issue');
  } catch (e) {
    console.error(`  Failed to create GitHub issue: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Broadway Scorecard: Commercial Data Updater ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Gather: ${GATHER_ALL ? 'ALL' : (GATHER_REDDIT ? 'REDDIT' : 'TRADE')}`);
  if (GATHER_ONLY) console.log('Stopping after gather (--gather-only)');
  console.log('');

  // Validate environment
  if (!SCRAPINGBEE_KEY) {
    console.error('ERROR: SCRAPINGBEE_API_KEY must be set');
    process.exit(1);
  }
  if (!GATHER_ONLY && !ANTHROPIC_KEY) {
    console.error('ERROR: ANTHROPIC_API_KEY must be set (or use --gather-only)');
    process.exit(1);
  }

  // Load data files
  let commercial, shows, grosses;
  try {
    commercial = JSON.parse(fs.readFileSync(COMMERCIAL_PATH, 'utf8'));
    shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    grosses = JSON.parse(fs.readFileSync(GROSSES_PATH, 'utf8'));
  } catch (e) {
    console.error(`ERROR: Failed to load data files: ${e.message}`);
    process.exit(1);
  }

  const allSlugs = Object.keys(commercial.shows || {});
  const allShows = shows.shows || [];

  // Gathered data accumulator
  const gathered = {
    commercial,
    grosses,
    shows: allShows,
    grossesPost: null,
    grossesPostParsed: [],
    grossesComments: [],
    redditFinancial: [],
    tradeArticles: []
  };

  // Total gather timeout: 5 minutes
  const gatherStart = Date.now();
  const GATHER_TIMEOUT_MS = 5 * 60 * 1000;

  function isTimedOut() {
    return (Date.now() - gatherStart) > GATHER_TIMEOUT_MS;
  }

  // -----------------------------------------------------------------------
  // Step 3: Gather Reddit data
  // -----------------------------------------------------------------------
  if (GATHER_REDDIT || GATHER_ALL) {
    // Fetch Grosses Analysis post
    try {
      if (!isTimedOut()) {
        gathered.grossesPost = await fetchGrossesAnalysisPost();
        await sleep(2000);
      }
    } catch (e) {
      console.error(`Grosses Analysis fetch failed: ${e.message}`);
    }

    // Parse it
    if (gathered.grossesPost?.selftext) {
      try {
        gathered.grossesPostParsed = await parseGrossesPost(gathered.grossesPost.selftext);

        // Match show names to slugs
        for (const show of gathered.grossesPostParsed) {
          const match = matchShowToSlug(show.showName, allSlugs, allShows);
          if (match) {
            show.matchedSlug = match.slug;
            show.matchConfidence = match.confidence;
          }
        }

        const matched = gathered.grossesPostParsed.filter(s => s.matchedSlug).length;
        console.log(`  Matched ${matched}/${gathered.grossesPostParsed.length} shows to slugs`);
      } catch (e) {
        console.error(`Grosses Analysis parse failed: ${e.message}`);
      }
    }

    // Fetch post comments
    if (gathered.grossesPost?.permalink && !isTimedOut()) {
      try {
        await sleep(2000);
        gathered.grossesComments = await fetchPostComments(gathered.grossesPost.permalink);
      } catch (e) {
        console.error(`Grosses comments fetch failed: ${e.message}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 4: Gather trade press data
  // -----------------------------------------------------------------------
  if (GATHER_TRADE || GATHER_ALL) {
    // Reddit financial threads
    if (!isTimedOut()) {
      try {
        gathered.redditFinancial = await searchRedditFinancial(
          gathered.grossesPost?.permalink || null
        );
      } catch (e) {
        console.error(`Reddit financial search failed: ${e.message}`);
      }
    }

    // Trade press search
    if (!isTimedOut()) {
      try {
        const tradeResults = await searchTradePress();
        gathered.tradeArticles = tradeResults;

        // Scrape article text (max 10 articles, 1s between)
        let scraped = 0;
        for (const article of gathered.tradeArticles.slice(0, 10)) {
          if (isTimedOut()) break;
          try {
            article.text = await scrapeArticle(article.url, article.snippet);
            scraped++;
          } catch (e) {
            article.text = article.snippet || '';
          }
          await sleep(1000);
        }
        console.log(`  Scraped ${scraped} article texts`);
      } catch (e) {
        console.error(`Trade press search failed: ${e.message}`);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 5: Build context
  // -----------------------------------------------------------------------
  const contextDocument = buildAnalysisContext(gathered);
  console.log(`\nBuilt analysis context: ${contextDocument.length} chars`);

  // -----------------------------------------------------------------------
  // Step 6: If gather-only, write debug output and exit
  // -----------------------------------------------------------------------
  if (GATHER_ONLY) {
    if (!fs.existsSync(DEBUG_DIR)) {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
    }
    const debugPath = path.join(DEBUG_DIR, `commercial-context-${new Date().toISOString().split('T')[0]}.txt`);
    if (!DRY_RUN) {
      fs.writeFileSync(debugPath, contextDocument);
      console.log(`Wrote debug context to ${debugPath}`);
    }
    console.log('\n--gather-only: stopping before AI analysis');
    return;
  }

  // -----------------------------------------------------------------------
  // Step 7: Claude analysis
  // -----------------------------------------------------------------------
  let analysisResult;
  try {
    analysisResult = await analyzeWithClaude(contextDocument);
  } catch (e) {
    console.error(`Claude analysis failed: ${e.message}`);
    process.exit(1);
  }

  // -----------------------------------------------------------------------
  // Step 8: Filter by confidence
  // -----------------------------------------------------------------------
  const { applied, flagged, skipped } = filterByConfidence(analysisResult.proposedChanges || []);
  console.log(`\nFiltered: ${applied.length} applied, ${flagged.length} flagged, ${skipped.length} skipped`);

  // -----------------------------------------------------------------------
  // Step 9: Apply changes
  // -----------------------------------------------------------------------
  const changeCount = applyChanges(applied, analysisResult.newShowEntries, commercial);

  // -----------------------------------------------------------------------
  // Step 10: Shadow classifier
  // -----------------------------------------------------------------------
  const disagreements = shadowClassifier(commercial, grosses, allShows);
  if (disagreements.length > 0) {
    console.log(`\nShadow Classifier Disagreements (${disagreements.length}):`);
    for (const d of disagreements) {
      console.log(`  ${d.slug}: current=${d.current}, predicted=${d.predicted} -- ${d.reason}`);
    }
  } else {
    console.log('\nShadow Classifier: No disagreements');
  }

  // -----------------------------------------------------------------------
  // Step 11: Write changelog
  // -----------------------------------------------------------------------
  const dateStr = new Date().toISOString().split('T')[0];
  if (applied.length > 0 || (analysisResult.newShowEntries || []).length > 0) {
    writeChangelog({
      date: dateStr,
      timestamp: new Date().toISOString(),
      changesApplied: applied.length,
      changesFlagged: flagged.length,
      changesSkipped: skipped.length,
      newEntries: (analysisResult.newShowEntries || []).filter(e => e.confidence !== 'low').length,
      shadowDisagreements: disagreements.length,
      applied: applied.map(c => ({
        slug: c.slug,
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
        confidence: c.confidence,
        source: c.source
      })),
      flagged: flagged.map(c => ({
        slug: c.slug,
        field: c.field,
        newValue: c.newValue,
        flagReason: c.flagReason
      }))
    });
  }

  // -----------------------------------------------------------------------
  // Step 12: Create GitHub issue
  // -----------------------------------------------------------------------
  if (GITHUB_TOKEN && !DRY_RUN && (applied.length > 0 || flagged.length > 0 || disagreements.length > 0)) {
    try {
      await createGitHubIssue({
        applied,
        flagged,
        skipped,
        disagreements,
        newEntries: (analysisResult.newShowEntries || []).filter(e => e.confidence !== 'low'),
        dateStr
      });
    } catch (e) {
      console.error(`GitHub issue creation failed: ${e.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // Step 13: Summary
  // -----------------------------------------------------------------------
  console.log('\n=== Summary ===');
  console.log(`Date: ${dateStr}`);
  console.log(`Grosses Analysis Post: ${gathered.grossesPost ? 'Found' : 'Not found'}`);
  console.log(`Shows parsed from GA: ${gathered.grossesPostParsed.length}`);
  console.log(`Reddit financial threads: ${gathered.redditFinancial.length}`);
  console.log(`Trade press articles: ${gathered.tradeArticles.length}`);
  console.log(`Changes applied: ${applied.length}`);
  console.log(`Changes flagged: ${flagged.length}`);
  console.log(`Changes skipped: ${skipped.length}`);
  console.log(`Shadow disagreements: ${disagreements.length}`);
  if (DRY_RUN) console.log('(DRY RUN -- no files modified)');
  console.log('');
}

// Exports for unit testing
module.exports = { filterByConfidence, shadowClassifier };

// Run only when executed directly (not when require()'d for testing)
if (require.main === module) {
  main().catch(e => {
    console.error('Fatal error:', e.message);
    process.exit(1);
  });
}
