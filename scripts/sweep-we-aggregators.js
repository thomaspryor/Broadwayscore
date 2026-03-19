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
const { isLondonMarket } = require('./lib/venue-classification');

// Reuse extraction functions from existing scrapers
const { extractStarRatings, extractSectionReviews, extractShowTitle, fetchRenderedPage } = require('./scrape-westendtheatre-roundups');
const { extractReviews: extractTheatreReviews } = require('./scrape-theatre-reviews');
const { extractReviews: extractStageReviews } = require('./scrape-thestage-roundups');

// SERP for per-show aggregator discovery
const { discoverCorrectUrl } = require('./lib/url-discovery');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const ARCHIVE_BASE = path.join(__dirname, '..', 'data', 'aggregator-archive');
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
async function serpSearch(site, showTitle) {
  if (!SB_KEY && !BD_KEY) return null;
  const query = `site:${site} "${showTitle}" review`;

  // Try ScrapingBee first (structured JSON)
  if (SB_KEY) {
    try {
      const axios = require('axios');
      const resp = await axios.get('https://app.scrapingbee.com/api/v1/store/google', {
        params: { api_key: SB_KEY, search: query },
        timeout: 15000,
      });
      const results = resp.data?.organic_results || resp.data?.results || [];
      if (results.length > 0) return results[0].url || results[0].link;
    } catch {}
  }

  // Fallback: BrightData SERP
  if (BD_KEY) {
    try {
      const https = require('https');
      const body = JSON.stringify({ query: { q: query, gl: 'uk' } });
      const resp = await new Promise((resolve, reject) => {
        const req = https.request(`https://api.brightdata.com/serp/req?customer=hl_a2c64a47&zone=serp_api1`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${BD_KEY}`, 'Content-Type': 'application/json' },
        }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve(JSON.parse(d))); });
        req.on('error', reject);
        req.end(body);
      });
      // BD SERP is async — poll for result
      if (resp.response_id) {
        for (let i = 0; i < 10; i++) {
          await sleep(2000);
          const poll = await new Promise((resolve) => {
            https.get(`https://api.brightdata.com/serp/get_result?response_id=${resp.response_id}`, {
              headers: { Authorization: `Bearer ${BD_KEY}` },
            }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch { resolve(null); } }); }).on('error', () => resolve(null));
          });
          if (poll?.organic) {
            const first = poll.organic[0];
            if (first?.link) return first.link;
            break;
          }
        }
      }
    } catch {}
  }

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

  let data = existingMatch && existingMatch.data ? existingMatch.data : {};

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

  // Star rating → P0 score (only if we don't already have one)
  if (review.stars && !data.originalScore) {
    data.originalScore = `${review.stars}/${review.starsOutOf || 5}`;
    data.originalScoreNormalized = Math.round((review.stars / (review.starsOutOf || 5)) * 100);
    data.scoreSource = review.scoreSource || `${review.source}-star-rating`;
  }

  if (!DRY_RUN) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
  }
  return !!existingMatch;
}

// ─── WestEndTheatre (WP API) ────────────────────────────────────────────────

async function sweepWET(show) {
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
    const posts = curlJson(apiUrl);
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
          source: 'westendtheatre', scoreSource: 'westendtheatre-star-rating',
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

    if (reviews.length > 0) return reviews;
  }
  return [];
}

// ─── theatre.reviews (full index + per-show match) ───────────────────────────

// Lazy-loaded full index of theatre.reviews roundup URLs
let _trIndex = null; // Map<showId, url>

/**
 * Build a full index of theatre.reviews roundup URLs by paginating the
 * category archive and matching each URL to our shows.
 */
async function _buildTRIndex(weShows) {
  if (_trIndex) return _trIndex;
  _trIndex = new Map();

  console.log('\n  [TR] Building full theatre.reviews index...');
  const { discoverRoundupUrls, extractTitleFromSlug } = require('./scrape-theatre-reviews');

  // Paginate all category pages to get every roundup URL
  const allUrls = await discoverRoundupUrls();
  console.log(`  [TR] ${allUrls.length} roundup URLs discovered`);

  // Match each URL to our shows — use title-contains as fallback
  for (const url of allUrls) {
    const titleFromSlug = extractTitleFromSlug(url);
    if (!titleFromSlug) continue;

    // Try standard matching first
    let match = matchTitleToShow(titleFromSlug, weShows, { market: 'west-end' });

    // Fallback: check if any show title appears in the slug
    if (!match || !match.show) {
      for (const show of weShows) {
        const showLower = show.title.toLowerCase();
        const slugLower = titleFromSlug.toLowerCase();
        if (slugLower.includes(showLower) || showLower.includes(slugLower)) {
          match = { show };
          break;
        }
      }
    }

    if (match && match.show && !_trIndex.has(match.show.id)) {
      _trIndex.set(match.show.id, url);
    }
  }

  console.log(`  [TR] Matched ${_trIndex.size} shows to roundup URLs\n`);
  return _trIndex;
}

