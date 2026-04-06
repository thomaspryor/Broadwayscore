#!/usr/bin/env node
/**
 * Sweep all WE aggregators for each open WE/OWE show.
 *
 * For each show, searches each aggregator by title, fetches the roundup page,
 * archives it, extracts reviews, and writes review files. One script does
 * discovery + collection + extraction.
 *
 * Usage:
 *   node scripts/sweep-we-aggregators.js [--shows=X,Y,Z] [--dry-run] [--force]
 *     [--aggregator=wet,tr,sd,ts] [--limit=N]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const cheerio = require('cheerio');
const { matchTitleToShow, loadShows } = require('./lib/show-matching');
const { normalizeOutlet, normalizeCritic, findExistingReviewFile } = require('./lib/review-normalization');
const { safeWriteReview } = require('./lib/review-write-guard');
const { isLondonMarket } = require('./lib/venue-classification');
const { serpQuery } = require('./lib/url-discovery');

// Reuse extraction functions from existing scrapers
const { extractStarRatings, extractSectionReviews, extractShowTitle, fetchRenderedPage } = require('./scrape-westendtheatre-roundups');
const { extractReviews: extractTheatreReviews } = require('./scrape-theatre-reviews');
const { extractReviews: extractStageReviews } = require('./scrape-thestage-roundups');

// SERP for per-show aggregator discovery
const { discoverCorrectUrl } = require('./lib/url-discovery');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const ARCHIVE_BASE = path.join(__dirname, '..', 'data', 'aggregator-archive');

// Manually discovered URLs that automated matching can't find (verified via web search)
const TR_KNOWN_URLS = {
  'hadestown-west-end-2024': 'https://theatre.reviews/reviews-roundup/hadestown-lyric-reviews/',
  'oliver-west-end-2024': 'https://theatre.reviews/reviews-roundup/oliver-gielgud-reviews/',
  'cabaret-at-the-kit-kat-club-west-end-2021': 'https://theatre.reviews/reviews-roundup/cabaret-playhouse-reviews/',
  'starlight-express-west-end-2024': 'https://theatre.reviews/reviews-roundup/starlight-express-troubadour-reviews/',
  'the-devil-wears-prada-west-end-2024': 'https://theatre.reviews/reviews-roundup/devil-wears-prada-reviews/',
  'hercules-west-end-2025': 'https://theatre.reviews/reviews-roundup/hercules-reviews/',
  'oh-mary-west-end-2025': 'https://theatre.reviews/reviews-roundup/oh-mary-trafalgar-reviews/',
  'the-producers-west-end-2025': 'https://theatre.reviews/reviews-roundup/the-producers-garrick-reviews/',
  'titanique-west-end-2024': 'https://theatre.reviews/reviews-roundup/titanique-reviews/',
  'paddington-the-musical-west-end-2025': 'https://theatre.reviews/reviews-roundup/paddington-the-musical-reviews/',
  'the-hunger-games-on-stage-west-end-2025': 'https://theatre.reviews/reviews-roundup/hunger-games-reviews/',
  'my-neighbour-totoro-west-end-2025': 'https://theatre.reviews/reviews-roundup/my-neighbour-totoro-reviews/',
  'all-my-sons-west-end-2025': 'https://theatre.reviews/reviews-roundup/all-my-sons-wyndham-reviews/',
};
const TS_KNOWN_URLS = {
  'moulin-rouge-the-musical-west-end-2021': 'https://www.thestage.co.uk/review-round-ups/moulin-rouge-the-musical-starring-liisi-lafontaine-and-jamie-bogyo--review-round-up',
  'hadestown-west-end-2024': 'https://www.thestage.co.uk/review-round-ups/anais-mitchells-hadestown-at-the-national-theatre-london--review-round-up',
  'oh-mary-west-end-2025': 'https://www.thestage.co.uk/review-round-ups/oh-mary-starring-mason-alexander-park-review-round-up',
  'oliver-west-end-2024': 'https://www.thestage.co.uk/review-round-ups/oliver-starring-simon-lipkin--review-round-up',
  'back-to-the-future-west-end-2021': 'https://www.thestage.co.uk/review-round-ups/back-to-the-future-the-musical-at-londons-adelphi-theatre--review-round-up',
  'harry-potter-and-the-cursed-child-both-parts-west-end-2021': 'https://www.thestage.co.uk/review-round-ups/harry-potter-and-the-cursed-child-at-the-palace-theatre--review-round-up',
  'cabaret-at-the-kit-kat-club-west-end-2021': 'https://www.thestage.co.uk/review-round-ups/cabaret-starring-eddie-redmayne-and-jessie-buckley--review-round-up',
  'stranger-things-the-first-shadow-west-end-2023': 'https://www.thestage.co.uk/review-round-ups/stranger-things-the-first-shadow-at-the-phoenix-theatre--review-round-up',
  'my-neighbour-totoro-west-end-2025': 'https://www.thestage.co.uk/review-round-ups/my-neighbour-totoro-at-the-barbican--review-round-up',
  'paddington-the-musical-west-end-2025': 'https://www.thestage.co.uk/review-round-ups/paddington-the-musical-at-the-savoy-theatre-review-round-up',
  // Older roundups under /opinion/ path (pre-review-round-ups section)
  'hamilton-west-end-2021': 'https://www.thestage.co.uk/opinion/hamilton-at-victoria-palace-theatre-london--review-round-up',
  'les-miserables-west-end-2021': 'https://www.thestage.co.uk/opinion/les-miserables-returns-to-the-sondheim-theatre-london--review-round-up',
};
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const COOKIE_JAR = '/tmp/sweep-we-cookies.txt';
const SB_KEY = process.env.SCRAPINGBEE_API_KEY || '';
const BD_KEY = process.env.BRIGHTDATA_TOKEN || '';

// CLI args
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const showsArg = process.argv.find(a => a.startsWith('--shows='));
const TARGET_SHOWS = showsArg ? showsArg.split('=')[1].split(',') : null;
const aggArg = process.argv.find(a => a.startsWith('--aggregator='));
const AGGREGATORS = aggArg ? aggArg.split('=')[1].split(',') : ['wet', 'tr', 'sd', 'ts'];
const limitArg = process.argv.find(a => a.startsWith('--limit='));
const LIMIT = limitArg ? parseInt(limitArg.split('=')[1]) : null;

const stats = { shows: 0, wet: { found: 0, reviews: 0 }, tr: { found: 0, reviews: 0 }, sd: { found: 0, reviews: 0 }, ts: { found: 0, reviews: 0 }, errors: 0 };

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Site-scoped Google SERP search via ScrapingBee.
 * Returns first matching URL or null.
 */
