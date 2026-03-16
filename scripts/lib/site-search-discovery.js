/**
 * Direct Site Search Discovery for Opening Night Poller
 *
 * Searches outlet websites directly for reviews using their search endpoints.
 * Unlike SERP (Google), outlet search updates instantly when they publish.
 *
 * Two tiers of search:
 * - SSR endpoints (plain HTTP fetch, no JS needed): NY Post, The Wrap, Observer, etc.
 * - JS-rendered endpoints (need ScrapingBee with render_js): THR, Deadline, Timeout, etc.
 *
 * Falls back gracefully — if a search endpoint fails, that outlet gets
 * picked up by SERP in the next layer.
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const { isLondonMarket } = require('./venue-classification');

/**
 * Search endpoint configuration.
 * Each entry: outlet search URL template + how to extract result links.
 *
 * {TITLE} is replaced with URL-encoded show title.
 * {MARKET_KEYWORD} is replaced with market-specific keyword (broadway/london+theatre).
 * linkPattern extracts review URLs from the HTML response.
 * requiresJs: true means the search page needs JavaScript rendering.
 * market: limits which markets this endpoint is used for (omit for all markets).
 */
const SITE_SEARCH_ENDPOINTS = {
  // --- SSR (plain HTTP works) ---
  'nypost': {
    name: 'New York Post',
    url: 'https://nypost.com/?s={TITLE}+review',
    domain: 'nypost.com',
    linkPattern: /href="(https:\/\/nypost\.com\/\d{4}\/\d{2}\/\d{2}\/[^"]*review[^"]*)"/gi,
    requiresJs: false,
    market: 'broadway',
  },
  'thewrap': {
    name: 'The Wrap',
    url: 'https://www.thewrap.com/?s={TITLE}+review',
    domain: 'thewrap.com',
    linkPattern: /href="(https:\/\/www\.thewrap\.com\/[^"]*review[^"]*)"/gi,
    requiresJs: false,
    market: 'broadway',
  },
  'observer': {
    name: 'Observer',
    url: 'https://observer.com/?s={TITLE}+review',
    domain: 'observer.com',
    linkPattern: /href="(https:\/\/observer\.com\/\d{4}\/\d{2}\/[^"]*review[^"]*)"/gi,
    requiresJs: false,
    market: 'broadway',
  },
  'daily-beast': {
    name: 'The Daily Beast',
    url: 'https://www.thedailybeast.com/search?q={TITLE}+{MARKET_KEYWORD}+review',
    domain: 'thedailybeast.com',
    linkPattern: /href="(https:\/\/www\.thedailybeast\.com\/[^"]*)/gi,
    requiresJs: false,
  },

  // --- JS-Rendered (need ScrapingBee with render_js) ---
  'hollywood-reporter': {
    name: 'The Hollywood Reporter',
    url: 'https://www.hollywoodreporter.com/?s={TITLE}+review',
    domain: 'hollywoodreporter.com',
    linkPattern: /href="(https:\/\/www\.hollywoodreporter\.com\/[^"]*review[^"]*)"/gi,
    requiresJs: true,
  },
  'deadline': {
    name: 'Deadline',
    url: 'https://deadline.com/?s={TITLE}+review',
    domain: 'deadline.com',
    linkPattern: /href="(https:\/\/deadline\.com\/\d{4}\/\d{2}\/[^"]*)"/gi,
    requiresJs: true,
  },
  'timeout': {
    name: 'Time Out',
    url: 'https://www.timeout.com/search?q={TITLE}+{MARKET_KEYWORD}',
    domain: 'timeout.com',
    linkPattern: /href="(https:\/\/www\.timeout\.com\/[^"]*review[^"]*)"/gi,
    requiresJs: true,
  },
  'ew': {
    name: 'Entertainment Weekly',
    url: 'https://ew.com/search/?q={TITLE}+{MARKET_KEYWORD}+review',
    domain: 'ew.com',
    linkPattern: /href="(https:\/\/ew\.com\/[^"]*review[^"]*)"/gi,
    requiresJs: true,
  },

  // --- West End outlets (SSR) ---
  'whatsonstage': {
    name: 'WhatsOnStage',
    url: 'https://www.whatsonstage.com/?s={TITLE}+review',
    domain: 'whatsonstage.com',
    linkPattern: /href="(https:\/\/www\.whatsonstage\.com\/[^"]*review[^"]*)"/gi,
    requiresJs: false,
    market: 'west-end',
  },
};

const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

/**
 * Resolve {MARKET_KEYWORD} placeholder based on market.
 * BW shows search with "broadway", WE shows with "london theatre".
 */
