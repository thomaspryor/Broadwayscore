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
const { hasNonMetOperaUrlMarker, isUrlYearOutsideWindow } = require('./content-filters');

/**
 * Post-filter for opera-outlet fetchAndParse callbacks.
 * Applied centrally so adding outlets doesn't reinvent the same filtering.
 *
 *  - Rejects URLs matching known non-Met opera house slugs (reject-list, fails open)
 *  - Rejects URLs whose embedded year is outside the show's opening window
 *  - Emits a WARN log to surface silent zero-result returns (pre-mortem #1 scenario:
 *    a slug-format change → empty array → indistinguishable from "no review yet")
 *
 * @param {string[]} urls - Raw URL list from outlet's fetchAndParse
 * @param {string} outletId - Outlet identifier for logging
 * @param {string} showId - Show ID for logging
 * @param {string|null} openingDate - Show's opening date (year-window filter only fires when present)
 * @returns {string[]} Filtered URLs
 */
function filterOperaUrls(urls, outletId, showId, openingDate) {
  if (!Array.isArray(urls)) return [];
  const total = urls.length;
  const openingYear = openingDate ? new Date(openingDate).getFullYear() : null;

  const filtered = urls.filter(url => {
    if (hasNonMetOperaUrlMarker(url).rejected) return false;
    if (openingYear && isUrlYearOutsideWindow(url, openingYear, null)) return false;
    return true;
  });

  if (total > 0 && filtered.length === 0) {
    console.warn(`    [opera-discovery] WARN: ${outletId} returned ${total} URLs but ALL were filtered out for ${showId || '(unknown show)'} — possible slug drift, year-filter mismatch, or genuine no-coverage`);
  }
  return filtered;
}

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

  // ── Opera outlets (applies only when show.type === 'opera') ──────────────────
  // All five fire exclusively for opera shows. Broadway/West End shows should
  // never hit these; the applies() gate at the call site enforces this.
  //
  // Each opera outlet's fetchAndParse receives (showTitle, market, openingDate)
  // and pipes its URL list through filterOperaUrls() below — applies:
  //  (a) hasNonMetOperaUrlMarker reject-list (Sydney/Paris/Royal/etc.)
  //  (b) isUrlYearOutsideWindow when openingDate is present
  //  (c) WARN log if everything got rejected (silent zero-results = #1 pre-mortem
  //      catastrophe scenario)

  'bachtrack': {
    name: 'Bachtrack',
    domain: 'bachtrack.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // Bachtrack opera category page — lists the ~40 most recent opera reviews.
    // URL slugs contain opera/venue/city keywords, so urlLooksLikeReview()
    // title-matches correctly against them.
    // NOTE: paywall — rating is in <div class='article-rating-simple star-rating'>
    // encoded as &#x2a; (asterisk, filled star) and &#x31; (digit 1, empty star).
    // e.g. ****1 = 4/5 stars. Author is in div.article-author, not the meta tag
    // (meta tag may show a performer name, not the critic).
    fetchAndParse: async (showTitle, market, openingDate, showId) => {
      const html = await fetchSSR('https://bachtrack.com/find-reviews/category=2');
      const urls = [];
      const pattern = /href="(\/review-[^"]+)"/gi;
      let m;
      while ((m = pattern.exec(html)) !== null) {
        urls.push('https://bachtrack.com' + m[1]);
      }
      const unique = [...new Set(urls)];
      if (unique.length === 0) {
        console.warn('    Site search [Bachtrack]: WARNING — opera category page returned 0 links (possible structural change)');
      }
      return filterOperaUrls(unique, 'bachtrack', showId, openingDate);
    },
  },

  'parterre-box': {
    name: 'Parterre Box',
    domain: 'parterre.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // Parterre uses WP REST API (no auth needed). Two-step query:
    //  1. Resolve "performances" category ID at runtime (NOT hardcoded — caught
    //     in pre-mortem secondary scenario as a silent-break-on-WP-migration risk)
    //  2. Fetch posts in opening±2/+14 day window AND in performances category
    //  3. Title-validate against show title (WP returns title.rendered for free
    //     in the same response, no second fetch needed)
    //
    // Parterre publishes ~2/day; without category + title filter, a 16-day window
    // returns 25-43 unrelated daily art-song posts that all flow downstream as
    // wrong-production stubs.
    fetchAndParse: async (showTitle, market, openingDate, showId) => {
      // Fail closed without openingDate
      if (!openingDate) return [];

      // 1. Resolve "performances" category ID at runtime.
      let perfCategoryId = null;
      try {
        const catUrl = 'https://parterre.com/wp-json/wp/v2/categories?slug=performances&_fields=id,slug';
        const catData = await fetchSSR(catUrl);
        const cats = JSON.parse(catData);
        if (Array.isArray(cats) && cats.length > 0) perfCategoryId = cats[0].id;
      } catch (e) {
        console.warn(`    [opera-discovery] WARN: parterre-box category lookup failed: ${e.message} — falling back to no category filter`);
      }
      if (!perfCategoryId) {
        console.warn(`    [opera-discovery] WARN: parterre-box "performances" category slug not found — falling back to no category filter`);
      }

      // 2. Fetch posts in date window + (optional) performances category
      const opening = new Date(openingDate);
      const after = new Date(opening); after.setDate(after.getDate() - 2);
      const before = new Date(opening); before.setDate(before.getDate() + 14);
      const afterParam = `&after=${after.toISOString()}`;
      const beforeParam = `&before=${before.toISOString()}`;
      const catParam = perfCategoryId ? `&categories=${perfCategoryId}` : '';
      const url = `https://parterre.com/wp-json/wp/v2/posts?per_page=100&_fields=link,date,title${afterParam}${beforeParam}${catParam}`;
      const data = await fetchSSR(url);
      const posts = JSON.parse(data);
      if (!Array.isArray(posts)) return [];

      // 3. Title-validate: keep posts whose title shares ≥2 words with show title.
      // Parterre's slugs are poetic but their titles ARE descriptive.
      const showWords = showTitle.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !['the','and','for','with','from'].includes(w));
      const matches = posts.filter(p => {
        const title = (p.title?.rendered || '').toLowerCase().replace(/<[^>]+>/g, '');
        if (!title) return false;
        const matchCount = showWords.filter(w => title.includes(w)).length;
        return matchCount >= Math.min(2, showWords.length);
      });

      const urls = matches.map(p => p.link).filter(Boolean);
      return filterOperaUrls(urls, 'parterre-box', showId, openingDate);
    },
  },

  'operawire': {
    name: 'Operawire',
    domain: 'operawire.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // Operawire WP REST API — search by show title. Review URLs reliably contain
    // the show name in the slug (e.g. /metropolitan-opera-2025-26-review-{title}/).
    // The reject-list in filterOperaUrls drops opera-australia/sydney/royal-opera
    // mis-hits before they become wrong-production stubs.
    fetchAndParse: async (showTitle, market, openingDate, showId) => {
      const q = encodeURIComponent(showTitle);
      const url = `https://operawire.com/wp-json/wp/v2/posts?search=${q}&per_page=10&_fields=link,title,date`;
      const data = await fetchSSR(url);
      const posts = JSON.parse(data);
      if (!Array.isArray(posts)) return [];
      const urls = posts.map(p => p.link).filter(Boolean);
      return filterOperaUrls(urls, 'operawire', showId, openingDate);
    },
  },

  'new-york-classical-review': {
    name: 'New York Classical Review',
    domain: 'newyorkclassicalreview.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // NYCR WP REST API — search by show title. NYCR uses WordPress with the
    // el-clasico theme; REST API is enabled and unauthenticated. URL pattern
    // is YYYY/MM/slug, so isUrlYearOutsideWindow filters historical productions
    // (NYCR returns the 2022 Eugene Onegin for a 2026 search; year filter drops it).
    fetchAndParse: async (showTitle, market, openingDate, showId) => {
      const q = encodeURIComponent(showTitle);
      const url = `https://newyorkclassicalreview.com/wp-json/wp/v2/posts?search=${q}&per_page=10&_fields=link,title,date`;
      const data = await fetchSSR(url);
      const posts = JSON.parse(data);
      if (!Array.isArray(posts)) return [];
      const urls = posts.map(p => p.link).filter(Boolean);
      return filterOperaUrls(urls, 'new-york-classical-review', showId, openingDate);
    },
  },

  'classical-voice-america': {
    name: 'Classical Voice America',
    domain: 'classicalvoiceamerica.org',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // CVA WP REST API is blocked (Solid Security). Fallback: HTML search page.
    // URL pattern is YYYY/MM/DD/slug. Year-window filter drops historical
    // productions returned by the search results.
    fetchAndParse: async (showTitle, market, openingDate, showId) => {
      const q = encodeURIComponent(`${showTitle} opera`);
      const html = await fetchSSR(`https://classicalvoiceamerica.org/?s=${q}`);
      const urls = [];
      const pattern = /href="(https:\/\/classicalvoiceamerica\.org\/\d{4}\/\d{2}\/\d{2}\/[^"]+)"/gi;
      let m;
      while ((m = pattern.exec(html)) !== null) {
        urls.push(m[1]);
      }
      const unique = [...new Set(urls)];
      return filterOperaUrls(unique, 'classical-voice-america', showId, openingDate);
    },
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
 * @param {Object} [options.show] - Full show object for applies() predicate evaluation.
 *   Opera outlets (bachtrack, parterre-box, operawire, nycr, cva) use
 *   applies: (show) => show.type === 'opera' — they must be gated or they fire
 *   on every non-opera show and burn HTTP/ScrapingBee budget needlessly.
 * @returns {Promise<Array<{url, outletId, outlet, source}>>}
 */
