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
const { withOperaCache } = require('./opera-discovery-cache');

// Helper: parse JSON response, returning empty array if the body is HTML
// (Cloudflare fallback can return HTML even after fetchSSR's challenge detection
// if BD/SB returned a different challenge variant). Logs once for visibility.
function _safeJsonArray(body, outletId) {
  if (typeof body !== 'string') return [];
  const trimmed = body.trim();
  if (!trimmed.startsWith('[') && !trimmed.startsWith('{')) {
    console.warn(`    [opera-discovery] WARN: ${outletId} response was not JSON (got HTML, likely a residual Cloudflare/error page) — returning []`);
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.warn(`    [opera-discovery] WARN: ${outletId} JSON.parse failed: ${e.message.slice(0, 80)} — returning []`);
    return [];
  }
}

/**
 * Post-filter for opera-outlet fetchAndParse callbacks.
 * Applied centrally so adding outlets doesn't reinvent the same filtering.
 *
 *  - Rejects URLs matching known non-Met opera house slugs (reject-list, fails open)
 *  - Rejects URLs whose embedded year is outside ±1 year of opening (tighter than
 *    the shared isUrlYearOutsideWindow helper — opera revivals run every 3-5 years
 *    and 2023's La Traviata is a different production from 2026's, even though the
 *    shared helper would accept it within its openingYear-3 window)
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

  // Stopgap day-window gate. Sprint 3 will add a per-endpoint
  // daysSinceOpening<21 gate plus a 24h filesystem cache; in the meantime
  // this prevents the new opera endpoints from re-walking listing pages for
  // shows that opened months ago and won't get further reviews. Bounded at
  // 30 (slightly looser than Sprint 3's 21) so this stopgap doesn't have to
  // be removed when Sprint 3 lands — the tighter gate will fire first.
  if (openingDate) {
    const daysSince = Math.floor((Date.now() - new Date(openingDate).getTime()) / 86400000);
    // 21-day window per the Opera V2 plan. Met opera reviews typically land
    // within 14 days of opening; tail at 21 picks up late critics without
    // walking archives forever. Sprint 2.1 shipped a temporary 30-day
    // stopgap before the cache existed; now tightened to plan threshold.
    if (daysSince > 21) return [];
  }

  const total = urls.length;
  const openingYear = openingDate ? new Date(openingDate).getFullYear() : null;

  const filtered = urls.filter(url => {
    if (hasNonMetOperaUrlMarker(url).rejected) return false;
    // Tight ±1-year window for opera (vs the shared helper's ±3 year window).
    // Opera revivals are different productions worth disambiguating.
    if (openingYear) {
      const m = url.match(/\/((?:19|20)\d{2})\b/);
      if (m) {
        const urlYear = parseInt(m[1], 10);
        if (Math.abs(urlYear - openingYear) > 1) return false;
      }
    }
    return true;
  });

  if (total > 0 && filtered.length === 0) {
    console.warn(`    [opera-discovery] WARN: ${outletId} returned ${total} URLs but ALL were filtered out for ${showId || '(unknown show)'} — possible slug drift, year-filter mismatch, or genuine no-coverage`);
  }
  return filtered;
}

/**
 * Opera title normalization: strip multilingual conjunctions ("und", "et", "y",
 * "e", "and") that appear in opera titles ("Tristan und Isolde", "Romeo et Juliette",
 * "Caballeria Rusticana e Pagliacci"). Slug forms typically omit these, so keeping
 * them in title-match logic causes false rejections (Tristan und Isolde → slug
 * tristan-isolde fails standard 50%-overlap match).
 *
 * Returns a list of meaningful title words (lowercase, ≥3 chars, no conjunctions).
 */