/**
 * Validate a SERP URL contains the show title (prevents wrong-show matches).
 * e.g., Hamilton search returning "good-starring-david-tennant" is rejected.
 */
function validateSerpUrl(url, showTitle) {
  if (!url) return false;
  const slug = url.toLowerCase();
  // Extract significant words from show title (skip articles, prepositions)
  const skipWords = new Set(['the', 'a', 'an', 'at', 'in', 'of', 'and', 'or', 'on', 'to', 'is']);
  const words = showTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
    .filter(w => w.length > 2 && !skipWords.has(w));
  if (words.length === 0) return true; // fallback: accept if no significant words
  // Require at least the first significant word to be in the URL
  const firstWord = words[0];
  if (!slug.includes(firstWord)) return false;
  // For multi-word titles, require at least 2 words to match (prevents "six" matching unrelated)
  if (words.length >= 2) {
    const matchCount = words.filter(w => slug.includes(w)).length;
    return matchCount >= Math.min(2, words.length);
  }
  return true;
}

async function serpSearch(site, showTitle) {
  const query = `site:${site} "${showTitle}" review`;

  try {
    const results = await serpQuery(query, { nbResults: 3 });
    if (!results) return null;

    for (const r of results) {
      if (r.url && validateSerpUrl(r.url, showTitle)) return r.url;
    }
    if (results.length > 0) {
      console.log(`    [SERP] Rejected: ${results[0].url.substring(0, 80)} (doesn't match "${showTitle}")`);
    }
  } catch {}

  return null;
}

// ─── HTTP Helpers ────────────────────────────────────────────────────────────

function curlFetch(url, options = {}) {
  const args = ['-s', '-L', url, '-H', `User-Agent: ${USER_AGENT}`, '--compressed'];
  if (options.accept) args.push('-H', `Accept: ${options.accept}`);
  if (options.cookies) { args.push('-b', COOKIE_JAR, '-c', COOKIE_JAR); }
  if (options.cookieHeader) args.push('-H', `Cookie: ${options.cookieHeader}`);
  try {
    return execFileSync('curl', args, { timeout: options.timeout || 20000, maxBuffer: 5 * 1024 * 1024, encoding: 'utf8' });
  } catch { return null; }
}

/**
 * Fetch via Node https — needed for sites that block curl (e.g., theatre.reviews CleanTalk)
 */
function nodeFetch(url) {
  const https = require('https');
  return new Promise((resolve) => {
    const doFetch = (fetchUrl, redirects) => {
      if (redirects > 5) { resolve(null); return; }
      https.get(fetchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36', 'Accept': 'text/html' },
      }, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const loc = res.headers.location;
          if (loc) return doFetch(loc.startsWith('http') ? loc : new URL(loc, fetchUrl).href, redirects + 1);
        }
        if (res.statusCode !== 200) { resolve(null); return; }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve(data));
      }).on('error', () => resolve(null));
    };
    doFetch(url, 0);
  });
}

function curlJson(url) {
  const raw = curlFetch(url, { accept: 'application/json', cookies: true, timeout: 15000 });
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Fetch rendered HTML via ScrapingBee (bypasses CleanTalk, Cloudflare, etc.)
 * Costs 5 credits per request with render_js=true.
 */
async function scrapingBeeRender(url) {
  if (!SB_KEY) return null;
  const axios = require('axios');
  try {
    const resp = await axios.get('https://app.scrapingbee.com/api/v1', {
      params: {
        api_key: SB_KEY,
        url,
        render_js: 'true',
        premium_proxy: 'true',
        country_code: 'gb',
      },
      timeout: 30000,
      responseType: 'text',
    });
    return resp.data || null;
  } catch (err) {
    console.log(`    [SB] Render failed for ${url}: ${(err.message || '').substring(0, 60)}`);
    return null;
  }
}

// ─── Review File Writer ──────────────────────────────────────────────────────

function writeReview(review, showId) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) fs.mkdirSync(showDir, { recursive: true });

  const outletId = review.outletId || normalizeOutlet(review.outlet);
  const criticSlug = normalizeCritic(review.critic || review.criticName || 'Unknown');

  const existingMatch = findExistingReviewFile(showDir, outletId, criticSlug);
  const filePath = existingMatch ? existingMatch.path : path.join(showDir, `${outletId}--${criticSlug}.json`);

  // Safety: if findExistingReviewFile returned null (e.g. wrongProduction skip),
  // but the file physically exists, load it to avoid overwriting scored data
  let data;
  if (existingMatch && existingMatch.data) {
    data = existingMatch.data;
  } else if (fs.existsSync(filePath)) {
    try { data = JSON.parse(fs.readFileSync(filePath, 'utf-8')); } catch { data = {}; }
  } else {
    data = {};
  }

  data.showId = data.showId || showId;
  data.outlet = data.outlet || review.outlet;
  data.outletId = data.outletId || outletId;
  data.criticName = data.criticName || review.critic || review.criticName || 'Unknown';
  if (review.url && !data.url) data.url = review.url;

  // Source-specific excerpt fields
  if (review.source === 'westendtheatre' && review.excerpt) data.westEndTheatreExcerpt = review.excerpt;
  if (review.source === 'theatre-reviews' && review.excerpt) data.theatreReviewsExcerpt = review.excerpt;
  if (review.source === 'thestage-roundup' && review.excerpt) data.theStageExcerpt = review.excerpt;
  if (review.source === 'stagedoor' && review.excerpt) data.stagedoorExcerpt = review.excerpt;

  // Aggregator star rating → aggregatorStars only (never originalScore).
  // WE aggregators (WET, TR, SD, TS) provide third-party compilations of outlet scores,
  // not the outlet's own rating. Storing as originalScore contaminates the outlet's score
  // with the aggregator's interpretation. Use aggregatorStars as a fallback only.
  if (review.stars && !data.originalScore && !data.aggregatorStars) {
    data.aggregatorStars = `${review.stars}/${review.starsOutOf || 5}`;
    data.scoreSource = data.scoreSource || review.scoreSource || `${review.source}-star-rating`;
  }

  if (!DRY_RUN) {
    safeWriteReview(filePath, data);
  }
  return !!existingMatch;
}

