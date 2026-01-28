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

// Universal scraper with Bright Data → ScrapingBee → Playwright fallback
let universalScraper;
try {
  universalScraper = require('./lib/scraper');
} catch (e) {
  console.warn('Warning: scraper module not available');
}

// Sprint 4: Import new modules
let tradePressScraper;
try {
  tradePressScraper = require('./lib/trade-press-scraper');
} catch (e) {
  console.warn('Warning: trade-press-scraper module not available');
}

let sourceValidator;
try {
  sourceValidator = require('./lib/source-validator');
} catch (e) {
  console.warn('Warning: source-validator module not available');
}

// ---------------------------------------------------------------------------
// CLI Arguments
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const GATHER_REDDIT = args.includes('--gather-reddit');
const GATHER_TRADE = args.includes('--gather-trade');
const GATHER_ALL = args.includes('--gather-all') || (!GATHER_REDDIT && !GATHER_TRADE);
const GATHER_ONLY = args.includes('--gather-only');

// Sprint 4 new flags
const GATHER_SEC = args.includes('--gather-sec');           // Enable SEC EDGAR gathering
const GATHER_TRADE_FULL = args.includes('--gather-trade-full'); // Use enhanced trade press scraper
const SKIP_VALIDATION = args.includes('--skip-validation');  // Bypass source validation

// Feature flag for SEC EDGAR (gracefully disabled if module not available)
let SEC_EDGAR_ENABLED = false;
try {
  require('./lib/sec-edgar-scraper');
  SEC_EDGAR_ENABLED = true;
} catch (e) {
  // SEC EDGAR module not available
}

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
// Sprint 4.12: Claude API Usage Tracking
// ---------------------------------------------------------------------------
const claudeApiUsage = {
  inputTokens: 0,
  outputTokens: 0,
  calls: 0
};