async function searchOutletSite(outletId, showTitle, options = {}) {
  const { verbose = false, skipJs = false, market = 'broadway', openingDate = null, show = null } = options;
  const config = SITE_SEARCH_ENDPOINTS[outletId];
  if (!config) return [];
  // Clean title for search queries (strip suffixes, normalize quotes/ampersands)
  const searchTitle = cleanSearchTitle(showTitle);

  // Skip outlets limited to a different market
  if (config.market && config.market !== market) {
    return [];
  }

  // Skip outlets that don't apply to this show type (e.g. opera-only outlets for non-opera shows).
  // Fail CLOSED: if config has applies() but caller didn't pass `show`, treat as not-applicable.
  // Otherwise opera outlets would silently fire on every Broadway show whenever a future caller
  // omits the show argument.
  if (config.applies && (!show || !config.applies(show))) {
    if (verbose) console.log(`    Site search [${config.name}]: skipped (applies() gate — show=${show ? `type=${show.type}` : 'null'})`);
    return [];
  }

  if (config.requiresJs && skipJs) {
    if (verbose) console.log(`    Site search [${config.name}]: skipped (JS-rendered, skipJs=true)`);
    return [];
  }

  try {
    let results;

    // Custom fetch+parse path (e.g. Algolia JSON API, WP REST API, section page).
    // 4th arg (showId) used by opera outlets for WARN log context — see filterOperaUrls.
    if (config.fetchAndParse) {
      const showId = (show && show.id) || null;
      const urls = await config.fetchAndParse(searchTitle, market, openingDate, showId);
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
 * @param {Object} [options.show] - Full show object; passed to applies() predicates on
 *   outlet configs. Opera outlets use applies: (show) => show.type === 'opera'.
 * @returns {Promise<Array<{url, outletId, outlet, source}>>}
 */
async function searchOutletSites(showTitle, outletIds, options = {}) {
  const { knownUrls = new Set(), verbose = false, skipJs = false, market = 'broadway', openingDate = null, show = null } = options;
  const results = [];

  for (const outletId of outletIds) {
    if (!SITE_SEARCH_ENDPOINTS[outletId]) continue;

    const found = await searchOutletSite(outletId, showTitle, { verbose, skipJs, market, openingDate, show });
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