function operaTitleWords(title) {
  if (!title) return [];
  const stop = new Set(['the','and','und','et','y','le','la','les','el','un','una','di','da','du','dei','der','die','das','of','for','to','at','in','on','with','from']);
  // NFD-normalize + strip diacritics BEFORE the char filter. Without this,
  // "Último Sueño" tokenizes to ["ltimo","sue"] (fragments left after \w
  // drops accented letters) instead of ["ultimo","sueno"]. Met productions
  // routinely carry French/Italian/Spanish/German titles with accents.
  return title
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 3 && !stop.has(w));
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
      // show-tags=tone returns each result's tone tags so we can keep ONLY actual
      // reviews. The `{title} review` query otherwise also returns features,
      // interviews, and making-of pieces — the Guardian Jun-2 "show-reinvention"
      // feature for Girl, Interrupted was scored 76 as a review before this filter
      // (girl-interrupted 2026-06-05). Allowlisting tone/reviews drops them at the
      // source (the codebase's positive-signal pattern, cf. Variety /legit/reviews/).
      // Wrong-SHOW reviews (a real review of a different show) still pass here — that
      // is the date/title guard's job (getWrongProductionReasonFromUrl), not this.
      const url = `https://content.guardianapis.com/search?q=${q}&tag=stage/stage&show-tags=tone&api-key=test&page-size=20&order-by=relevance`;
      const data = await fetchSSR(url);
      const parsed = JSON.parse(data);
      return (parsed.response?.results || [])
        .filter(r => r.webUrl)
        .filter(r => (r.tags || []).some(t => t.id === 'tone/reviews'))
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
    // skipUrlFilter so the dispatcher's default urlLooksLikeReview doesn't drop
    // Bachtrack URLs whose slugs omit opera-title conjunctions (e.g. "tristan-isolde"
    // vs "Tristan und Isolde"). filterOperaUrls + the per-outlet title-words check
    // below handle title matching with opera-aware tokenization.
    skipUrlFilter: true,
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
      // Opera-aware title match against URL slug (handles "Tristan und Isolde" → tristan-isolde)
      const titleWords = operaTitleWords(showTitle);
      const titleMatched = unique.filter(url => {
        const slug = (url.split('/review-')[1] || '').toLowerCase();
        if (!slug) return false;
        const hits = titleWords.filter(w => slug.includes(w)).length;
        return hits >= Math.min(2, titleWords.length);
      });
      return filterOperaUrls(titleMatched, 'bachtrack', showId, openingDate);
    },
  },

  'parterre-box': {
    name: 'Parterre Box',
    domain: 'parterre.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // skipUrlFilter: Parterre uses POETIC slugs ("a-specter-haunting") that the
    // dispatcher's urlLooksLikeReview() title-matcher would reject. Title/slug
    // validation happens INSIDE fetchAndParse below using show-aware logic.
    skipUrlFilter: true,
    // Parterre uses WP REST API (no auth needed). Three-step query:
    //  1. Resolve "performance-reviews" category ID at runtime (NOT hardcoded —
    //     caught in pre-mortem secondary scenario as silent-break-on-WP-migration risk)
    //  2. Fetch posts in opening±2/+14 day window AND in performance-reviews category
    //  3. Best-effort title/slug match; fall back to all category+date posts since
    //     Parterre's slugs are poetic ("a-specter-haunting" for Innocence)
    //
    // Parterre publishes ~weekly performance reviews; with category filter, a
    // 16-day window yields ~5-10 posts (vs 25-43 with date-only).
    fetchAndParse: async (showTitle, market, openingDate, showId) => {
      // Fail closed without openingDate
      if (!openingDate) return [];

      // 1. Resolve "performance-reviews" category ID at runtime.
      // Verified slug 2026-04-28 via /wp-json/wp/v2/categories listing — Parterre
      // uses 'performance-reviews' (id=4681), NOT 'performances'. Don't hardcode
      // the ID — Parterre could re-id on a WP migration (pre-mortem secondary scenario).
      let perfCategoryId = null;
      try {
        const catUrl = 'https://parterre.com/wp-json/wp/v2/categories?slug=performance-reviews&_fields=id,slug';
        const catData = await fetchSSR(catUrl);
        const cats = _safeJsonArray(catData, 'parterre-box-category');
        if (cats.length > 0) perfCategoryId = cats[0].id;
      } catch (e) {
        console.warn(`    [opera-discovery] WARN: parterre-box category lookup failed: ${e.message} — falling back to no category filter`);
      }
      if (!perfCategoryId) {
        console.warn(`    [opera-discovery] WARN: parterre-box "performance-reviews" category slug not found — falling back to no category filter`);
      }

      // 2. Fetch posts in date window + (optional) performances category
      const opening = new Date(openingDate);
      const after = new Date(opening); after.setDate(after.getDate() - 2);
      const before = new Date(opening); before.setDate(before.getDate() + 14);
      const afterParam = `&after=${after.toISOString()}`;
      const beforeParam = `&before=${before.toISOString()}`;
      const catParam = perfCategoryId ? `&categories=${perfCategoryId}` : '';
      // Include excerpt so we can validate body content without a second fetch.
      const url = `https://parterre.com/wp-json/wp/v2/posts?per_page=100&_fields=link,date,title,excerpt${afterParam}${beforeParam}${catParam}`;
      const data = await fetchSSR(url);
      const posts = _safeJsonArray(data, 'parterre-box');
      if (posts.length === 0) return [];

      // 3. Match posts to show: title/slug/excerpt all checked. Parterre uses
      // POETIC titles ("A specter, haunting" for Innocence) but their excerpts
      // typically name the opera + composer + venue, so excerpt-search catches
      // posts that title/slug miss.
      const showWords = operaTitleWords(showTitle);
      const matches = posts.filter(p => {
        const title = (p.title?.rendered || '').toLowerCase().replace(/<[^>]+>/g, '');
        const slug = (p.link || '').toLowerCase();
        const excerpt = (p.excerpt?.rendered || '').toLowerCase().replace(/<[^>]+>/g, ' ');
        const text = title + ' ' + slug + ' ' + excerpt;
        const hits = showWords.filter(w => text.includes(w)).length;
        return hits >= Math.min(2, showWords.length);
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
      const posts = _safeJsonArray(data, 'operawire');
      // Operawire publishes BOTH announcements ("Asmik Grigorian Headline...") AND
      // actual reviews ("metropolitan-opera-2025-26-review-eugene-onegin"). The WP
      // search returns BOTH; without prioritization, the announcement gets picked
      // first as the "Operawire/Salazar" file and the actual review is lost.
      // Strategy: keep ONLY review URLs (slug contains 'review'). Announcement
      // URLs are not reviews; we don't want them.
      const reviewPosts = posts.filter(p => p.link && /\breview\b|-review-/i.test(p.link));
      const urls = (reviewPosts.length > 0 ? reviewPosts : posts).map(p => p.link).filter(Boolean);
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
      const posts = _safeJsonArray(data, 'new-york-classical-review');
      const urls = posts.map(p => p.link).filter(Boolean);
      return filterOperaUrls(urls, 'new-york-classical-review', showId, openingDate);
    },
  },

  'seen-and-heard-international': {
    name: 'Seen and Heard International',
    domain: 'seenandheard-international.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // Seen and Heard International — UK/international classical reviews. WP REST
    // is Cloudflare-protected (403 direct); fetchSSR's fallback handles it.
    // URL pattern: /YYYY/MM/slug/
    fetchAndParse: async (showTitle, market, openingDate, showId) => {
      const q = encodeURIComponent(showTitle);
      const url = `https://seenandheard-international.com/wp-json/wp/v2/posts?search=${q}&per_page=10&_fields=link,title,date`;
      const data = await fetchSSR(url);
      const posts = _safeJsonArray(data, 'seen-and-heard-international');
      const urls = posts.map(p => p.link).filter(Boolean);
      return filterOperaUrls(urls, 'seen-and-heard-international', showId, openingDate);
    },
  },

  'the-new-criterion': {
    name: 'The New Criterion',
    domain: 'newcriterion.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // The New Criterion — opera dispatch column. WP REST is unauthenticated.
    // URL pattern: /dispatch/{slug}/
    fetchAndParse: async (showTitle, market, openingDate, showId) => {
      const q = encodeURIComponent(showTitle);
      const url = `https://newcriterion.com/wp-json/wp/v2/posts?search=${q}&per_page=10&_fields=link,title,date`;
      const data = await fetchSSR(url);
      const posts = _safeJsonArray(data, 'the-new-criterion');
      const urls = posts.map(p => p.link).filter(Boolean);
      return filterOperaUrls(urls, 'the-new-criterion', showId, openingDate);
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

  'newyorker': {
    name: 'The New Yorker',
    domain: 'newyorker.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // The New Yorker contributor page (newyorker.com/contributors/alex-ross)
    // is lazy-loaded — SSR HTML returns 0 article anchors. The /tag/opera
    // listing returns only older (2022-2023) pieces. Use Alex Ross's personal
    // blog therestisnoise.com as the index — he reblogs each New Yorker
    // piece's URL on publication day. Verified 9 NY URLs returned via BD on
    // 2026-05-17, including the same-week Tristan review.
    fetchAndParse: async (showTitle, market, openingDate, showId) => withOperaCache({ outletId: 'newyorker', showId }, async () => {
      const html = await fetchSSR('https://www.therestisnoise.com/');
      const all = [];
      const pattern = /(https?:\/\/(?:www\.)?newyorker\.com\/(?:magazine|culture|cultural-comment)\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+)/gi;
      let m;
      while ((m = pattern.exec(html)) !== null) all.push(m[1]);
      if (all.length === 0) {
        console.warn('    [opera-discovery] WARN: newyorker therestisnoise index returned 0 NY URLs (blog down or structural change)');
      }
      const titleWords = operaTitleWords(showTitle);
      const matches = [...new Set(all)].filter((url) => {
        const slug = (url.split('/').pop() || '').toLowerCase();
        // Lower threshold (1 hit) than other outlets — therestisnoise.com
        // surfaces ~10 URLs at a time and Alex Ross writes one Met review per
        // month, so false-positive risk is low. Two-word match would miss
        // "tristan-at-the-met-music-review" (operaTitleWords drops "und").
        const hits = titleWords.filter((w) => slug.includes(w)).length;
        return hits >= 1;
      });
      return filterOperaUrls(matches, 'newyorker', showId, openingDate);
    }),
  },

  'playbill-roundup': {
    name: 'Playbill (roundup)',
    domain: 'playbill.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // Per-show review-roundup discovery. SERPs Playbill for an article
    // matching one of three slug patterns and extracts outlet URLs from the
    // body. High-recall safety net for the per-outlet fan-out — when this
    // hits, it returns 5-8 outlet URLs covering NYT/WSJ/FT/Vulture/etc. in
    // one fetch. Discovered URLs carry their outlet domain so downstream
    // resolveOutletFromUrl maps each to its canonical outletId at ingest.
    skipUrlFilter: true,
    // Roundup URLs are heterogeneous (NYT, Vulture, FT, Operawire, etc.) —
    // the dispatcher must re-resolve each result's outletId from the URL.
    // Without this flag, every URL inherits outletId='playbill-roundup' and
    // every outlet='Playbill (roundup)', which causes downstream code in
    // gather-reviews.js:1665 (the `if (!outlet)` resolveOutletFromUrl gate)
    // to SKIP resolution because outlet is already set.
    resolveOutletPerUrl: true,
    fetchAndParse: async (showTitle, market, openingDate, showId) => {
      const { discoverPlaybillRoundup } = require('./playbill-roundup-discover');
      const show = { type: 'opera', title: showTitle, openingDate, id: showId };
      const urls = await discoverPlaybillRoundup(show);
      return filterOperaUrls(urls, 'playbill-roundup', showId, openingDate);
    },
  },

  'washpost': {
    name: 'The Washington Post',
    domain: 'washingtonpost.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // Philip Kennicott is the WaPo arts critic covering Met opera transmissions.
    // His author archive renders server-side with ~55 article URLs but requires
    // subscriber cookies (cookies-plain confirmed working in Sprint 1).
    // fetchSSR's fetchPage fallback carries the washingtonpost.com cookie jar.
    fetchAndParse: async (showTitle, market, openingDate, showId) => withOperaCache({ outletId: 'washpost', showId }, async () => {
      const html = await fetchSSR('https://www.washingtonpost.com/people/philip-kennicott/');
      const all = [];
      const pattern = /(https?:\/\/(?:www\.)?washingtonpost\.com\/[a-z-]+\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+)/gi;
      let m;
      while ((m = pattern.exec(html)) !== null) all.push(m[1]);
      if (all.length === 0) {
        console.warn('    [opera-discovery] WARN: washpost Kennicott archive returned 0 article URLs (cookies stale or structural change)');
      }
      const titleWords = operaTitleWords(showTitle);
      const matches = [...new Set(all)].filter((url) => {
        const slug = (url.split('/').pop() || '').toLowerCase();
        const hits = titleWords.filter((w) => slug.includes(w)).length;
        return hits >= 1;
      });
      return filterOperaUrls(matches, 'washpost', showId, openingDate);
    }),
  },

  'times-uk-opera': {
    name: 'The Times (UK)',
    domain: 'thetimes.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // Sibling to the 'times-uk' (line ~221) West-End Algolia entry — separate
    // key required because the map can't hold two entries with the same id.
    // outletIdOverride pushes canonical 'times-uk' downstream.
    outletIdOverride: 'times-uk',
    // The Times's classical-opera tag page lists every recent classical/opera
    // review including Met transmissions. cookies-plain works for the
    // listing (Sprint 1 verified 615KB body). URL pattern for individual
    // reviews: /culture/classical-opera/article/{slug}-{8-char-hash}.
    fetchAndParse: async (showTitle, market, openingDate, showId) => withOperaCache({ outletId: 'times-uk-opera', showId }, async () => {
      const html = await fetchSSR('https://www.thetimes.com/topic/opera');
      const all = [];
      // Times listing uses relative URLs like /culture/classical-opera/article/{slug}-{hash}.
      // Capture relative path and prepend the canonical domain.
      const pattern = /["'](\/culture\/classical-opera\/article\/[a-z0-9-]+)["']/gi;
      let m;
      while ((m = pattern.exec(html)) !== null) all.push('https://www.thetimes.com' + m[1]);
      if (all.length === 0) {
        console.warn('    [opera-discovery] WARN: times-uk-opera tag page returned 0 links (possible structural change)');
      }
      const titleWords = operaTitleWords(showTitle);
      const matches = [...new Set(all)].filter((url) => {
        const slug = (url.split('/').pop() || '').toLowerCase();
        const hits = titleWords.filter((w) => slug.includes(w)).length;
        return hits >= 1;
      });
      return filterOperaUrls(matches, 'times-uk', showId, openingDate);
    }),
  },

  'artsdesk': {
    name: 'The Arts Desk',
    domain: 'theartsdesk.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // theartsdesk.com/opera lists recent opera reviews. Open access (no
    // cookies needed). URL pattern: /opera/{slug}. Met transmission reviews
    // are tagged with "metropolitan-opera" in the slug (verified for Tristan).
    fetchAndParse: async (showTitle, market, openingDate, showId) => withOperaCache({ outletId: 'artsdesk', showId }, async () => {
      const html = await fetchSSR('https://theartsdesk.com/opera');
      const all = [];
      const pattern = /["'](?:https?:\/\/(?:www\.)?theartsdesk\.com)?(\/opera\/[a-z0-9-]+)["']/gi;
      let m;
      while ((m = pattern.exec(html)) !== null) all.push('https://theartsdesk.com' + m[1]);
      if (all.length === 0) {
        console.warn('    [opera-discovery] WARN: artsdesk opera section returned 0 links (possible structural change)');
      }
      const titleWords = operaTitleWords(showTitle);
      const matches = [...new Set(all)].filter((url) => {
        const slug = (url.split('/').pop() || '').toLowerCase();
        const hits = titleWords.filter((w) => slug.includes(w)).length;
        return hits >= 1;
      });
      return filterOperaUrls(matches, 'artsdesk', showId, openingDate);
    }),
  },

  'nystagereview': {
    name: 'New York Stage Review',
    domain: 'nystagereview.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // Registry canonical is 'nysr' (nystagereview is an alias). The
    // outletIdOverride pushes the canonical downstream so scoring + dedup
    // see 'nysr' uniformly. Sibling pattern to 'vulture-opera' and
    // 'times-uk-opera'. (Added 2026-05-17 — Notion 363637c5-416f-8163.)
    outletIdOverride: 'nysr',
    // NYSR has no opera-category page; use WordPress search ?s={title}. URL
    // pattern: /YYYY/MM/DD/slug/. NYSR primarily covers theater but reviews
    // Met premieres (Innocence verified). Reviewers like Frank Scheck rotate
    // in for opera coverage.
    fetchAndParse: async (showTitle, market, openingDate, showId) => withOperaCache({ outletId: 'nystagereview', showId }, async () => {
      const q = encodeURIComponent(`${showTitle} opera`);
      const html = await fetchSSR(`https://nystagereview.com/?s=${q}`);
      const all = [];
      const pattern = /href="(https:\/\/nystagereview\.com\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+)\/?"/gi;
      let m;
      while ((m = pattern.exec(html)) !== null) all.push(m[1]);
      if (all.length === 0) {
        console.warn('    [opera-discovery] WARN: nystagereview search returned 0 article URLs (CMS change or empty result)');
      }
      const titleWords = operaTitleWords(showTitle);
      const matches = [...new Set(all)].filter((url) => {
        const slug = (url.split('/').pop() || '').toLowerCase();
        const hits = titleWords.filter((w) => slug.includes(w)).length;
        return hits >= 1;
      });
      return filterOperaUrls(matches, 'nystagereview', showId, openingDate);
    }),
  },

  'broadwayworld': {
    name: 'BroadwayWorld',
    domain: 'broadwayworld.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // BWW Opera coverage lives at /bwwopera/reviews. Hand-authored marketing
    // slugs (e.g. "Review-FRIDA-Y-DIEGO-is-the-Ultimate-Dream…") need
    // diacritic-stripped tokenization and a 50% match threshold — both
    // handled in the dedicated sibling helper to keep this entry small.
    skipUrlFilter: true,
    fetchAndParse: async (showTitle, market, openingDate, showId) => withOperaCache({ outletId: 'broadwayworld-opera', showId }, async () => {
      const { discoverBwwOperaReviews } = require('./bww-opera-discover');
      const show = { type: 'opera', title: showTitle, openingDate, id: showId };
      const results = await discoverBwwOperaReviews(show);
      const urls = results.map((r) => r.url);
      return filterOperaUrls(urls, 'broadwayworld', showId, openingDate);
    }),
  },

  'vulture-opera': {
    name: 'Vulture',
    domain: 'vulture.com',
    requiresJs: false,
    applies: (show) => show.type === 'opera',
    // Sibling to the 'vulture' (line ~182) Broadway-theater entry — separate
    // key required because the map can't hold two entries with the same id.
    // outletIdOverride pushes canonical 'vulture' downstream so outlet-registry,
    // scoring, and dedup don't see a stranger 'vulture-opera' id.
    outletIdOverride: 'vulture',
    // Justin Davidson is the music/opera critic; the SSR HTML for his author
    // archive carries ~30 anchors per page (lazy-loaded beyond that). Slug-match
    // against opera-title words because Vulture URLs are descriptive
    // ("opera-review-met-new-tristan-und-isolde",
    // "review-the-dismaying-opera-of-kavalier-and-clay").
    // Pagination: first page only — covers ~2-3 months of Davidson's output,
    // which exceeds the Sprint 3 daysSinceOpening<21 gate.
    fetchAndParse: async (showTitle, market, openingDate, showId) => withOperaCache({ outletId: 'vulture-opera', showId }, async () => {
      const html = await fetchSSR('https://www.vulture.com/author/justin-davidson/');
      const all = [];
      const pattern = /href="(https?:\/\/(?:www\.)?vulture\.com\/article\/[a-z0-9-]+\.html)"/gi;
      let m;
      while ((m = pattern.exec(html)) !== null) all.push(m[1]);
      if (all.length === 0) {
        console.warn('    [opera-discovery] WARN: vulture-opera author page returned 0 links (possible structural change)');
      }
      const titleWords = operaTitleWords(showTitle);
      const matches = [...new Set(all)].filter((url) => {
        const slug = (url.split('/article/')[1] || '').toLowerCase();
        const hits = titleWords.filter((w) => slug.includes(w)).length;
        return hits >= Math.min(2, titleWords.length);
      });
      return filterOperaUrls(matches, 'vulture', showId, openingDate);
    }),
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
 * Direct HTTP fetch (cheap path used by fetchSSR before any fallback).
 * Resolves with { status, body } so the wrapper can decide whether to fall
 * back to the heavyweight scraper. NEVER rejects on non-200 — surfaces the
 * status code so Cloudflare/blocking patterns are inspectable.
 */
function _fetchSSRDirect(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        // Include application/json so outlets that content-negotiate (WP REST APIs)
        // get JSON instead of HTML challenge pages when they would otherwise infer
        // a browser request.
        'Accept': 'application/json, text/html;q=0.9, application/xhtml+xml;q=0.8',
      }
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return _fetchSSRDirect(res.headers.location, timeoutMs).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Cloudflare-challenge markers — same set scraper.js:478-486 uses for BD detection.
const _CLOUDFLARE_MARKERS = ['cf_chl_opt', 'challenge-platform', 'Just a moment...', 'Enable JavaScript and cookies'];
function _looksLikeCloudflareChallenge(body) {
  if (!body || typeof body !== 'string') return false;
  if (body.length > 50000) return false; // challenge pages are tiny
  return _CLOUDFLARE_MARKERS.some(m => body.includes(m));
}

/**
 * HTTP fetch (for SSR search pages) with Cloudflare-challenge fallback.
 *
 * Tries direct fetch first (cheap, ~200ms). On 403/503/Cloudflare-challenge
 * markers, falls back to scraper.js fetchPage (BD → SB → Playwright chain,
 * ~1-3s, costs $0.001-0.005). Logs the fallback so cost is visible.
 *
 * 2026-04-29: Added after NYCR + Operawire WP REST endpoints started returning
 * 403 with Cloudflare challenge HTML. Without this, opera-outlet discovery
 * silently returned 0 URLs (rejecting on non-200) when the outlet was simply
 * blocked, making it indistinguishable from "no review yet."
 *
 * Returns: string body (JSON callers must wrap JSON.parse in try-catch — fallback
 * path may return HTML rather than JSON if the cheap path's content-negotiation
 * fails).
 */
async function fetchSSR(url, timeoutMs = 15000) {
  let direct;
  try {
    direct = await _fetchSSRDirect(url, timeoutMs);
  } catch (e) {
    // Network error: fall through to fetchPage fallback.
    direct = null;
  }

  // Happy path: 200 + no Cloudflare marker = use direct response.
  if (direct && direct.status === 200 && !_looksLikeCloudflareChallenge(direct.body)) {
    return direct.body;
  }

  // Determine whether to fall back. Only burn BD/SB credits when the response
  // looks blocked, not for every legitimate 4xx (e.g. 404 = post truly missing).
  const shouldFallback = !direct
    || direct.status === 403
    || direct.status === 503
    || _looksLikeCloudflareChallenge(direct.body);

  if (!shouldFallback) {
    // 4xx that isn't blocking — surface to caller so they handle (e.g. 404 → empty list).
    throw new Error(`HTTP ${direct.status}`);
  }

  // Lazy-require to avoid pulling scraper.js dependencies into every consumer.
  let fetchPage;
  try {
    ({ fetchPage } = require('./scraper'));
  } catch (e) {
    // Scraper unavailable — surface the original error
    throw new Error(`fetchSSR fallback unavailable: ${direct ? `HTTP ${direct.status}` : 'network error'} (scraper.js not loadable)`);
  }
  console.log(`    [fetchSSR] cheap path returned ${direct ? `HTTP ${direct.status}${_looksLikeCloudflareChallenge(direct.body) ? ' (Cloudflare challenge)' : ''}` : 'network error'} — falling back to fetchPage for ${url}`);
  const result = await fetchPage(url, { skipVerify: true });
  if (!result || !result.content) {
    throw new Error(`fetchSSR: fallback returned no content for ${url}`);
  }
  return result.content;
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
        // outletIdOverride lets a sibling entry (e.g. 'vulture-opera') push the
        // canonical outlet id (e.g. 'vulture') downstream so outlet-registry
        // lookups and scoring don't see a stranger id. Required when opera
        // dispatch differs from the default dispatch for the SAME outlet —
        // the map can't carry two entries under one key.
        let effectiveOutletId = config.outletIdOverride || outletId;
        let effectiveOutletName = config.name;
        // resolveOutletPerUrl: for entries that return heterogeneous URLs
        // (e.g. playbill-roundup: NYT + Vulture + FT + ... in one batch),
        // resolve outletId per-URL from the domain. Without this, every URL
        // inherits the entry's outletId and downstream resolveOutletFromUrl
        // is skipped because outlet is already set.
        if (config.resolveOutletPerUrl) {
          try {
            const { resolveOutletFromUrl } = require('./review-normalization');
            const resolved = resolveOutletFromUrl(url);
            if (resolved && resolved.outletId) {
              effectiveOutletId = resolved.outletId;
              effectiveOutletName = resolved.displayName || resolved.outletId;
            }
          } catch (_e) {
            // resolveOutletFromUrl unavailable — leave defaults and let
            // gather-reviews.js's downstream re-resolution kick in via the
            // `if (!outlet)` gate. To enable that gate, clear outlet here.
            effectiveOutletName = null;
          }
        }
        results.push({ url, outletId: effectiveOutletId, outlet: effectiveOutletName, source: 'site-search' });
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