// ---------------------------------------------------------------------------
// Known Aliases: Reddit show names -> slugs in commercial.json / shows.json
// ---------------------------------------------------------------------------
const KNOWN_ALIASES = {
  // Harry Potter variations
  'harry potter and the cursed child': 'harry-potter',
  'harry potter': 'harry-potter',
  'cursed child': 'harry-potter',
  'hp cursed child': 'harry-potter',
  'hpatcc': 'harry-potter',

  // Lion King variations
  'the lion king': 'the-lion-king-1997',
  'lion king': 'the-lion-king-1997',
  'tlk': 'the-lion-king-1997',

  // Beautiful Noise variations
  'a beautiful noise': 'a-beautiful-noise-2022',
  'beautiful noise': 'a-beautiful-noise-2022',
  'a beautiful noise: the neil diamond musical': 'a-beautiful-noise-2022',
  'neil diamond musical': 'a-beautiful-noise-2022',

  // Book of Mormon variations
  'the book of mormon': 'book-of-mormon',
  'book of mormon': 'book-of-mormon',
  'bom': 'book-of-mormon',

  // MJ variations
  'mj': 'mj',
  'mj the musical': 'mj',
  'mj: the musical': 'mj',
  'michael jackson musical': 'mj',

  // SIX variations
  'six': 'six',
  'six the musical': 'six',
  'six: the musical': 'six',
  'six on broadway': 'six',

  // Chicago variations
  'chicago': 'chicago',
  'chicago the musical': 'chicago',
  'chicago: the musical': 'chicago',

  // Core hits
  'hamilton': 'hamilton',
  'hamilton: an american musical': 'hamilton',
  'wicked': 'wicked',
  'wicked the musical': 'wicked',
  'aladdin': 'aladdin',
  'disney aladdin': 'aladdin',

  // Moulin Rouge variations
  'moulin rouge': 'moulin-rouge',
  'moulin rouge!': 'moulin-rouge',
  'moulin rouge! the musical': 'moulin-rouge',
  'moulin rouge the musical': 'moulin-rouge',

  // Hadestown
  'hadestown': 'hadestown',

  // The Outsiders
  'the outsiders': 'the-outsiders',
  'outsiders': 'the-outsiders',
  'the outsiders musical': 'the-outsiders',

  // Great Gatsby
  'the great gatsby': 'the-great-gatsby',
  'great gatsby': 'the-great-gatsby',
  'gatsby': 'the-great-gatsby',

  // Death Becomes Her variations
  'death becomes her': 'death-becomes-her',
  'death becomes her: the musical': 'death-becomes-her',
  'death becomes her the musical': 'death-becomes-her',
  'dbh': 'death-becomes-her',

  // Stranger Things variations
  'stranger things': 'stranger-things',
  'stranger things: the first shadow': 'stranger-things',
  'stranger things the first shadow': 'stranger-things',
  'st: the first shadow': 'stranger-things',

  // Other current shows
  'buena vista social club': 'buena-vista-social-club',
  'bvsc': 'buena-vista-social-club',
  'operation mincemeat': 'operation-mincemeat',
  'op mincemeat': 'operation-mincemeat',
  'just in time': 'just-in-time',

  // Two Strangers variations
  'two strangers': 'two-strangers',
  'two strangers (carry a cake across new york)': 'two-strangers',
  'two strangers carry a cake': 'two-strangers',

  'maybe happy ending': 'maybe-happy-ending',

  // & Juliet variations
  'and juliet': 'and-juliet',
  '& juliet': 'and-juliet',
  '&juliet': 'and-juliet',

  // Oh Mary variations
  'oh, mary!': 'oh-mary',
  'oh mary': 'oh-mary',
  'oh mary!': 'oh-mary',

  'stereophonic': 'stereophonic',
  'the roommate': 'the-roommate',
  'roommate': 'the-roommate',
  'our town': 'our-town',

  // Notebook variations
  'the notebook': 'the-notebook',
  'notebook': 'the-notebook',
  'the notebook musical': 'the-notebook',

  // Back to the Future variations
  'back to the future': 'back-to-the-future',
  'back to the future: the musical': 'back-to-the-future',
  'back to the future the musical': 'back-to-the-future',
  'bttf': 'back-to-the-future',

  // Boop variations
  'boop! the musical': 'boop',
  'boop': 'boop',
  'boop the musical': 'boop',
  'betty boop': 'boop',
  'betty boop musical': 'boop',

  // Water for Elephants
  'water for elephants': 'water-for-elephants',
  'wfe': 'water-for-elephants',

  'suffs': 'suffs',
  'suffragettes': 'suffs',

  // Hell's Kitchen variations
  "hell's kitchen": 'hells-kitchen',
  'hells kitchen': 'hells-kitchen',
  "hell's kitchen musical": 'hells-kitchen',
  'alicia keys musical': 'hells-kitchen',

  // Cabaret variations
  'cabaret': 'cabaret-2024',
  'cabaret at the kit kat club': 'cabaret-2024',
  'kit kat club': 'cabaret-2024',
  'cabaret revival': 'cabaret-2024',

  // Queen of Versailles variations
  'queen of versailles': 'queen-of-versailles',
  'the queen of versailles': 'queen-of-versailles',
  'qov': 'queen-of-versailles',

  // Classic revivals
  'ragtime': 'ragtime',
  'ragtime revival': 'ragtime',
  'chess': 'chess',
  'chess the musical': 'chess',

  'liberation': 'liberation',

  // All Out
  'all out': 'all-out',
  'all out comedy': 'all-out',
  'all out: comedy about ambition': 'all-out',

  // Mamma Mia variations
  'mamma mia': 'mamma-mia',
  'mamma mia!': 'mamma-mia',
  'mama mia': 'mamma-mia',

  'bug': 'bug',
  'marjorie prime': 'marjorie-prime',
  'oedipus': 'oedipus',
  'swept away': 'swept-away',
  'avett brothers musical': 'swept-away',

  // Sunset Boulevard variations
  'sunset boulevard': 'sunset-blvd-2024',
  'sunset blvd.': 'sunset-blvd-2024',
  'sunset blvd': 'sunset-blvd-2024',
  'sunset boulevard revival': 'sunset-blvd-2024',

  // Hills of California
  'the hills of california': 'hills-of-california',
  'hills of california': 'hills-of-california',

  'left on tenth': 'left-on-tenth',
  'tammy faye': 'tammy-faye',
  'tammy faye musical': 'tammy-faye',
  'yellowface': 'yellowface',
  'eureka day': 'eureka-day',

  // Gypsy variations
  'gypsy': 'gypsy-2024',
  'gypsy revival': 'gypsy-2024',
  'gypsy 2024': 'gypsy-2024',

  // Once Upon a Mattress
  'once upon a mattress': 'once-upon-a-mattress-2024',
  'mattress': 'once-upon-a-mattress-2024',

  'real friends of claridge county': 'real-friends-of-claridge-county',
  'real friends': 'real-friends-of-claridge-county',

  // Additional shows from shows.json
  'every brilliant thing': 'every-brilliant-thing',
  'death of a salesman': 'death-of-a-salesman',
  'salesman': 'death-of-a-salesman',
  'beaches': 'beaches',
  'beaches a new musical': 'beaches',
  'the balusters': 'the-balusters',
  'balusters': 'the-balusters',
  'becky shaw': 'becky-shaw',

  // CATS variations
  'cats': 'cats-the-jellicle-ball',
  'cats the jellicle ball': 'cats-the-jellicle-ball',
  'cats: the jellicle ball': 'cats-the-jellicle-ball',
  'jellicle ball': 'cats-the-jellicle-ball',

  'dog day afternoon': 'dog-day-afternoon',
  'fallen angels': 'fallen-angels',
  'the fear of 13': 'the-fear-of-13',
  'fear of 13': 'the-fear-of-13',
  'giant': 'giant',
  'giant musical': 'giant',
  "joe turner's come and gone": 'joe-turners-come-and-gone',
  'joe turner': 'joe-turners-come-and-gone',
  'the lost boys': 'the-lost-boys',
  'lost boys': 'the-lost-boys',
  'proof': 'proof',
  'the rocky horror show': 'the-rocky-horror-show',
  'rocky horror': 'the-rocky-horror-show',
  'rocky horror show': 'the-rocky-horror-show',
  'schmigadoon': 'schmigadoon',
  'schmigadoon!': 'schmigadoon',
  'titanique': 'titanique',
  'real women have curves': 'real-women-have-curves',
  'redwood': 'redwood',
  'days of wine and roses': 'days-of-wine-and-roses',
  'wine and roses': 'days-of-wine-and-roses',
  'harmony': 'harmony',
  'here lies love': 'here-lies-love',
  'how to dance in ohio': 'how-to-dance-in-ohio',
  'dance in ohio': 'how-to-dance-in-ohio',
  'illinoise': 'illinoise',
  'sufjan stevens musical': 'illinoise',
  'lempicka': 'lempicka',
  'once upon a one more time': 'once-upon-a-one-more-time',
  'britney spears musical': 'once-upon-a-one-more-time',
  'the heart of rock and roll': 'heart-of-rock-and-roll',
  'heart of rock and roll': 'heart-of-rock-and-roll',
  'huey lewis musical': 'heart-of-rock-and-roll',
  'gutenberg': 'gutenberg',
  'gutenberg! the musical!': 'gutenberg',
  'gutenberg the musical': 'gutenberg',
  'merrily we roll along': 'merrily-we-roll-along',
  'merrily': 'merrily-we-roll-along',
  'spamalot': 'spamalot',
  'monty python spamalot': 'spamalot',
  "the who's tommy": 'the-whos-tommy',
  'tommy': 'the-whos-tommy',
  'the wiz': 'the-wiz',
  'wiz': 'the-wiz',
  'grey house': 'grey-house',
  'i need that': 'i-need-that',
  "jaja's african hair braiding": 'jajas-african-hair-braiding',
  'jajas african hair braiding': 'jajas-african-hair-braiding',
  'just for us': 'just-for-us',
  'mary jane': 'mary-jane',
  'mother play': 'mother-play',
  'patriots': 'patriots',
  'prayer for the french republic': 'prayer-for-the-french-republic',
  'french republic': 'prayer-for-the-french-republic',
  'the cottage': 'the-cottage',
  'cottage': 'the-cottage',
  'the shark is broken': 'the-shark-is-broken',
  'shark is broken': 'the-shark-is-broken',
  'an enemy of the people': 'an-enemy-of-the-people',
  'enemy of the people': 'an-enemy-of-the-people',
  'appropriate': 'appropriate',
  'doubt': 'doubt',
  'doubt: a parable': 'doubt',
  'doubt a parable': 'doubt',
  'purlie victorious': 'purlie-victorious',
  'purlie': 'purlie-victorious',
  'uncle vanya': 'uncle-vanya',
  'vanya': 'uncle-vanya',
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

    // Sprint 4.12: Track Claude API usage
    claudeApiUsage.calls++;
    if (response.usage) {
      claudeApiUsage.inputTokens += response.usage.input_tokens || 0;
      claudeApiUsage.outputTokens += response.usage.output_tokens || 0;
    }

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
 * Search r/Broadway and r/musicals for financial discussion threads (past 7 days).
 *
 * Runs 8+ search queries with 2s delay between each, deduplicates,
 * and fetches top 5 comments per unique post.
 *
 * Sprint 4.6: Expanded to include r/musicals subreddit
 *
 * @param {string|null} grossesPostPermalink - Permalink to exclude (the main GA post)
 * @returns {Promise<Object[]>} Financial discussion posts
 */
async function searchRedditFinancial(grossesPostPermalink) {
  console.log('Searching r/Broadway and r/musicals for financial discussion threads...');

  const queries = [
    // Original queries
    'recouped OR recoupment',
    'capitalization OR investment Broadway',
    'closing OR "final performance"',
    '"running costs" OR "weekly nut"',
    // Sprint 4.6: New financial-specific queries
    '"break even" OR "breaking even"',
    '"SEC filing" OR "Form D"',
    'flair:News recoup',
    'investors profit Broadway'
  ];

  // Sprint 4.6: Search both r/Broadway and r/musicals
  const subreddits = ['Broadway', 'musicals'];

  const seenIds = new Set();
  const posts = [];

  for (const subreddit of subreddits) {
    for (const query of queries) {
      const encoded = encodeURIComponent(query);
      const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encoded}&restrict_sr=1&sort=new&t=week&limit=10`;

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
              subreddit: subreddit,  // Track source subreddit
              createdUtc: post.created_utc,
              comments: []
            });
          }
        }
      } catch (e) {
        console.error(`  Search query "${query}" in r/${subreddit} failed: ${e.message}`);
      }

      await sleep(2000);
    }
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

  // Direct RSS feeds and section URLs for Broadway/theater news
  // This approach is more reliable than Google Search APIs
  const TRADE_SOURCES = [
    {
      name: 'Deadline',
      rssUrl: 'https://deadline.com/tag/broadway/feed/',
      sectionUrl: 'https://deadline.com/tag/broadway/',
      source: 'Deadline'
    },
    {
      name: 'Variety',
      rssUrl: 'https://variety.com/t/broadway/feed/',
      sectionUrl: 'https://variety.com/t/broadway/',
      source: 'Variety'
    },
    {
      name: 'Playbill',
      rssUrl: 'https://www.playbill.com/rss/news',
      sectionUrl: 'https://www.playbill.com/news',
      source: 'Playbill'
    },
    {
      name: 'Broadway Journal',
      rssUrl: null,
      sectionUrl: 'https://broadwayjournal.com/category/news/',
      source: 'Broadway Journal'
    }
  ];

  // Financial keywords to filter for
  const FINANCIAL_KEYWORDS = [
    'recoup', 'recouped', 'recoupment',
    'capitalization', 'capitalized', 'capital',
    'investment', 'investor', 'investors',
    'profit', 'profitable', 'profitability',
    'break even', 'break-even', 'breakeven',
    'budget', 'cost', 'costs',
    'gross', 'grosses', 'grossing',
    'closing', 'close', 'closes',
    'SEC', 'Form D', 'filing',
    'million', '$', 'financial'
  ];

  const results = [];
  const seenUrls = new Set();

  // Helper to check if text contains financial keywords
  const hasFinancialKeywords = (text) => {
    if (!text) return false;
    const lower = text.toLowerCase();
    return FINANCIAL_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()));
  };

  // Helper to parse RSS XML
  const parseRSS = (xml) => {
    const items = [];
    const itemMatches = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];
    for (const item of itemMatches) {
      const title = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/i)?.[1] || '';
      const link = item.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/i)?.[1] || '';
      const desc = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/i)?.[1] || '';
      if (link) {
        items.push({ title: title.trim(), url: link.trim(), snippet: desc.replace(/<[^>]+>/g, '').trim() });
      }
    }
    return items;
  };

  // Helper to parse HTML section page for article links
  const parseHTMLSection = (html, baseUrl) => {
    const items = [];
    // Look for article links with titles
    const linkMatches = html.match(/<a[^>]+href=["']([^"']+)["'][^>]*>([^<]+)<\/a>/gi) || [];
    for (const match of linkMatches) {
      const urlMatch = match.match(/href=["']([^"']+)["']/i);
      const titleMatch = match.match(/>([^<]+)</);
      if (urlMatch && titleMatch) {
        let url = urlMatch[1];
        if (url.startsWith('/')) url = new URL(url, baseUrl).href;
        if (url.includes('/202') && !url.includes('/tag/') && !url.includes('/category/')) {
          items.push({ title: titleMatch[1].trim(), url, snippet: '' });
        }
      }
    }
    return items;
  };

  for (const source of TRADE_SOURCES) {
    console.log(`  Checking ${source.name}...`);

    // Try RSS first (faster, less bandwidth)
    if (source.rssUrl) {
      try {
        const rssContent = await fetchPageSimple(source.rssUrl);
        if (rssContent) {
          const items = parseRSS(rssContent);
          for (const item of items.slice(0, 20)) { // Last 20 articles
            if (seenUrls.has(item.url)) continue;
            if (hasFinancialKeywords(item.title) || hasFinancialKeywords(item.snippet)) {
              seenUrls.add(item.url);
              results.push({ ...item, source: source.source });
            }
          }
          console.log(`    RSS: found ${items.length} articles, ${results.filter(r => r.source === source.source).length} with financial keywords`);
          continue; // Skip section scraping if RSS worked
        }
      } catch (e) {
        console.log(`    RSS failed: ${e.message}, trying section page...`);
      }
    }

    // Fall back to section page scraping (uses universal scraper with fallback)
    if (source.sectionUrl) {
      try {
        const html = await fetchWithFallback(source.sectionUrl, 20000);
        if (html) {
          const items = parseHTMLSection(html, source.sectionUrl);
          for (const item of items.slice(0, 30)) {
            if (seenUrls.has(item.url)) continue;
            // For section pages, we need to fetch each article to check keywords
            // But to avoid too many requests, just add articles with promising titles
            if (hasFinancialKeywords(item.title)) {
              seenUrls.add(item.url);
              results.push({ ...item, source: source.source });
            }
          }
          console.log(`    Section: found ${items.length} links, ${results.filter(r => r.source === source.source).length} with financial titles`);
        }
      } catch (e) {
        console.log(`    Section scrape failed: ${e.message}`);
      }
    }

    await sleep(500);
  }

  console.log(`  Found ${results.length} trade press articles with financial keywords`);
  return results;
}

/**
 * Simple fetch without proxies - for RSS feeds and basic HTML
 * Includes timeout to prevent hanging
 */
async function fetchPageSimple(url, timeoutMs = 15000) {
  const https = require('https');
  const http = require('http');
  const protocol = url.startsWith('https') ? https : http;

  return new Promise((resolve) => {
    // Overall timeout
    const timeoutId = setTimeout(() => {
      resolve(null);
    }, timeoutMs);

    const req = protocol.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; BroadwayScorecard/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 10000
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        clearTimeout(timeoutId);
        fetchPageSimple(res.headers.location, timeoutMs - 5000).then(resolve);
        return;
      }
      if (res.statusCode !== 200) {
        clearTimeout(timeoutId);
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { clearTimeout(timeoutId); resolve(data); });
    });
    req.on('error', () => { clearTimeout(timeoutId); resolve(null); });
    req.on('timeout', () => { clearTimeout(timeoutId); req.destroy(); resolve(null); });
  });
}

/**
 * Fetch with universal scraper fallback (Bright Data → ScrapingBee → Playwright)
 * Used when simple fetch fails for section pages
 */
async function fetchWithFallback(url, timeoutMs = 30000) {
  // First try simple fetch
  const simple = await fetchPageSimple(url, 10000);
  if (simple) return simple;

  // Fall back to universal scraper if available
  if (universalScraper) {
    try {
      const result = await Promise.race([
        universalScraper.fetchPage(url),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeoutMs))
      ]);
      if (result && result.content) {
        return result.content;
      }
    } catch (e) {
      console.log(`    Universal scraper failed: ${e.message}`);
    }
  }

  return null;
}

/**
 * Scrape the text of a trade press article with fallback.
 * Uses trade-press-scraper module if available (GATHER_TRADE_FULL flag),
 * otherwise falls back to simple ScrapingBee fetch.
 *
 * @param {string} url - Article URL
 * @param {string} fallbackSnippet - Snippet to return if scraping fails
 * @returns {Promise<string>} Article text (no longer truncated when using enhanced scraper)
 */
async function scrapeArticle(url, fallbackSnippet) {
  // Use enhanced trade press scraper if available and flag is set
  if (GATHER_TRADE_FULL && tradePressScraper) {
    try {
      const result = await tradePressScraper.scrapeTradeArticle(url, {
        snippet: fallbackSnippet,
        skipAuth: false  // Use credentials if available
      });

      if (result.fullText && result.fullText.length > 200) {
        // Enhanced scraper returns more complete text - don't truncate
        return result.fullText;
      }

      // Fall through to legacy method if enhanced scraper didn't get enough text
      console.log(`  Enhanced scraper returned ${result.fullText?.length || 0} chars, trying legacy method`);
    } catch (e) {
      console.log(`  Enhanced trade scraper failed: ${e.message}, trying legacy method`);
    }
  }

  // Legacy method: Try ScrapingBee with JS rendering
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
// Sprint 4.5: SEC EDGAR Filing Gathering (Optional)
// ---------------------------------------------------------------------------

/**
 * Gather SEC Form D filings for Broadway shows (if module available).
 *
 * Feature-flagged: Only runs if SEC_EDGAR_ENABLED and --gather-sec flag is set.
 * Searches for theatrical LLCs and extracts capitalization data.
 *
 * @param {Object[]} shows - Shows from shows.json
 * @param {Object} commercial - commercial.json data (to skip shows with existing SEC data)
 * @returns {Promise<Object[]>} Array of { showSlug, capitalization, source, filingUrl, confidence }
 */
async function gatherSECFilings(shows, commercial) {
  // Feature flag check
  if (!SEC_EDGAR_ENABLED) {
    console.log('SEC EDGAR scraping is disabled (module not available)');
    return [];
  }

  if (!GATHER_SEC) {
    console.log('Skipping SEC gathering (--gather-sec flag not set)');
    return [];
  }

  console.log('Gathering SEC Form D filings for Broadway shows...');

  let secScraper;
  try {
    secScraper = require('./lib/sec-edgar-scraper');
  } catch (e) {
    console.error('  Failed to load sec-edgar-scraper:', e.message);
    return [];
  }

  // Check if module is available
  if (typeof secScraper.isAvailable === 'function' && !secScraper.isAvailable()) {
    console.log('  SEC EDGAR API is not available');
    return [];
  }

  const results = [];

  // Focus on shows without SEC-sourced capitalization
  const showsToSearch = (shows || []).filter(show => {
    const slug = show.slug || show.id;
    const existing = commercial?.shows?.[slug];
    // Skip if already has SEC-sourced capitalization
    return !existing?.capitalizationSource?.toLowerCase().includes('sec');
  });

  console.log(`  Searching ${showsToSearch.length} shows for SEC filings...`);

  for (const show of showsToSearch.slice(0, 20)) { // Limit to 20 shows per run
    const slug = show.slug || show.id;
    const title = show.title;

    try {
      // Use BROADWAY_LLC_PATTERNS to generate search terms
      const searchTerms = secScraper.BROADWAY_LLC_PATTERNS?.map(pattern =>
        pattern.replace('{show}', title)
      ) || [`${title} LLC`, `${title} Broadway LLC`];

      for (const term of searchTerms.slice(0, 3)) { // Limit to 3 patterns per show
        try {
          const filings = await secScraper.searchFormDFilings({ companyName: term });

          if (filings && filings.length > 0) {
            // Parse the most recent filing
            const latestFiling = filings[0];
            const parsed = await secScraper.parseFormDFiling(latestFiling.url || latestFiling.filingUrl);

            if (parsed?.totalOfferingAmount) {
              results.push({
                showSlug: slug,
                capitalization: parsed.totalOfferingAmount,
                source: `SEC Form D: ${parsed.companyName || term}`,
                filingUrl: latestFiling.url || latestFiling.filingUrl,
                filingDate: parsed.filingDate,
                confidence: 'high' // SEC data is always high confidence
              });

              console.log(`    Found: ${title} - $${(parsed.totalOfferingAmount / 1e6).toFixed(1)}M`);
              break; // Found a match, move to next show
            }
          }
        } catch (searchError) {
          // Non-fatal, continue to next search term
        }

        // Rate limiting
        await sleep(1000);
      }
    } catch (e) {
      console.error(`    Error searching for ${title}: ${e.message}`);
    }
  }

  console.log(`  Found ${results.length} SEC filings`);
  return results;
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
 * @param {Object[]} data.secFilings - SEC Form D filings (Sprint 4.5)
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

  // Section H: SEC EDGAR Filings (Sprint 4.7)
  if (data.secFilings && data.secFilings.length > 0) {
    sections.push('\n=== SECTION H: SEC EDGAR FORM D FILINGS (HIGHEST AUTHORITY) ===');
    sections.push('NOTE: SEC filings are official government documents. Use these values with HIGH confidence.');
    sections.push('');
    for (const filing of data.secFilings) {
      sections.push(`${filing.showSlug}:`);
      sections.push(`  Capitalization: $${(filing.capitalization / 1e6).toFixed(2)}M`);
      sections.push(`  Source: ${filing.source}`);
      sections.push(`  Filing URL: ${filing.filingUrl}`);
      if (filing.filingDate) {
        sections.push(`  Filing Date: ${filing.filingDate}`);
      }
      sections.push('---');
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

SPRINT 4 SEC PRIORITY RULES:
11. SEC Form D data is ALWAYS high confidence - it is an official government filing.
12. For capitalization amounts, source hierarchy (highest to lowest):
    - SEC Form D filings (totalOfferingAmount) - MOST authoritative
    - Trade press articles (Deadline, Variety, NYT) - reliable
    - Reddit Grosses Analysis estimates - use with caution
    - Single Reddit comments - low confidence only
13. If SEC data contradicts other sources, PREFER the SEC data and note the discrepancy.
14. When SEC Form D shows totalOfferingAmount, use it as capitalization with high confidence.

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

  // Sprint 4.12: Track Claude API usage
  claudeApiUsage.calls++;
  if (response.usage) {
    claudeApiUsage.inputTokens += response.usage.input_tokens || 0;
    claudeApiUsage.outputTokens += response.usage.output_tokens || 0;
    console.log(`  Claude API usage: ${response.usage.input_tokens} input, ${response.usage.output_tokens} output tokens`);
  }

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
 * - flagged confidence (Sprint 4.10) -> flagged with sources disagree reason
 * - Designation changes to/from Miracle/Nonprofit/Tour Stop -> skipped
 * - Designation upgrades (non-TBD to non-TBD) -> flagged
 * - TBD -> Windfall/Fizzle/Flop with high/medium -> applied
 * - productionType changes -> flagged
 *
 * @param {Object[]} proposedChanges - From Claude analysis (with validatedConfidence from Sprint 4.9)
 * @returns {{ applied: Object[], flagged: Object[], skipped: Object[] }}
 */
function filterByConfidence(proposedChanges) {
  const applied = [];
  const flagged = [];
  const skipped = [];

  const protectedDesignations = new Set(['Miracle', 'Nonprofit', 'Tour Stop']);

  for (const change of (proposedChanges || [])) {
    const { field, oldValue, newValue, confidence } = change;

    // Sprint 4.10: Use validatedConfidence if available (from source validation)
    const effectiveConfidence = change.validatedConfidence || confidence;

    // Low confidence -> always skip
    if (effectiveConfidence === 'low') {
      skipped.push({ ...change, skipReason: 'Low confidence' });
      continue;
    }

    // Sprint 4.10: Flagged confidence (sources disagree) -> flag for manual review
    if (effectiveConfidence === 'flagged') {
      flagged.push({
        ...change,
        flagReason: 'Sources disagree',
        validationDetails: change.validationNotes || 'Contradicting sources found'
      });
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

  // Applied changes table (Sprint 4.11: Enhanced with validation details)
  if (applied.length > 0) {
    body += `### Applied Changes (${applied.length})\n\n`;
    body += '| Show | Field | Old | New | Confidence | Validated | Supporting | Contradicting |\n';
    body += '|------|-------|-----|-----|------------|-----------|------------|---------------|\n';
    for (const c of applied) {
      const old = JSON.stringify(c.oldValue) || 'null';
      const val = JSON.stringify(c.newValue) || 'null';
      const validated = c.validatedConfidence || c.confidence;
      const supporting = c.supportingSourcesCount != null ? c.supportingSourcesCount : '-';
      const contradicting = c.contradictingSourcesCount != null ? c.contradictingSourcesCount : '-';
      body += `| ${c.slug} | ${c.field} | ${old} | ${val} | ${c.confidence} | ${validated} | ${supporting} | ${contradicting} |\n`;
    }
    body += '\n';

    // Add validation notes if any changes had them
    const changesWithNotes = applied.filter(c => c.validationNotes && c.validationNotes !== 'No corroborating sources found');
    if (changesWithNotes.length > 0) {
      body += '<details><summary>Validation Notes</summary>\n\n';
      for (const c of changesWithNotes) {
        body += `- **${c.slug}.${c.field}**: ${c.validationNotes}\n`;
      }
      body += '\n</details>\n\n';
    }
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

  // Flagged changes (Sprint 4.11: Enhanced with validation details)
  if (flagged.length > 0) {
    body += `### Flagged for Manual Review (${flagged.length})\n\n`;
    body += '| Show | Field | Old | New | Reason | Supporting | Contradicting |\n';
    body += '|------|-------|-----|-----|--------|------------|---------------|\n';
    for (const c of flagged) {
      const supporting = c.supportingSourcesCount != null ? c.supportingSourcesCount : '-';
      const contradicting = c.contradictingSourcesCount != null ? c.contradictingSourcesCount : '-';
      body += `| ${c.slug} | ${c.field} | ${JSON.stringify(c.oldValue)} | ${JSON.stringify(c.newValue)} | ${c.flagReason || ''} | ${supporting} | ${contradicting} |\n`;
    }
    body += '\n';

    // Add validation details for source disagreements
    const sourceDisagreements = flagged.filter(c => c.flagReason === 'Sources disagree' && c.validationDetails);
    if (sourceDisagreements.length > 0) {
      body += '#### Source Disagreement Details\n\n';
      for (const c of sourceDisagreements) {
        body += `- **${c.slug}.${c.field}**: ${c.validationDetails}\n`;
      }
      body += '\n';
    }
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
// Sprint 4.9: Source Validation Helper
// ---------------------------------------------------------------------------

/**
 * Build an array of sources for validation from gathered data.
 * Converts Reddit posts, trade articles, and parsed data into the format
 * expected by source-validator.
 *
 * @param {Object} gathered - Gathered data object
 * @returns {Object[]} Array of source objects for validation
 */
function buildValidationSources(gathered) {
  const sources = [];

  // Add Grosses Analysis post parsed data
  if (gathered.grossesPostParsed && gathered.grossesPostParsed.length > 0) {
    for (const show of gathered.grossesPostParsed) {
      if (!show.matchedSlug) continue;

      // Add each field as a separate source entry
      if (show.estimatedWeeklyCost) {
        sources.push({
          showSlug: show.matchedSlug,
          field: 'weeklyRunningCost',
          value: show.estimatedWeeklyCost,
          sourceType: 'Reddit Grosses Analysis',
          url: gathered.grossesPost?.permalink ? `https://www.reddit.com${gathered.grossesPost.permalink}` : null
        });
      }

      if (show.estimatedRecoupmentPct) {
        sources.push({
          showSlug: show.matchedSlug,
          field: 'estimatedRecoupmentPct',
          value: show.estimatedRecoupmentPct,
          sourceType: 'Reddit Grosses Analysis',
          url: gathered.grossesPost?.permalink ? `https://www.reddit.com${gathered.grossesPost.permalink}` : null
        });
      }
    }
  }

  // Add Reddit financial thread mentions (lower confidence)
  if (gathered.redditFinancial && gathered.redditFinancial.length > 0) {
    for (const post of gathered.redditFinancial) {
      // Parse the post content for financial mentions
      // These would need NLP/regex parsing - for now just track as general sources
      sources.push({
        showSlug: null, // Unknown - would need parsing
        field: null,
        value: null,
        sourceType: 'Reddit comment',
        url: post.url,
        rawText: post.selftext
      });
    }
  }

  // Add trade press articles (higher confidence)
  if (gathered.tradeArticles && gathered.tradeArticles.length > 0) {
    for (const article of gathered.tradeArticles) {
      sources.push({
        showSlug: null, // Would need parsing to extract show
        field: null,
        value: null,
        sourceType: article.source, // e.g., 'Deadline', 'Variety'
        url: article.url,
        rawText: article.text || article.snippet
      });
    }
  }

  // Add SEC filings (highest confidence - Sprint 4.5)
  if (gathered.secFilings && gathered.secFilings.length > 0) {
    for (const filing of gathered.secFilings) {
      sources.push({
        showSlug: filing.showSlug,
        field: 'capitalization',
        value: filing.capitalization,
        sourceType: 'SEC Form D',
        url: filing.filingUrl
      });
    }
  }

  return sources;
}

/**
 * Validate proposed changes using source-validator module.
 * Returns changes with validatedConfidence added.
 *
 * @param {Object[]} proposedChanges - Changes from Claude analysis
 * @param {Object[]} allSources - Sources for validation
 * @returns {Object[]} Validated changes with validatedConfidence
 */
function validateProposedChanges(proposedChanges, allSources) {
  if (!sourceValidator || SKIP_VALIDATION) {
    console.log('  Skipping validation (module not available or --skip-validation flag)');
    return proposedChanges.map(c => ({ ...c, validatedConfidence: c.confidence }));
  }

  console.log('  Validating proposed changes against gathered sources...');

  const validated = [];
  for (const change of proposedChanges) {
    // Adapt change format for validator
    const changeForValidator = {
      showSlug: change.slug,
      field: change.field,
      newValue: change.newValue,
      oldValue: change.oldValue,
      confidence: change.confidence,
      sourceType: extractSourceType(change.source),
      sourceUrl: extractSourceUrl(change.source)
    };

    const result = sourceValidator.validateChange(changeForValidator, allSources);

    validated.push({
      ...change,
      validatedConfidence: result.validatedConfidence,
      supportingSourcesCount: result.supportingSources?.length || 0,
      contradictingSourcesCount: result.contradictingSources?.length || 0,
      validationNotes: result.validationNotes
    });

    // Log if confidence was adjusted
    if (result.validatedConfidence !== change.confidence) {
      console.log(`    ${change.slug}.${change.field}: ${change.confidence} -> ${result.validatedConfidence}`);
    }
  }

  return validated;
}

/**
 * Extract source type from Claude's source string.
 * @param {string} source - Source citation from Claude
 * @returns {string} Source type for validator
 */
function extractSourceType(source) {
  if (!source) return 'unknown';
  const sourceLower = source.toLowerCase();

  if (sourceLower.includes('sec') || sourceLower.includes('form d')) return 'SEC Form D';
  if (sourceLower.includes('deadline')) return 'Deadline';
  if (sourceLower.includes('variety')) return 'Variety';
  if (sourceLower.includes('nyt') || sourceLower.includes('new york times')) return 'New York Times';
  if (sourceLower.includes('broadway journal')) return 'Broadway Journal';
  if (sourceLower.includes('playbill')) return 'Playbill';
  if (sourceLower.includes('grosses analysis')) return 'Reddit Grosses Analysis';
  if (sourceLower.includes('reddit')) return 'Reddit comment';

  return 'estimate';
}

/**
 * Extract URL from Claude's source string if present.
 * @param {string} source - Source citation from Claude
 * @returns {string|null} URL or null
 */
function extractSourceUrl(source) {
  if (!source) return null;
  const urlMatch = source.match(/https?:\/\/[^\s]+/);
  return urlMatch ? urlMatch[0] : null;
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
    tradeArticles: [],
    secFilings: []  // Sprint 4.5: SEC Form D filings
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
  // Step 4.5: Gather SEC filings (Sprint 4.5 - optional)
  // -----------------------------------------------------------------------
  if (!isTimedOut() && GATHER_SEC) {
    try {
      gathered.secFilings = await gatherSECFilings(allShows, commercial);
    } catch (e) {
      console.error(`SEC filing search failed: ${e.message}`);
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
  // Step 7.5 (Sprint 4.9): Source validation pipeline
  // -----------------------------------------------------------------------
  console.log('\nRunning source validation...');
  const validationSources = buildValidationSources(gathered);
  console.log(`  Built ${validationSources.length} validation sources from gathered data`);

  const validatedChanges = validateProposedChanges(
    analysisResult.proposedChanges || [],
    validationSources
  );

  // Replace proposed changes with validated versions
  analysisResult.proposedChanges = validatedChanges;

  // -----------------------------------------------------------------------
  // Step 8: Filter by confidence (now uses validatedConfidence)
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
  console.log(`SEC Form D filings: ${gathered.secFilings.length}`);
  console.log(`Changes applied: ${applied.length}`);
  console.log(`Changes flagged: ${flagged.length}`);
  console.log(`Changes skipped: ${skipped.length}`);
  console.log(`Shadow disagreements: ${disagreements.length}`);

  // Sprint 4.12: Display Claude API usage summary
  if (claudeApiUsage.calls > 0) {
    console.log('');
    console.log('=== Claude API Usage ===');
    console.log(`API Calls: ${claudeApiUsage.calls}`);
    console.log(`Input Tokens: ${claudeApiUsage.inputTokens.toLocaleString()}`);
    console.log(`Output Tokens: ${claudeApiUsage.outputTokens.toLocaleString()}`);
    console.log(`Total Tokens: ${(claudeApiUsage.inputTokens + claudeApiUsage.outputTokens).toLocaleString()}`);

    // Estimate cost (Claude Sonnet pricing as of Jan 2026: ~$3/MTok input, ~$15/MTok output)
    const inputCost = (claudeApiUsage.inputTokens / 1000000) * 3;
    const outputCost = (claudeApiUsage.outputTokens / 1000000) * 15;
    console.log(`Estimated Cost: $${(inputCost + outputCost).toFixed(4)}`);
  }

  if (DRY_RUN) console.log('\n(DRY RUN -- no files modified)');
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
