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
const { urlLooksLikeReview } = require('./review-guards');
const { cleanSearchTitle } = require('./title-normalization');

/**
 * Search endpoint configuration.
 * Each entry: outlet search URL template + how to extract result links.
 *
 * {TITLE} is replaced with URL-encoded show title.
 * {MARKET_KEYWORD} is replaced with market-specific keyword (broadway/london+theatre).
 * linkPattern extracts review URLs from the HTML response.
 * requiresJs: true means the search page needs JavaScript rendering.
 * market: limits which markets this endpoint is used for (omit for all markets).
 * fetchAndParse: optional async function(showTitle, market) → string[] of URLs.
 *   When present, bypasses the standard fetch+regex flow entirely.
 */
const SITE_SEARCH_ENDPOINTS = {
  // --- SSR (plain HTTP works) ---
  'nypost': {
    name: 'New York Post',
    url: 'https://nypost.com/search/{TITLE}+review/',
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
  // Daily Beast search is JS-rendered and times out on ScrapingBee (March 2026).
  // ID was also wrong (daily-beast vs dailybeast). Disabled until a working endpoint is found.
  // 'dailybeast': {
  //   name: 'The Daily Beast',
  //   url: 'https://www.thedailybeast.com/search/?q={TITLE}+{MARKET_KEYWORD}+review',
  //   domain: 'thedailybeast.com',
  //   linkPattern: /href="(https:\/\/www\.thedailybeast\.com\/[^"]*)/gi,
  //   requiresJs: true,
  // },

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

  // --- Vulture (JS-rendered section page, needs ScrapingBee) ---
  'vulture': {
    name: 'Vulture',
    domain: 'vulture.com',
    requiresJs: true,
    // Section page lists recent theater articles chronologically.
    // Review URLs contain /article/theater-review- or /article/review-.
    // urlLooksLikeReview filters to the polled show via URL title matching.
    fetchAndParse: async () => {
      const html = await fetchWithScrapingBee('https://www.vulture.com/theater/', 45000);
      // Extract article links — Vulture uses both protocol-relative and absolute URLs
      const pattern = /href="((?:https?:)?\/\/(?:www\.)?vulture\.com\/article\/[^"]+)"/gi;
      const urls = [];
      let m;
      while ((m = pattern.exec(html)) !== null) {
        let url = m[1];
        // Normalize protocol-relative URLs
        if (url.startsWith('//')) url = 'https:' + url;
        urls.push(url);
      }
      const unique = [...new Set(urls)];
      // Zero-links guard: detect structural changes early
      if (unique.length === 0) {
        console.warn('    Site search [Vulture]: WARNING — section page returned 0 links (possible structural change)');
      }
      // Filter to review articles — Vulture review URLs contain "theater-review" or "review"
      const reviewUrls = unique.filter(u => /theater-review|\/review-|\/article\/review/.test(u));
      return reviewUrls;
    },
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
  'times-uk': {
    name: 'The Times',
    domain: 'thetimes.com',
    requiresJs: false,
    market: 'west-end',
    // Algolia JSON API — direct POST, no JS/ScrapingBee needed
    fetchAndParse: async (showTitle) => {
      const body = JSON.stringify({
        query: `${showTitle} review theatre`,
        hitsPerPage: 10,
        attributesToRetrieve: ['url', 'headline'],
      });
      const data = await fetchJSON('https://PZGYBTWG3J-dsn.algolia.net/1/indexes/prod_articles/query', {
        method: 'POST',
        headers: {
          'x-algolia-api-key': '3835bd37d54757eda130c4055ca98c68',
          'x-algolia-application-id': 'PZGYBTWG3J',
          'Content-Type': 'application/json',
        },
        body,
      });
      const parsed = JSON.parse(data);
      return (parsed.hits || [])
        .filter(h => h.url && /^https:\/\/www\.thetimes\.com\//.test(h.url))
        .map(h => h.url);
    },
  },

  'guardian': {
    name: 'The Guardian',
    domain: 'theguardian.com',
    requiresJs: false,
    // Guardian Open Platform API — free JSON, no auth needed beyond 'test' key
    // Rate limit: 1 req/sec with 'test' key (fine for opening night use)
    fetchAndParse: async (showTitle) => {
      const q = encodeURIComponent(`${showTitle} review`);
      const url = `https://content.guardianapis.com/search?q=${q}&tag=stage/stage&api-key=test&page-size=20&order-by=relevance`;
      const data = await fetchSSR(url);
      const parsed = JSON.parse(data);
      return (parsed.response?.results || [])
        .filter(r => r.webUrl)
        .map(r => r.webUrl);
    },
  },

  'variety': {
    name: 'Variety',
    domain: 'variety.com',
    requiresJs: false,
    // Section page /legit/reviews/ returns all recent theater reviews.
    // urlLooksLikeReview filters to the polled show via URL title matching.
    fetchAndParse: async (showTitle) => {
      const html = await fetchSSR('https://variety.com/v/legit/reviews/');
      const pattern = /href="(https:\/\/variety\.com\/\d{4}\/legit\/reviews\/[^"]+)"/gi;
      const urls = [];
      let m;
      while ((m = pattern.exec(html)) !== null) {
        urls.push(m[1]);
      }
      const unique = [...new Set(urls)];
      // Zero-links guard: if no URLs found, the page structure may have changed
      if (unique.length === 0) {
        console.warn('    Site search [Variety]: WARNING — section page returned 0 links (possible JS-render change)');
      }
      return unique;
    },
  },

  'theatermania': {
    name: 'TheaterMania',
    domain: 'theatermania.com',
    requiresJs: false,
    // TheaterMania WordPress REST API — category 157 = Reviews (all theater reviews).
    // Uses date window (openingDate ±3 days) — intentionally wider than RSS (±2 days) because
    // the API returns few results and TM sometimes publishes previews reviews several days before opening.
    // Still uses urlLooksLikeReview() (no skipUrlFilter) to narrow the 6-day window to the right show.
    fetchAndParse: async (showTitle, market, openingDate) => {
      // Build date window: openingDate ±3 days
      let afterParam = '';
      let beforeParam = '';
      if (openingDate) {
        const opening = new Date(openingDate);
        const after = new Date(opening); after.setDate(after.getDate() - 3);
        const before = new Date(opening); before.setDate(before.getDate() + 3);
        afterParam = `&after=${after.toISOString()}`;
        beforeParam = `&before=${before.toISOString()}`;
      }
      const url = `https://www.theatermania.com/wp-json/wp/v2/news?categories=157&per_page=20&_fields=link,date${afterParam}${beforeParam}`;
      const data = await fetchSSR(url);
      const posts = JSON.parse(data);
      if (!Array.isArray(posts)) return [];
      return posts.map(p => p.link).filter(Boolean);
    },
  },
  'independent': {
    name: 'The Independent',
    domain: 'independent.co.uk',
    requiresJs: false,
    market: 'west-end',
    // No search endpoint — section page lists recent reviews (SSR HTML).
    // independent.co.uk 302s to the-independent.com; fetchSSR follows redirects.
    fetchAndParse: async (showTitle) => {
      const html = await fetchSSR('https://www.independent.co.uk/arts-entertainment/theatre-dance/reviews');
      const pattern = /href="((?:https:\/\/www\.(?:the-)?independent\.com)?\/arts-entertainment\/theatre-dance\/reviews\/[^"]+\.html)"/gi;
      const urls = [];
      let m;
      while ((m = pattern.exec(html)) !== null) {
        let url = m[1];
        // Normalize relative URLs to absolute
        if (url.startsWith('/')) url = 'https://www.independent.co.uk' + url;
        urls.push(url);
      }
      return [...new Set(urls)];
    },
  },
  'daily-mail': {
    name: 'Daily Mail',
    domain: 'dailymail.co.uk',
    requiresJs: false,
    // No working search endpoint — Google News sitemap has ~1000 recent articles
    // with <news:title> tags. Match show title against headlines.
    fetchAndParse: async (showTitle) => {
      const xml = await fetchSSR('https://www.dailymail.co.uk/google-news-sitemap1.xml');
      const urls = [];
      // Extract <url> blocks with <loc> and <news:title>
      const blocks = xml.match(/<url>[\s\S]*?<\/url>/g) || [];
      for (const block of blocks) {
        const loc = block.match(/<loc>([^<]+)<\/loc>/)?.[1];
        const title = block.match(/<news:title>([^<]+)<\/news:title>/)?.[1];
        if (loc && title) {
          // Match show title words against the headline
          const titleLower = title.toLowerCase();
          const showWords = showTitle.toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 2 && !['the', 'and', 'for'].includes(w));
          const matchCount = showWords.filter(w => titleLower.includes(w)).length;
          if (matchCount >= Math.ceil(showWords.length * 0.5) &&
              (titleLower.includes('review') || titleLower.includes('theatre') || titleLower.includes('west end'))) {
            urls.push(loc);
          }
        }
      }
      return urls;
    },
  },

  // --- West End outlets (JS-rendered) ---
  'thestage': {
    name: 'The Stage',
    url: 'https://www.thestage.co.uk/?s={TITLE}+review',
    domain: 'thestage.co.uk',
    linkPattern: /href="(https:\/\/www\.thestage\.co\.uk\/reviews\/[^"]*)"/gi,
    requiresJs: true,
    market: 'west-end',
  },
  'telegraph': {
    name: 'The Telegraph',
    url: 'https://www.telegraph.co.uk/search/?q={TITLE}+review+theatre',
    domain: 'telegraph.co.uk',
    linkPattern: /href="(https:\/\/www\.telegraph\.co\.uk\/theatre\/[^"]*)"/gi,
    requiresJs: true,
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
 * HTTP fetch with custom method/headers/body (for JSON APIs like Algolia)
 */