async function sweepTheatreReviews(show) {
  const archDir = path.join(ARCHIVE_BASE, 'theatre-reviews');
  const archivePath = path.join(archDir, `${show.id}.html`);

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

  // Try each URL: nodeFetch first (free), then ScrapingBee render (costs credits)
  for (const url of uniqueUrls) {
    let html = await nodeFetch(url);

    // ScrapingBee render fallback for CleanTalk-blocked pages
    if (!html && SB_KEY) {
      console.log(`    [TR] nodeFetch blocked, trying ScrapingBee for ${url.split('/reviews-roundup/')[1] || url}`);
      html = await scrapingBeeRender(url);
    }

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
      req.end(JSON.stringify({ projectId: BB_PROJECT_ID, browserSettings: { solveCaptchas: true } }));
    });

    _bbBrowser = await chromium.connectOverCDP(`wss://connect.browserbase.com?apiKey=${BB_API_KEY}&sessionId=${session.id}`);
    const ctx = _bbBrowser.contexts()[0] || await _bbBrowser.newContext();
    _bbPage = ctx.pages()[0] || await ctx.newPage();

    // Login to The Stage
    const email = process.env.THESTAGE_EMAIL;
    const password = process.env.THESTAGE_PASSWORD;
    if (email && password) {
      console.log('    [BB] Logging in to The Stage...');
      await _bbPage.goto('https://www.thestage.co.uk/review-round-ups/review-round-ups', { waitUntil: 'networkidle', timeout: 30000 });
      await _bbPage.waitForTimeout(8000);
      await _bbPage.waitForSelector('input[name="email"]', { timeout: 10000 }).catch(() => {});
      const emailInputs = await _bbPage.$$('input[name="email"]');
      let emailInput = null;
      for (const inp of emailInputs) { if (await inp.isVisible().catch(() => false)) { emailInput = inp; break; } }
      if (emailInput) {
        await emailInput.type(email, { delay: 30 });
        const passInputs = await _bbPage.$$('input[type="password"]');
        for (const inp of passInputs) {
          if (await inp.isVisible().catch(() => false)) { await inp.type(password, { delay: 30 }); break; }
        }
        const btn = await _bbPage.$('button:has-text("Login"), input[type="submit"]');
        if (btn && await btn.isVisible().catch(() => false)) await btn.click();
        else await _bbPage.keyboard.press('Enter');
        await _bbPage.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
        await _bbPage.waitForTimeout(3000);
        console.log('    [BB] Login complete');
      }
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

  // Build URL candidates
  const titleSlug = show.title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').replace(/^-|-$/g, '');
  const urls = [`https://www.thestage.co.uk/review-round-ups/${titleSlug}-review-round-up`];
  if (show.venue) {
    const venueSlug = show.venue.toLowerCase()
      .replace(/\s*theatre\s*/gi, '').replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
    if (venueSlug) {
      urls.unshift(`https://www.thestage.co.uk/review-round-ups/${titleSlug}-at-the-${venueSlug}-review-round-up`);
    }
  }

  // SERP discovery: find the actual URL if URL construction missed
  const serpUrl = await serpSearch('thestage.co.uk/review-round-ups', show.title);
  if (serpUrl && serpUrl.includes('review-round-up') && !urls.includes(serpUrl)) {
    urls.push(serpUrl);
  }

  // Try BrowserBase if available (The Stage is JS-rendered + paywalled)
  if (process.env.BROWSERBASE_API_KEY) {
    for (const url of urls) {
      // Retry once on session death
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const html = await getStagePageViaBrowserBase(url);
          if (!html || html.length < 2000) break; // URL is bad, try next URL
          if (html.includes('Page not found') || html.includes('404 -')) break;

          const reviews = extractStageReviews(html, show.id);
          if (reviews.length > 0) {
            if (!DRY_RUN) {
              if (!fs.existsSync(archDir)) fs.mkdirSync(archDir, { recursive: true });
              fs.writeFileSync(archivePath, html);
            }
            return reviews;
          }
          break; // Page fetched but no reviews — try next URL
        } catch (err) {
          console.log(`    TS BrowserBase error (attempt ${attempt + 1}): ${err.message}`);
          if (attempt === 0 && !_bbPage) {
            console.log('    [BB] Retrying with new session...');
            continue; // Session was reset in getStagePageViaBrowserBase, retry
          }
          break;
        }
      }
    }
  }

  // Fallback: ScrapingBee render (when BrowserBase unavailable or failed)
  if (SB_KEY) {
    for (const url of urls) {
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