// ─── WestEndTheatre (WP API) ────────────────────────────────────────────────

async function sweepWET(show) {
  // Archive-skip: WET archives the rendered page HTML when section format is used
  const wetArchDir = path.join(ARCHIVE_BASE, 'westendtheatre');
  const wetArchivePath = path.join(wetArchDir, `${show.id}.html`);
  if (!FORCE && fs.existsSync(wetArchivePath)) {
    try {
      const html = fs.readFileSync(wetArchivePath, 'utf8');
      const reviews = extractSectionReviews(html).map(r => ({
        outlet: r.outlet, outletId: normalizeOutlet(r.outlet),
        critic: r.critic || 'Unknown', stars: r.stars, starsOutOf: 5,
        excerpt: r.excerpt || '', url: r.reviewUrl || '',
        source: 'westendtheatre',
      }));
      if (reviews.length > 0) return reviews;
    } catch {}
  }

  // Also check for cached API response
  const wetApiCache = path.join(wetArchDir, `${show.id}.json`);
  if (!FORCE && fs.existsSync(wetApiCache)) {
    try {
      const cached = JSON.parse(fs.readFileSync(wetApiCache, 'utf8'));
      if (cached.reviews && cached.reviews.length > 0) return cached.reviews;
    } catch {}
  }

  // Try multiple search queries: full title, then stripped title (no subtitles/qualifiers)
  const searchTitles = [
    show.title.replace(/['"]/g, ''),
    // Strip "Both Parts", "The Musical", "On Stage" etc.
    show.title.replace(/['"]/g, '')
      .replace(/:\s*Both Parts$/i, '').replace(/\s+The Musical$/i, '')
      .replace(/\s+On Stage$/i, '').replace(/\s+-\s+Globe$/i, '')
      .replace(/\s+at the Kit Kat Club$/i, ''),
  ];
  // Deduplicate
  const uniqueSearches = [...new Set(searchTitles.map(s => s.trim()).filter(Boolean))];

  let allPosts = [];
  for (const searchTitle of uniqueSearches) {
    const apiUrl = `https://www.westendtheatre.com/wp-json/wp/v2/posts?categories=10&per_page=10&search=${encodeURIComponent(searchTitle)}`;
    let posts = curlJson(apiUrl);

    // ScrapingBee fallback if Sucuri WAF blocks curl (common in CI)
    if (!posts && SB_KEY) {
      try {
        const axios = require('axios');
        const resp = await axios.get('https://app.scrapingbee.com/api/v1', {
          params: { api_key: SB_KEY, url: apiUrl, render_js: 'false' },
          timeout: 20000, responseType: 'text',
        });
        try { posts = JSON.parse(resp.data); } catch {}
      } catch {}
    }

    if (posts && Array.isArray(posts)) {
      for (const p of posts) {
        if (!allPosts.find(ep => ep.id === p.id)) allPosts.push(p);
      }
    }
    if (uniqueSearches.length > 1) await sleep(500);
  }
  if (allPosts.length === 0) return [];

  // Find best matching post — try multiple title cleaning strategies
  for (const post of allPosts.slice(0, 5)) {
    const wpTitle = (post.title?.rendered || '').replace(/&#8217;/g, "'").replace(/&#8211;/g, '\u2013').replace(/&#8212;/g, '\u2014').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/<[^>]+>/g, '');

    // Try matching with cleaned title, raw title, and show title in WP title
    const cleaned = extractShowTitle(wpTitle);
    let matched = false;
    for (const tryTitle of [cleaned, wpTitle, show.title]) {
      if (!tryTitle) continue;
      const m = matchTitleToShow(tryTitle, [show], { market: 'west-end' });
      if (m && m.show) { matched = true; break; }
    }
    // Also check: does the WP title contain the show title?
    if (!matched && wpTitle.toLowerCase().includes(show.title.toLowerCase())) matched = true;
    if (!matched) continue;

    const htmlContent = post.content?.rendered || '';
    let reviews = [];

    // Try table format first
    reviews = extractStarRatings(htmlContent).map(r => ({
      outlet: r.outlet, outletId: normalizeOutlet(r.outlet),
      critic: r.critic || 'Unknown', stars: r.stars, starsOutOf: 5,
      excerpt: r.excerpt || '', url: post.link || '',
      source: 'westendtheatre', scoreSource: 'westendtheatre-star-rating',
    }));

    // Fallback: section format from rendered page
    if (reviews.length === 0 && post.link) {
      const pageHtml = fetchRenderedPage(post.link);
      if (pageHtml) {
        reviews = extractSectionReviews(pageHtml).map(r => ({
          outlet: r.outlet, outletId: normalizeOutlet(r.outlet),
          critic: r.critic || 'Unknown', stars: r.stars, starsOutOf: 5,
          excerpt: r.excerpt || '', url: r.reviewUrl || post.link || '',
          source: 'westendtheatre',
        }));

        // Archive the rendered page
        if (!DRY_RUN && pageHtml) {
          const archDir = path.join(ARCHIVE_BASE, 'westendtheatre');
          if (!fs.existsSync(archDir)) fs.mkdirSync(archDir, { recursive: true });
          fs.writeFileSync(path.join(archDir, `${show.id}.json`),
            JSON.stringify({ ourShowId: show.id, wpPostId: post.id, fetchedAt: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');
        }
      }
    }

    if (reviews.length > 0) {
      // Cache extracted reviews so future runs skip the API call
      if (!DRY_RUN) {
        if (!fs.existsSync(wetArchDir)) fs.mkdirSync(wetArchDir, { recursive: true });
        fs.writeFileSync(wetApiCache, JSON.stringify({ reviews, fetchedAt: new Date().toISOString().slice(0, 10) }, null, 2) + '\n');
      }
      return reviews;
    }
  }
  return [];
}

// ─── theatre.reviews (full index + per-show match) ───────────────────────────

// Lazy-loaded full index of theatre.reviews roundup URLs
let _trIndex = null; // Map<showId, url>

/**
 * Build a full index of theatre.reviews roundup URLs.
 * Phase 1: Homepage (lists all current shows with direct links — no auth needed)
 * Phase 2: Category archive pagination (for older shows, with SB render fallback)
 */
async function _buildTRIndex(weShows) {
  if (_trIndex) return _trIndex;
  _trIndex = new Map();

  console.log('\n  [TR] Building full theatre.reviews index...');
  const { extractTitleFromSlug } = require('./scrape-theatre-reviews');
  const cheerio = require('cheerio');

  const seen = new Set();
  const allUrls = [];

  // Phase 1: Scrape homepage — lists all current roundup links reliably
  const homepageHtml = await nodeFetch('https://theatre.reviews/');
  if (homepageHtml) {
    const $hp = cheerio.load(homepageHtml);
    $hp('a[href*="/reviews-roundup/"]').each((_, el) => {
      const href = $hp(el).attr('href');
      if (!href || !href.includes('/reviews-roundup/')) return;
      if (href.match(/\/category\//)) return;
      const full = href.startsWith('http') ? href : `https://theatre.reviews${href}`;
      if (!seen.has(full)) { seen.add(full); allUrls.push(full); }
    });
    console.log(`  [TR] Homepage: ${allUrls.length} roundup URLs`);
  }

  // Phase 2: Category archive pagination for older shows
  const MAX_PAGES = 30;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = page === 1
      ? 'https://theatre.reviews/category/reviews-roundup/'
      : `https://theatre.reviews/category/reviews-roundup/page/${page}/`;
    let html = await nodeFetch(pageUrl);
    if (!html && SB_KEY) html = await scrapingBeeRender(pageUrl);
    if (!html) break;
    const $ = cheerio.load(html);
    let found = 0;
    $('a[href*="/reviews-roundup/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || !href.includes('/reviews-roundup/')) return;
      if (href.match(/\/category\//) || href.match(/\/page\//)) return;
      const full = href.startsWith('http') ? href : `https://theatre.reviews${href}`;
      if (!seen.has(full)) { seen.add(full); allUrls.push(full); found++; }
    });
    if (found === 0) break;
    console.log(`  [TR] Page ${page}: ${found} new (${allUrls.length} total)`);
    await sleep(1500);
  }

  console.log(`  [TR] ${allUrls.length} roundup URLs discovered`);

  // Match URLs to shows — try multiple slug cleaning strategies
  for (const url of allUrls) {
    // Extract raw slug: "oliver-gielgud-reviews" from full URL
    const slugMatch = url.match(/reviews-roundup\/(.+?)\/?\s*$/);
    if (!slugMatch) continue;
    const rawSlug = slugMatch[1].replace(/-reviews$/, '');

    // Try multiple cleaned variants of the slug
    const cleanedSlugs = [
      rawSlug,
      rawSlug.replace(/-with-.*$/, ''),           // strip "with-cynthia-erivo"
      rawSlug.replace(/-at-.*$/, ''),              // strip "at-the-bridge"
      // Strip venue suffixes (comprehensive list from actual slugs)
      rawSlug.replace(/-(gielgud|playhouse|garrick|troubadour|bridge|donmar|hampstead|menier|old-vic|young-vic|adelphi|savoy|apollo|noel-coward|wyndham|marylebone|almeida|barbican|soho-place|bonneville|national|trafalgar|criterion|phoenix|fortune|lyceum|piccadilly|cambridge|dominion|southwark|dorfman)$/, ''),
      // Strip "disneys-" prefix
      rawSlug.replace(/^disneys-/, ''),
    ];

    let bestMatch = null;
    for (const slug of [...new Set(cleanedSlugs)]) {
      const titleFromSlug = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      const match = matchTitleToShow(titleFromSlug, weShows, { market: 'west-end' });
      if (match && match.show) { bestMatch = match; break; }
    }

    // Fallback: check if any show title words appear in raw slug
    if (!bestMatch) {
      for (const show of weShows) {
        const showWords = show.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
          .filter(w => w.length > 2);
        const slugLower = rawSlug.toLowerCase();
        const matchCount = showWords.filter(w => slugLower.includes(w)).length;
        if (matchCount >= Math.min(2, showWords.length) && matchCount > 0) {
          bestMatch = { show };
          break;
        }
      }
    }

    if (bestMatch && bestMatch.show && !_trIndex.has(bestMatch.show.id)) {
      _trIndex.set(bestMatch.show.id, url);
    }
  }

  // Merge hardcoded known URLs (override if not already matched)
  for (const [showId, url] of Object.entries(TR_KNOWN_URLS)) {
    if (!_trIndex.has(showId)) _trIndex.set(showId, url);
  }

  console.log(`  [TR] Matched ${_trIndex.size} shows to roundup URLs\n`);
  return _trIndex;
}

async function sweepTheatreReviews(show) {
  const archDir = path.join(ARCHIVE_BASE, 'theatre-reviews');
  const archivePath = path.join(archDir, `${show.id}.html`);

  // Use archive if exists (skip expensive network calls)
  if (!FORCE && fs.existsSync(archivePath)) {
    const html = fs.readFileSync(archivePath, 'utf8');
    const reviews = extractTheatreReviews(html, show.id);
    if (reviews.length > 0) return reviews;
  }

  // Check the full index for a known URL
  const indexUrl = _trIndex ? _trIndex.get(show.id) : null;

  // Build URL candidates: index URL + constructed URLs
  const urls = [];
  if (indexUrl) urls.push(indexUrl);

  // Clean title for slug: strip articles, punctuation, special chars
  const titleSlug = show.title.toLowerCase()
    .replace(/['']/g, '').replace(/[&]/g, 'and')
    .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-')
    .replace(/^-|-$/g, '');
  // Also try without leading "the-"
  const titleSlugNoThe = titleSlug.replace(/^the-/, '');

  urls.push(`https://theatre.reviews/reviews-roundup/${titleSlug}-reviews/`);
  if (titleSlugNoThe !== titleSlug) {
    urls.push(`https://theatre.reviews/reviews-roundup/${titleSlugNoThe}-reviews/`);
  }

  if (show.venue) {
    // Generate multiple venue slug variants
    const venueClean = show.venue.toLowerCase()
      .replace(/\s*(theatre|theater|playhouse|warehouse|studio|hall)\s*/gi, '')
      .replace(/\s*'s\s*/g, 's ').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
    // Short venue: first word only (e.g., "donmar", "menier", "gielgud")
    const venueShort = venueClean.split('-')[0];
    const venueSlugs = [...new Set([venueClean, venueShort].filter(Boolean))];

    for (const vs of venueSlugs) {
      urls.unshift(`https://theatre.reviews/reviews-roundup/${titleSlug}-${vs}-reviews/`);
      if (titleSlugNoThe !== titleSlug) {
        urls.push(`https://theatre.reviews/reviews-roundup/${titleSlugNoThe}-${vs}-reviews/`);
      }
    }
  }

  // Deduplicate
  const uniqueUrls = [...new Set(urls)];

  // Try each URL via nodeFetch first (free), only use SB for the index URL (saves credits)
  for (const url of uniqueUrls) {
    const html = await nodeFetch(url);
    if (!html || html.length < 1000) continue;
    if (html.includes('<title>Page not found') || html.includes('404')) continue;

    const reviews = extractTheatreReviews(html, show.id);
    if (reviews.length > 0) {
      if (!DRY_RUN) {
        if (!fs.existsSync(archDir)) fs.mkdirSync(archDir, { recursive: true });
        fs.writeFileSync(archivePath, html);
      }
      return reviews;
    }
  }

  // BrowserBase fallback — bypasses CleanTalk JS challenge (SB gets 401)
  // Uses a one-shot BB session (no login — TR is a different site from The Stage)
  if (process.env.BROWSERBASE_API_KEY && indexUrl) {
    await sleep(2000);
    console.log(`    [TR] Trying BrowserBase for ${indexUrl.split('/reviews-roundup/')[1] || indexUrl}`);
    try {
      const https = require('https');
      const { chromium } = require('playwright');
      const BB_API_KEY = process.env.BROWSERBASE_API_KEY;
      const BB_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;
      const session = await new Promise((resolve, reject) => {
        const req = https.request('https://www.browserbase.com/v1/sessions', {
          method: 'POST',
          headers: { 'x-bb-api-key': BB_API_KEY, 'Content-Type': 'application/json' },
        }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
        req.on('error', reject);
        req.end(JSON.stringify({ projectId: BB_PROJECT_ID, browserSettings: { solveCaptchas: true } }));
      });
      const browser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${BB_API_KEY}&sessionId=${session.id}`);
      const ctx = browser.contexts()[0] || await browser.newContext();
      const page = ctx.pages()[0] || await ctx.newPage();
      await page.goto(indexUrl, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);
      const html = await page.content();
      await browser.close();

      if (html && html.length > 1000 && !html.includes('<title>Page not found') && !html.includes('404')) {
        const reviews = extractTheatreReviews(html, show.id);
        if (reviews.length > 0) {
          if (!DRY_RUN) {
            if (!fs.existsSync(archDir)) fs.mkdirSync(archDir, { recursive: true });
            fs.writeFileSync(archivePath, html);
          }
          return reviews;
        }
      }
    } catch (err) {
      console.log(`    [TR] BB error: ${err.message.substring(0, 60)}`);
    }
  }

  // SB render fallback — only for index URL
  if (SB_KEY && indexUrl) {
    await sleep(2000);
    console.log(`    [TR] Trying ScrapingBee for ${indexUrl.split('/reviews-roundup/')[1] || indexUrl}`);
    const html = await scrapingBeeRender(indexUrl);
    if (html && html.length > 1000 && !html.includes('<title>Page not found') && !html.includes('404')) {
      const reviews = extractTheatreReviews(html, show.id);
      if (reviews.length > 0) {
        if (!DRY_RUN) {
          if (!fs.existsSync(archDir)) fs.mkdirSync(archDir, { recursive: true });
          fs.writeFileSync(archivePath, html);
        }
        return reviews;
      }
    }
  }

  // Fallback to archive
  if (fs.existsSync(archivePath)) {
    const html = fs.readFileSync(archivePath, 'utf8');
    const reviews = extractTheatreReviews(html, show.id);
    if (reviews.length > 0) return reviews;
  }

  // Last resort: SERP discovery + ScrapingBee render
  if (SB_KEY || BD_KEY) {
    const serpUrl = await serpSearch('theatre.reviews', show.title);
    if (serpUrl && serpUrl.includes('reviews-roundup')) {
      let html = await nodeFetch(serpUrl);
      if (!html && SB_KEY) html = await scrapingBeeRender(serpUrl);
      if (html && html.length > 1000 && !html.includes('Page not found')) {
        const reviews = extractTheatreReviews(html, show.id);
        if (reviews.length > 0) {
          if (!DRY_RUN) {
            if (!fs.existsSync(archDir)) fs.mkdirSync(archDir, { recursive: true });
            fs.writeFileSync(archivePath, html);
          }
          return reviews;
        }
      }
    }
  }

  return [];
}

// ─── The Stage index (BrowserBase listing page discovery) ─────────────────────

let _tsIndex = null; // Map<showId, url>

/**
 * Build an index of The Stage roundup URLs by scraping their listing page
 * via BrowserBase. This discovers actual URLs (with performer names, venue
 * details etc.) that URL construction can't predict.
 */
async function _buildTSIndex(weShows) {
  if (_tsIndex) return _tsIndex;
  _tsIndex = new Map();

  // Need BrowserBase — The Stage listing is JS-rendered + paywalled
  if (!process.env.BROWSERBASE_API_KEY) {
    console.log('  [TS] No BrowserBase — skipping listing page discovery');
    return _tsIndex;
  }

  console.log('\n  [TS] Building The Stage index via BrowserBase...');

  try {
    // Use the shared BB session (will create one if needed)
    // Navigate to the listing page
    const listingUrl = 'https://www.thestage.co.uk/review-round-ups/review-round-ups';
    const html = await getStagePageViaBrowserBase(listingUrl);
    if (!html || html.length < 5000) {
      console.log('  [TS] Failed to load listing page');
      return _tsIndex;
    }

    // Extract roundup links
    const cheerio = require('cheerio');
    const $ = cheerio.load(html);
    const urls = [];
    const seen = new Set();

    $('a[href*="/review-round-ups/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const full = href.startsWith('http') ? href : `https://www.thestage.co.uk${href}`;
      if (!full.includes('-review-round-up')) return;
      if (full.includes('/review-round-ups/review-round-ups')) return;
      if (!seen.has(full)) {
        seen.add(full);
        urls.push(full);
      }
    });

    console.log(`  [TS] Found ${urls.length} roundup URLs on listing page`);

    // Try "Load More" by fetching additional pages if the listing is paginated
    // The Stage uses client-side pagination, so we need BB to click through
    if (_bbPage && urls.length > 0) {
      for (let loadMore = 0; loadMore < 15; loadMore++) {
        try {
          const btn = await _bbPage.$('button:has-text("Load More"), a:has-text("Load More"), button:has-text("Show More")');
          if (!btn) break;
          const visible = await btn.isVisible().catch(() => false);
          if (!visible) break;

          await btn.click();
          await _bbPage.waitForTimeout(3000);

          const newLinks = await _bbPage.$$eval('a[href*="/review-round-ups/"]', (anchors) => {
            return anchors.map(a => a.href).filter(h =>
              h.includes('-review-round-up') &&
              !h.includes('/review-round-ups/review-round-ups')
            );
          });

          let added = 0;
          for (const href of newLinks) {
            if (!seen.has(href)) {
              seen.add(href);
              urls.push(href);
              added++;
            }
          }
          console.log(`  [TS] Load more #${loadMore + 1}: ${added} new (${urls.length} total)`);
          if (added === 0) break;
        } catch (err) {
          console.log(`  [TS] Load more error: ${err.message.substring(0, 60)}`);
          break;
        }
      }
    }

    // Match URLs to our shows
    for (const url of urls) {
      // Extract slug from URL
      const slugMatch = url.match(/review-round-ups\/(.+?)(?:\?|$)/);
      if (!slugMatch) continue;
      const rawSlug = slugMatch[1].replace(/-review-round-up$/, '');

      // Clean slug: strip performer/director/venue suffixes for better matching
      const cleanedSlugs = [
        rawSlug,
        rawSlug.replace(/-starring-.*$/, ''),
        rawSlug.replace(/-at-the-.*$/, ''),
        rawSlug.replace(/-at-.*$/, ''),
        rawSlug.replace(/-directed-by-.*$/, ''),
        rawSlug.replace(/-by-.*$/, ''),
        // Strip leading performer name: "cynthia-erivo-in-dracula" → "dracula"
        rawSlug.replace(/^[a-z-]+-in-/, ''),
        // Strip composer: "andrew-lloyd-webbers-starlight-express" → "starlight-express"
        rawSlug.replace(/^[a-z-]+s-/, ''),
      ];
      const uniqueSlugs = [...new Set(cleanedSlugs)];

      let bestMatch = null;
      for (const slug of uniqueSlugs) {
        const titleFromSlug = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        const match = matchTitleToShow(titleFromSlug, weShows, { market: 'west-end' });
        if (match && match.show) { bestMatch = match; break; }
      }

      // Fallback: check if any show title words appear in raw slug
      if (!bestMatch) {
        for (const show of weShows) {
          const showWords = show.title.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
            .filter(w => w.length > 2);
          const slugLower = rawSlug.toLowerCase();
          const matchCount = showWords.filter(w => slugLower.includes(w)).length;
          if (matchCount >= Math.min(2, showWords.length) && matchCount > 0) {
            bestMatch = { show };
            break;
          }
        }
      }

      if (bestMatch && bestMatch.show && !_tsIndex.has(bestMatch.show.id)) {
        _tsIndex.set(bestMatch.show.id, url);
      }
    }

    console.log(`  [TS] Matched ${_tsIndex.size} shows to roundup URLs\n`);
  } catch (err) {
    console.log(`  [TS] Index build error: ${err.message.substring(0, 80)}`);
  }

  // Merge hardcoded known URLs (override if not already matched)
  for (const [showId, url] of Object.entries(TS_KNOWN_URLS)) {
    if (!_tsIndex.has(showId)) _tsIndex.set(showId, url);
  }

  return _tsIndex;
}

// ─── Stagedoor (archive only — Cloudflare blocks fetch, SERP can't help) ─────

async function sweepStagedoor(show) {
  const archivePath = path.join(ARCHIVE_BASE, 'stagedoor', `${show.id}.json`);
  if (!fs.existsSync(archivePath)) return [];

  try {
    const data = JSON.parse(fs.readFileSync(archivePath, 'utf8'));
    const sdReviews = data.criticReviews || [];
    return sdReviews.map(r => ({
      outlet: r.outlet || 'Unknown', outletId: normalizeOutlet(r.outlet || ''),
      critic: 'Unknown', stars: r.stars || null, starsOutOf: 5,
      excerpt: r.excerpt || '', url: '',
      source: 'stagedoor', scoreSource: r.stars ? 'stagedoor-star-rating' : undefined,
    }));
  } catch { return []; }
}

// ─── The Stage (cookies) ─────────────────────────────────────────────────────

// Shared BrowserBase session for The Stage (lazy-initialized)
let _bbPage = null;
let _bbBrowser = null;

async function getStagePageViaBrowserBase(url) {
  const BB_API_KEY = process.env.BROWSERBASE_API_KEY;
  const BB_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;
  if (!BB_API_KEY || !BB_PROJECT_ID) return null;

  const https = require('https');
  const { chromium } = require('playwright');

  // Lazy-init: create session + login once, reuse for all shows
  if (!_bbPage) {
    console.log('    [BB] Creating BrowserBase session...');
    const session = await new Promise((resolve, reject) => {
      const req = https.request('https://www.browserbase.com/v1/sessions', {
        method: 'POST',
        headers: { 'x-bb-api-key': BB_API_KEY, 'Content-Type': 'application/json' },
      }, (res) => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
      req.on('error', reject);
      req.end(JSON.stringify({ projectId: BB_PROJECT_ID, keepAlive: true, timeout: 1800, browserSettings: { solveCaptchas: true } }));
    });

    _bbBrowser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${BB_API_KEY}&sessionId=${session.id}`);
    const ctx = _bbBrowser.contexts()[0] || await _bbBrowser.newContext();
    _bbPage = ctx.pages()[0] || await ctx.newPage();

    // Inject Stage cookies instead of logging in (avoids session limit)
    const { loadCookiesForDomain } = require('./lib/cookie-loader');
    const stageCookies = loadCookiesForDomain('thestage.co.uk');
    if (stageCookies) {
      const pwCookies = stageCookies.map(c => ({
        name: c.name, value: c.value,
        domain: c.domain || '.thestage.co.uk',
        path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly,
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      }));
      await ctx.addCookies(pwCookies);
      console.log('    [BB] Stage cookies injected');
    } else {
      console.log('    [BB] No Stage cookies found — paywalled pages will be inaccessible');
    }
  }

  // Fetch the page
  try {
    await _bbPage.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await _bbPage.waitForTimeout(3000);
    return await _bbPage.content();
  } catch (err) {
    // Session may have died — reset so next call creates a new one
    console.log(`    [BB] Session error, resetting: ${err.message.substring(0, 80)}`);
    _bbPage = null;
    if (_bbBrowser) { try { await _bbBrowser.close(); } catch {} }
    _bbBrowser = null;
    return null;
  }
}

async function sweepTheStage(show) {
  const archDir = path.join(ARCHIVE_BASE, 'thestage-roundups');
  const archivePath = path.join(archDir, `${show.id}.html`);

  // Use archive if exists (skip expensive BB/SB calls)
  if (!FORCE && fs.existsSync(archivePath)) {
    const html = fs.readFileSync(archivePath, 'utf8');
    const reviews = extractStageReviews(html, show.id);
    if (reviews.length > 0) return reviews;
  }

  // Build URL candidates — index URL first (most reliable), then constructed, then SERP
  const urls = [];

  // Check the TS index for a discovered URL (from listing page)
  const indexUrl = _tsIndex ? _tsIndex.get(show.id) : null;
  if (indexUrl) urls.push(indexUrl);

  // Constructed URL candidates
  const titleSlug = show.title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/^-|-$/g, '');
  urls.push(`https://www.thestage.co.uk/review-round-ups/${titleSlug}-review-round-up`);
  if (show.venue) {
    const venueSlug = show.venue.toLowerCase()
      .replace(/\s*theatre\s*/gi, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
    if (venueSlug) {
      urls.push(`https://www.thestage.co.uk/review-round-ups/${titleSlug}-at-the-${venueSlug}-review-round-up`);
    }
  }

  // SERP discovery: find the actual URL if index + construction missed
  if (!indexUrl) {
    const serpUrl = await serpSearch('thestage.co.uk/review-round-ups', show.title);
    if (serpUrl && serpUrl.includes('review-round-up') && !urls.includes(serpUrl)) {
      urls.push(serpUrl);
    }
  }

  // Deduplicate
  const uniqueUrls = [...new Set(urls)];
  // Replace urls reference for the rest of the function
  const urlsToTry = uniqueUrls;

  // Try BrowserBase — ONLY for index-discovered URLs (saves BB sessions)
  // TS is paywalled so SB render can't help; BB with login is the only live path.
  // Constructed/SERP URLs waste BB page loads (they usually 404).
  if (process.env.BROWSERBASE_API_KEY && indexUrl) {
    // Only try the index URL via BB (known-good from listing page)
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const html = await getStagePageViaBrowserBase(indexUrl);
        if (!html || html.length < 2000) { console.log(`    [BB] Page too small (${html ? html.length : 0} bytes)`); break; }
        if (html.includes('Page not found') || html.includes('404 -')) { console.log('    [BB] Page not found'); break; }

        const reviews = extractStageReviews(html, show.id);
        if (reviews.length > 0) {
          if (!DRY_RUN) {
            if (!fs.existsSync(archDir)) fs.mkdirSync(archDir, { recursive: true });
            fs.writeFileSync(archivePath, html);
          }
          return reviews;
        }
        break;
      } catch (err) {
        console.log(`    TS BrowserBase error (attempt ${attempt + 1}): ${err.message.substring(0, 60)}`);
        if (attempt === 0 && !_bbPage) {
          console.log('    [BB] Retrying with new session...');
          continue;
        }
        break;
      }
    }
  }

  // Fallback: ScrapingBee render for ALL URL candidates
  // Works for non-paywalled roundup pages (some TS roundups are free)
  if (SB_KEY) {
    for (const url of urlsToTry) {
      console.log(`    [TS] Trying ScrapingBee render: ${url.split('/review-round-ups/')[1] || url}`);
      const html = await scrapingBeeRender(url);
      if (!html || html.length < 2000) continue;
      if (html.includes('Page not found') || html.includes('404 -')) continue;

      const reviews = extractStageReviews(html, show.id);
      if (reviews.length > 0) {
        if (!DRY_RUN) {
          if (!fs.existsSync(archDir)) fs.mkdirSync(archDir, { recursive: true });
          fs.writeFileSync(archivePath, html);
        }
        return reviews;
      }
    }
  }

  // Fallback: use existing archive
  if (fs.existsSync(archivePath)) {
    const html = fs.readFileSync(archivePath, 'utf8');
    const reviews = extractStageReviews(html, show.id);
    if (reviews.length > 0) return reviews;
  }

  return [];
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== WE Aggregator Sweep ===\n');
  console.log(`Aggregators: ${AGGREGATORS.join(', ')}`);
  console.log(`Dry run: ${DRY_RUN}\n`);

  // Clean cookie jar
  try { fs.unlinkSync(COOKIE_JAR); } catch {}

  const shows = loadShows();
  let weShows = shows.filter(s => isLondonMarket(s.category) && s.status === 'open');

  if (TARGET_SHOWS) {
    weShows = weShows.filter(s => TARGET_SHOWS.includes(s.id));
  }
  if (LIMIT) {
    weShows = weShows.slice(0, LIMIT);
  }

  console.log(`Processing ${weShows.length} open WE/OWE shows\n`);

  // Pre-build full indexes for aggregators that have category/listing pages
  if (AGGREGATORS.includes('tr')) {
    await _buildTRIndex(weShows);
  }
  if (AGGREGATORS.includes('ts')) {
    await _buildTSIndex(weShows);
  }

  for (let i = 0; i < weShows.length; i++) {
    const show = weShows[i];
    stats.shows++;
    console.log(`[${i + 1}/${weShows.length}] ${show.title} (${show.id})`);

    const results = { wet: [], tr: [], sd: [], ts: [] };

    try {
      if (AGGREGATORS.includes('wet')) {
        results.wet = await sweepWET(show);
        if (results.wet.length > 0) {
          stats.wet.found++;
          stats.wet.reviews += results.wet.length;
          console.log(`  WET: ${results.wet.length} reviews`);
          for (const r of results.wet) writeReview(r, show.id);
        } else {
          console.log('  WET: not found');
        }
        await sleep(1500);
      }

      if (AGGREGATORS.includes('tr')) {
        results.tr = await sweepTheatreReviews(show);
        if (results.tr.length > 0) {
          stats.tr.found++;
          stats.tr.reviews += results.tr.length;
          console.log(`  TR:  ${results.tr.length} reviews`);
          for (const r of results.tr) writeReview(r, show.id);
        } else {
          console.log('  TR:  not found');
        }
        await sleep(1500);
      }

      if (AGGREGATORS.includes('sd')) {
        results.sd = await sweepStagedoor(show);
        if (results.sd.length > 0) {
          stats.sd.found++;
          stats.sd.reviews += results.sd.length;
          console.log(`  SD:  ${results.sd.length} reviews`);
          for (const r of results.sd) writeReview(r, show.id);
        }
        // No sleep needed — local file read
      }

      if (AGGREGATORS.includes('ts')) {
        results.ts = await sweepTheStage(show);
        if (results.ts.length > 0) {
          stats.ts.found++;
          stats.ts.reviews += results.ts.length;
          console.log(`  TS:  ${results.ts.length} reviews`);
          for (const r of results.ts) writeReview(r, show.id);
        } else {
          console.log('  TS:  not found');
        }
        await sleep(1500);
      }
    } catch (err) {
      console.log(`  ERROR: ${err.message}`);
      stats.errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  Shows processed: ${stats.shows}`);
  console.log(`  WET: ${stats.wet.found} shows, ${stats.wet.reviews} reviews`);
  console.log(`  TR:  ${stats.tr.found} shows, ${stats.tr.reviews} reviews`);
  console.log(`  SD:  ${stats.sd.found} shows, ${stats.sd.reviews} reviews`);
  console.log(`  TS:  ${stats.ts.found} shows, ${stats.ts.reviews} reviews`);
  console.log(`  Errors: ${stats.errors}`);

  // Cleanup BrowserBase session if used
  if (_bbBrowser) {
    try { await _bbBrowser.close(); } catch {}
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