function fetchJSON(url, options = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOptions = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: options.method || 'GET',
      headers: options.headers || {},
    };
    const req = https.request(reqOptions, (res) => {
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
    if (options.body) req.write(options.body);
    req.end();
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

// urlLooksLikeReview imported from ./review-guards (pure function, tested in test-opening-night-fixes.js)

/**
 * Search a single outlet's website for a review.
 *
 * @param {string} outletId - Outlet identifier
 * @param {string} showTitle - Show title to search for
 * @param {Object} options
 * @param {boolean} options.verbose - Log progress
 * @param {boolean} options.skipJs - Skip JS-rendered endpoints (save ScrapingBee credits)
 * @param {string} options.openingDate - Show's opening date (YYYY-MM-DD). Passed to
 *   fetchAndParse implementations that support date-window filtering (e.g. TheaterMania).
 * @returns {Promise<Array<{url, outletId, outlet, source}>>}
 */
async function searchOutletSite(outletId, showTitle, options = {}) {
  const { verbose = false, skipJs = false, market = 'broadway', openingDate = null } = options;
  const config = SITE_SEARCH_ENDPOINTS[outletId];
  if (!config) return [];
  // Clean title for search queries (strip suffixes, normalize quotes/ampersands)
  const searchTitle = cleanSearchTitle(showTitle);

  // Skip outlets limited to a different market
  if (config.market && config.market !== market) {
    return [];
  }

  if (config.requiresJs && skipJs) {
    if (verbose) console.log(`    Site search [${config.name}]: skipped (JS-rendered, skipJs=true)`);
    return [];
  }

  try {
    let results;

    // Custom fetch+parse path (e.g. Algolia JSON API, WP REST API, section page)
    if (config.fetchAndParse) {
      const urls = await config.fetchAndParse(searchTitle, market, openingDate);
      const seen = new Set();
      results = [];
      for (const url of urls) {
        if (seen.has(url)) continue;
        // skipUrlFilter: config already scoped results to reviews (e.g. Variety /legit/reviews/).
        // Applying urlLooksLikeReview() would reintroduce title-matching and drop valid URLs.
        if (!config.skipUrlFilter && !urlLooksLikeReview(url, showTitle)) continue;
        seen.add(url);
        results.push({ url, outletId, outlet: config.name, source: 'site-search' });
      }
    } else {
      // Standard fetch + regex path
      const marketKeyword = getMarketKeyword(market);
      const searchUrl = config.url
        .replace('{TITLE}', encodeURIComponent(searchTitle))
        .replace('{MARKET_KEYWORD}', marketKeyword);

      let html;
      if (config.requiresJs) {
        html = await fetchWithScrapingBee(searchUrl);
      } else {
        html = await fetchSSR(searchUrl);
      }

      results = [];
      const seen = new Set();
      let match;
      config.linkPattern.lastIndex = 0;
      while ((match = config.linkPattern.exec(html)) !== null) {
        const url = match[1];
        if (!seen.has(url) && urlLooksLikeReview(url, showTitle)) {
          seen.add(url);
          results.push({ url, outletId, outlet: config.name, source: 'site-search' });
        }
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
  const { knownUrls = new Set(), verbose = false, skipJs = false, market = 'broadway', openingDate = null } = options;
  const results = [];

  for (const outletId of outletIds) {
    if (!SITE_SEARCH_ENDPOINTS[outletId]) continue;

    const found = await searchOutletSite(outletId, showTitle, { verbose, skipJs, market, openingDate });
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