function getMarketKeyword(market) {
  if (isLondonMarket(market)) return 'london+theatre';
  return 'broadway';
}

/**
 * Simple HTTP fetch (for SSR search pages)
 */
function fetchSSR(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchSSR(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Fetch with ScrapingBee (for JS-rendered search pages)
 */
function fetchWithScrapingBee(url, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_KEY) return reject(new Error('No ScrapingBee key'));
    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=true&wait=3000`;
    const req = https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else reject(new Error(`ScrapingBee HTTP ${res.statusCode}`));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Check if a URL looks like a review for the given show title.
 * Filters out tag pages, author pages, ticket links, etc.
 */
function urlLooksLikeReview(url, showTitle) {
  const lower = url.toLowerCase();
  // Reject non-article URLs
  if (lower.includes('/tag/') || lower.includes('/author/') || lower.includes('/category/')) return false;
  if (lower.includes('/search') || lower.includes('/page/')) return false;
  if (lower.includes('ticket') && !lower.includes('review')) return false;

  // Check if URL contains words from show title
  const titleWords = showTitle.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 2 && !['the', 'and', 'for'].includes(w));

  const matchCount = titleWords.filter(w => lower.includes(w)).length;
  return matchCount >= Math.ceil(titleWords.length * 0.5);
}

/**
 * Search a single outlet's website for a review.
 *
 * @param {string} outletId - Outlet identifier
 * @param {string} showTitle - Show title to search for
 * @param {Object} options
 * @param {boolean} options.verbose - Log progress
 * @param {boolean} options.skipJs - Skip JS-rendered endpoints (save ScrapingBee credits)
 * @returns {Promise<Array<{url, outletId, outlet, source}>>}
 */
async function searchOutletSite(outletId, showTitle, options = {}) {
  const { verbose = false, skipJs = false, market = 'broadway' } = options;
  const config = SITE_SEARCH_ENDPOINTS[outletId];
  if (!config) return [];

  // Skip outlets limited to a different market
  if (config.market && config.market !== market) {
    return [];
  }

  if (config.requiresJs && skipJs) {
    if (verbose) console.log(`    Site search [${config.name}]: skipped (JS-rendered, skipJs=true)`);
    return [];
  }

  const marketKeyword = getMarketKeyword(market);
  const searchUrl = config.url
    .replace('{TITLE}', encodeURIComponent(showTitle))
    .replace('{MARKET_KEYWORD}', marketKeyword);

  try {
    let html;
    if (config.requiresJs) {
      html = await fetchWithScrapingBee(searchUrl);
    } else {
      html = await fetchSSR(searchUrl);
    }

    // Extract matching URLs
    const results = [];
    const seen = new Set();
    let match;
    // Reset regex lastIndex
    config.linkPattern.lastIndex = 0;
    while ((match = config.linkPattern.exec(html)) !== null) {
      const url = match[1];
      if (!seen.has(url) && urlLooksLikeReview(url, showTitle)) {
        seen.add(url);
        results.push({
          url,
          outletId,
          outlet: config.name,
          source: 'site-search',
        });
      }
    }

    if (verbose) {
      console.log(`    Site search [${config.name}]: ${results.length} result(s)`);
    }
    return results;
  } catch (err) {
    if (verbose) {
      console.log(`    Site search [${config.name}]: ${err.message}`);
    }
    return []; // Non-fatal — SERP layer will catch this outlet
  }
}

/**
 * Search multiple outlet websites for reviews.
 *
 * @param {string} showTitle - Show title
 * @param {string[]} outletIds - Which outlets to search (only searches outlets in SITE_SEARCH_ENDPOINTS)
 * @param {Object} options
 * @param {Set} options.knownUrls - Already-discovered URLs to skip
 * @param {boolean} options.verbose - Log progress
 * @param {boolean} options.skipJs - Skip JS-rendered endpoints
 * @returns {Promise<Array<{url, outletId, outlet, source}>>}
 */
async function searchOutletSites(showTitle, outletIds, options = {}) {
  const { knownUrls = new Set(), verbose = false, skipJs = false, market = 'broadway' } = options;
  const results = [];

  for (const outletId of outletIds) {
    if (!SITE_SEARCH_ENDPOINTS[outletId]) continue;

    const found = await searchOutletSite(outletId, showTitle, { verbose, skipJs, market });
    for (const result of found) {
      if (!knownUrls.has(result.url)) {
        results.push(result);
      }
    }
  }

  return results;
}

module.exports = {
  searchOutletSites,
  searchOutletSite,
  SITE_SEARCH_ENDPOINTS,
  urlLooksLikeReview,
};
