#!/usr/bin/env node
/**
 * Scrape The Stage review round-up pages for West End shows
 *
 * The Stage (thestage.co.uk) publishes editorial review round-ups behind a
 * subscriber paywall. Each roundup compiles 6-12 critics with star ratings,
 * outlet names, review URLs, and extended excerpts woven into editorial prose.
 *
 * Two-phase:
 * 1. Playwright (BrowserBase in CI) to log in + fetch JS-rendered HTML
 * 2. Cheerio extraction from archived HTML
 *
 * Star ratings in link text: "Outlet, ★★★" or "Outlet, ****" (Unicode ★ or ASCII *)
 * Critic names inline in prose before parenthetical outlet reference
 *
 * URL pattern: /review-round-ups/{slug}-review-round-up
 * Discovery: /review-round-ups/review-round-ups (category listing)
 *
 * Usage:
 *   node scripts/scrape-thestage-roundups.js [--shows=X,Y,Z] [--dry-run] [--force] [--extract-only]
 *
 * Environment: COOKIES_BUNDLE_* (or THESTAGE_COOKIES env, or data/cookies/thestage.json)
 *              BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID (optional, for CI)
 */

const fs = require('fs');
const path = require('path');
const { matchTitleToShow, loadShows, buildSiblingCategoriesFromShows } = require('./lib/show-matching');
const { checkArchiveCategory, readCachedArchiveIfValid } = require('./lib/archive-cache-guard');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { filterToLiveShowIds, loadLiveShowIds } = require('./lib/live-show-ids');
const { resolveArchiveRowOutletId } = require('./lib/archive-outlet-identity');
const { checkAggregatorPageProduction } = require('./lib/aggregator-page-production');
const { isLondonMarket } = require('./lib/venue-classification');
const { fetchWithCookiesPlain } = require('./lib/fetch-plain');
const { discoverRoundupUrlsPlain, classifyRoundupPage, LOGIN_EXPIRED_MESSAGE } = require('./lib/thestage-fetch');

// Memoized sibling-category index (same shape as scrape-bww-reviews.js) so
// checkArchiveCategory()'s cross-market-sibling check can fire (BRO-2550).
let _siblingCategoriesCache = null;
function siblingCategoriesByShowId() {
  if (_siblingCategoriesCache) return _siblingCategoriesCache;
  _siblingCategoriesCache = buildSiblingCategoriesFromShows(loadShows());
  return _siblingCategoriesCache;
}

const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'aggregator-archive', 'thestage-roundups');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const RATE_LIMIT_MS = 3000;

// BrowserBase config
const BB_API_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

// CLI args
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const EXTRACT_ONLY = process.argv.includes('--extract-only');
// Legacy Browserbase/Playwright route. Off by default: the cookie-plain route
// needs no browser session (BRO-6101). Manual use only.
const USE_BROWSER = process.argv.includes('--browser');
const showsArg = process.argv.find(a => a.startsWith('--shows='));
const TARGET_SHOWS = showsArg ? showsArg.split('=')[1].split(',') : null;

const stats = { pagesChecked: 0, cached: 0, reviewsExtracted: 0, filesCreated: 0, filesUpdated: 0, filesSkipped: 0, errors: 0, fetchErrors: 0 };

// ─── Browser Setup ───────────────────────────────────────────────────────────

async function launchBrowser() {
  const { chromium } = require('playwright');
  if (BB_API_KEY && BB_PROJECT_ID) {
    console.log('  Using BrowserBase...');
    const { createBbSession } = require('./lib/browserbase-session');
    const session = await createBbSession({
      caller: 'scrape-thestage-roundups.js',
      purpose: 'The Stage review round-up login + fetch',
      host: 'thestage.co.uk',
      category: 'discovery',
      body: { browserSettings: { solveCaptchas: true } },
    });
    const browser = await chromium.connectOverCDP(session.connectUrl);
    const context = browser.contexts()[0] || await browser.newContext();
    const page = context.pages()[0] || await context.newPage();
    return { browser, context, page, isBB: true };
  }

  console.log('  Using local Playwright...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
  });
  const page = await context.newPage();
  return { browser, context, page, isBB: false };
}

// ─── The Stage Login ─────────────────────────────────────────────────────────

async function loginToTheStage(page) {
  // Cookie-only auth (cookie-loader: bundles → env → local file)
  // No email/password login — avoids creating new sessions that trigger session limit warnings
  const { loadCookiesForDomain } = require('./lib/cookie-loader');
  const cookies = loadCookiesForDomain('thestage.co.uk');
  if (cookies) {
    console.log(`  Loading Stage cookies (${cookies.length} cookies)...`);
    const pwCookies = cookies.map(c => ({
      name: c.name, value: c.value,
      domain: c.domain || '.thestage.co.uk',
      path: c.path || '/', secure: c.secure !== false, httpOnly: !!c.httpOnly,
      ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    }));
    await page.context().addCookies(pwCookies);

    // Verify cookies work by loading an actual paywalled roundup page
    await page.goto('https://www.thestage.co.uk/review-round-ups/broken-glass-at-the-young-vic-review-round-up', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(3000);
    const html = await page.content();
    const hasStars = html.includes('★') || /\*{2,5}/.test(html);
    const hasPaywall = html.includes('create a free account') || html.includes('Subscribe to continue');
    if (hasStars && !hasPaywall) {
      console.log('  ✓ Cookie auth verified (stars visible, no paywall)');
      return true;
    }
    console.log('  ⚠ Cookies did not bypass paywall — cookies may be expired');
    return false;
  }

  // No cookies available (not in bundle, env, or local file)
  console.log('  ✗ No Stage cookies found (check COOKIES_BUNDLE or data/cookies/thestage.json)');
  return false;
}

// ─── Discovery ───────────────────────────────────────────────────────────────

async function discoverRoundupUrls(page) {
  const urls = [];
  const seen = new Set();

  console.log('\n--- Discovering roundup URLs ---');

  // Navigate to the roundups category listing
  await page.goto('https://www.thestage.co.uk/review-round-ups/review-round-ups', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  await page.waitForTimeout(2000);

  // Extract all roundup links from the listing page
  const links = await page.$$eval('a[href*="/review-round-ups/"]', (anchors) => {
    return anchors.map(a => ({
      href: a.href,
      text: a.textContent.trim(),
    })).filter(l =>
      l.href.includes('/review-round-ups/') &&
      !l.href.endsWith('/review-round-ups') &&
      !l.href.includes('/review-round-ups/review-round-ups') &&
      l.href.includes('-review-round-up')
    );
  });

  for (const link of links) {
    if (!seen.has(link.href)) {
      seen.add(link.href);
      urls.push(link.href);
    }
  }

  // Try to load more / paginate if available
  let loadMoreAttempts = 0;
  while (loadMoreAttempts < 10) {
    const loadMore = await page.$('button:has-text("Load More"), a:has-text("Load More"), button:has-text("Show More")');
    if (!loadMore) break;
    const visible = await loadMore.isVisible().catch(() => false);
    if (!visible) break;

    await loadMore.click();
    await page.waitForTimeout(3000);
    loadMoreAttempts++;

    const newLinks = await page.$$eval('a[href*="/review-round-ups/"]', (anchors) => {
      return anchors.map(a => a.href).filter(h =>
        h.includes('-review-round-up') &&
        !h.endsWith('/review-round-ups') &&
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
    console.log(`  Load more #${loadMoreAttempts}: ${added} new (${urls.length} total)`);
    if (added === 0) break;
  }

  console.log(`  Discovered ${urls.length} roundup URLs\n`);
  return urls;
}

// ─── Scrape Phase (Playwright) ───────────────────────────────────────────────

async function scrapeRoundups(fetchHtml, urls, weShows) {
  const matched = [];

  for (const url of urls) {
    // Extract title from URL slug
    // Newer slugs carry a venue after the marker: <title>-review-round-up-<venue>.
    const slug = url.match(/review-round-ups\/(.+?)(?:-review-round-up(?:-.*)?)?\/?$/)?.[1] || '';
    const title = slug
      .replace(/-starring-.*$/, '')
      .replace(/-at-the-.*$/, '').replace(/-at-.*$/, '')
      .split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

    if (!title) continue;

    const match = matchTitleToShow(title, weShows, { market: 'west-end' });
    if (!match || !match.show) continue;
    if (match.confidence !== 'high') {
      console.log(`  [LOW CONFIDENCE] "${title}" → ${match.show.title} (${match.confidence}) — skipped`);
      continue;
    }
    if (TARGET_SHOWS && !TARGET_SHOWS.includes(match.show.id)) continue;

    const showId = match.show.id;
    const archivePath = path.join(ARCHIVE_DIR, `${showId}.html`);

    // Skip if already archived (unless --force)
    // A cached file is re-validated; a poisoned one is purged and refetched (BRO-2550).
    const cached = !FORCE ? readCachedArchiveIfValid(archivePath, Infinity, match.show, siblingCategoriesByShowId()[showId]) : null;
    if (cached && !cached.valid) console.log(`  [PURGED] ${match.show.title}: cached archive failed ${cached.check.reason}`);
    if (cached && cached.valid) {
      // BRO-6089: a poisoned cache must not outlive the page-date guard below.
      const cprod = checkAggregatorPageProduction({ html: cached.html, show: match.show });
      if (cprod.outOfRun) {
        console.log(`  [WRONG PRODUCTION] ${match.show.title}: cached archive ${cprod.reason}`);
        if (!DRY_RUN) { try { fs.renameSync(archivePath, archivePath + '.mismatch'); } catch { /* gone */ } }
        stats.errors++;
        continue;
      }
      console.log(`  [CACHED] ${match.show.title}`);
      matched.push({ showId, show: match.show, archivePath });
      stats.cached++;
      continue;
    }

    console.log(`  Fetching: ${match.show.title} → ${url}`);
    try {
      let html;
      try {
        html = await fetchHtml(url);
      } catch (fetchErr) {
        stats.fetchErrors++;
        throw fetchErr;
      }
      // Dead login first: the registration gate has its own page title, so the
      // category guard below would otherwise hide it as a plain skip.
      const extractedRows = extractReviews(html, showId);
      if (extractedRows.length === 0 && classifyRoundupPage(html, 0) === 'gated') {
        const e = new Error(LOGIN_EXPIRED_MESSAGE);
        e.loginExpired = true;
        throw e;
      }

      // Validate page title matches the show before archiving — Stuart King 2026-04-25
      const v = checkArchiveCategory(html, match.show, siblingCategoriesByShowId()[match.show.id]);
      if (!v.ok) {
        console.log(`    ✗ archive guard (${v.reason}): "${(v.pageTitle||'').substring(0,60)}" — skipped`);
        stats.errors++;
        continue;
      }

      // BRO-6089: the slug has no date, so a same-title revival's round-up passes
      // the title-only guard. Drop pages dated outside this show's run.
      const prod = checkAggregatorPageProduction({ html, show: match.show });
      if (prod.outOfRun) {
        console.log(`    ✗ wrong production (${prod.reason}) — not archiving`);
        stats.errors++;
        continue;
      }

      if (extractedRows.length === 0) {
        const kind = classifyRoundupPage(html, 0);
        console.log(`    ✗ 0 extractable rows (${kind === 'challenge' ? 'bot challenge' : 'template drift'}) — not archiving`);
        stats.errors++;
        continue;
      }
      // Never archive a page with no extractable rows — a title-valid PAYWALLED
      // teaser (expired cookies) otherwise lands as a 0-row archive that the
      // gap-audit's thestage-archive reference reads as emptyParse every hour
      // (QA review 2026-07-11). Skipping (not caching) means a later run with
      // working cookies still gets to archive the real page.

      if (!DRY_RUN) {
        fs.writeFileSync(archivePath, html);
      }

      matched.push({ showId, show: match.show, archivePath });
      stats.pagesChecked++;

      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    } catch (err) {
      if (err.loginExpired) throw err; // dead cookies: stop, every later page would be gated too
      console.log(`    ✗ Error: ${err.message}`);
      stats.errors++;
    }
  }

  return matched;
}

// ─── Extraction Phase (Cheerio) ──────────────────────────────────────────────

// The pure cheerio extractor lives in lib/ so the review census can union The
// Stage WITHOUT loading playwright (required at the top of this file). CLAUDE.md
// §15 extraction pattern: single source of truth, re-exported here.
const { extractReviews } = require('./lib/thestage-extract');

/**
 * Create or update review files from extracted reviews
 */
function writeReviewFiles(reviews, showId, reviewTextsDir = REVIEW_TEXTS_DIR) {
  let created = 0, updated = 0, skipped = 0;

  for (const review of reviews) {
    const outletId = resolveArchiveRowOutletId({ url: review.url, outletLabel: review.outlet, cachedOutletId: review.outletId, sourceOutletId: 'thestage' });

    const fields = {};
    if (review.excerpt) fields.theStageExcerpt = review.excerpt;
    // Star rating from roundup — aggregator score, store as metadata only
    if (review.stars) {
      fields.aggregatorStars = `${review.stars}/${review.starsOutOf}`;
      fields.scoreSource = 'thestage-roundup-star-rating';
    }

    const result = createOrMergeReviewFile(showId, {
      outlet: review.outlet,
      outletId,
      criticName: review.critic,
      url: review.url,
      source: review.source || 'thestage-roundup',
      fields,
    }, {
      dryRun: DRY_RUN,
      reviewTextsDir,
      onMerge(existing) {
        // Upgrade critic name if incoming has one and existing is 'Unknown' —
        // same pattern as scrape-london-box-office-roundups.js's saveLBOReview.
        if (review.critic && review.critic !== 'Unknown' && (!existing.criticName || existing.criticName === 'Unknown')) {
          existing.criticName = review.critic;
        }
      },
    });

    if (result.action === 'new') created++;
    else if (result.action === 'updated') updated++;
    else if (result.action === 'skipped') skipped++;
  }

  return { created, updated, skipped };
}

// ─── Main ────────────────────────────────────────────────────────────────────

function extractMatched(matched) {
  for (const { showId, archivePath } of matched) {
    if (!fs.existsSync(archivePath)) continue;
    const html = fs.readFileSync(archivePath, 'utf8');
    const reviews = extractReviews(html, showId);
    console.log(`  ${showId}: ${reviews.length} reviews`);

    const { created, updated, skipped } = writeReviewFiles(reviews, showId);
    stats.reviewsExtracted += reviews.length;
    stats.filesCreated += created;
    stats.filesUpdated += updated;
    stats.filesSkipped += skipped;
  }
}

async function main() {
  console.log('=== The Stage Review Round-Ups Scraper ===\n');

  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const shows = loadShows();
  const weShows = shows.filter(s => isLondonMarket(s.category));
  console.log(`Loaded ${weShows.length} London market shows\n`);

  if (!EXTRACT_ONLY && !USE_BROWSER) {
    // Phase 1: public sitemaps for discovery, saved cookies over plain HTTPS
    // for the pages. No Browserbase session, no page navigation to time out.
    const { loadCookiesForDomain } = require('./lib/cookie-loader');
    if (!loadCookiesForDomain('thestage.co.uk')) {
      console.error('✗ No Stage cookies found (COOKIES_BUNDLE_* / data/cookies/thestage.json). Only the Mac renews them.');
      process.exit(1);
    }
    const urls = await discoverRoundupUrlsPlain();
    if (urls.length === 0) {
      console.error('✗ Found no roundup URLs in the sitemaps or the listing page (site change or blocked).');
      process.exit(1);
    }
    const fetchHtml = async (url) => {
      const res = await fetchWithCookiesPlain(url);
      if (!res || typeof res.content !== 'string') throw new Error('plain fetch failed');
      return res.content;
    };
    let matched;
    try {
      matched = await scrapeRoundups(fetchHtml, urls, weShows);
    } catch (err) {
      if (!err.loginExpired) throw err;
      console.error(`❌ ${err.message}`);
      process.exit(2);
    }
    console.log(`\nScraped ${matched.length} roundup pages\n`);
    extractMatched(matched);
  } else if (!EXTRACT_ONLY) {
    // Legacy browser route (--browser), kept for manual recovery only.
    const { browser, page } = await launchBrowser();
    try {
      const loggedIn = await loginToTheStage(page);
      if (!loggedIn) {
        console.log('✗ Login failed — aborting');
        await browser.close();
        process.exit(1);
      }
      const urls = await discoverRoundupUrls(page);
      const fetchHtml = async (url) => {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
        return page.content();
      };
      let matched;
      try {
        matched = await scrapeRoundups(fetchHtml, urls, weShows);
      } catch (err) {
        if (!err.loginExpired) throw err;
        console.error(`❌ ${err.message}`);
        process.exitCode = 2;
        return;
      }
      console.log(`\nScraped ${matched.length} roundup pages\n`);
      extractMatched(matched);
    } finally {
      await browser.close();
    }
  } else {
    // Extract-only mode: process existing archives
    console.log('Extract-only mode: processing existing archives\n');
    const files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.html'));
    const liveShowIds = loadLiveShowIds();
    for (const f of files) {
      const showId = f.replace('.html', '');
      if (TARGET_SHOWS && !TARGET_SHOWS.includes(showId)) continue;
      // BRO-5288: an archive page under an id shows.json does not have writes nothing.
      if (filterToLiveShowIds([showId], liveShowIds).dropped.length) {
        console.log(`  ${showId}: skipped, not in shows.json`);
        continue;
      }
      const html = fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8');
      const reviews = extractReviews(html, showId);
      console.log(`  ${showId}: ${reviews.length} reviews`);

      const { created, updated, skipped } = writeReviewFiles(reviews, showId);
      stats.reviewsExtracted += reviews.length;
      stats.filesCreated += created;
      stats.filesUpdated += updated;
      stats.filesSkipped += skipped;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  Pages checked: ${stats.pagesChecked} (cached: ${stats.cached})`);
  console.log(`  Reviews extracted: ${stats.reviewsExtracted}`);
  console.log(`  Files created: ${stats.filesCreated}`);
  console.log(`  Files updated: ${stats.filesUpdated}`);
  console.log(`  Files skipped (guard-rejected): ${stats.filesSkipped}`);
  console.log(`  Errors: ${stats.errors}`);

  const zeroData = zeroDataFailure({
    pagesChecked: stats.pagesChecked, cached: stats.cached, reviewsExtracted: stats.reviewsExtracted,
    targetShows: TARGET_SHOWS, extractOnly: EXTRACT_ONLY, fetchErrors: stats.fetchErrors,
  });
  if (zeroData) {
    console.error(`❌ ${zeroData} Failing.`);
    process.exit(1);
  }
}

// Zero-data guard (BRO-5288). A full run that neither fetched nor found a
// cached roundup could not reach The Stage; cached roundups prove discovery
// worked. --extract-only never fetches, so there the signal is whether any
// review came out of the archives. Targeted runs are exempt.
// Returns the failure message, or null.
function zeroDataFailure({ pagesChecked, cached, reviewsExtracted, targetShows, extractOnly, fetchErrors = 0 }) {
  if (targetShows) return null;
  // Every fetch failed (403 / challenge): cached archives must not hide it.
  if (!extractOnly && fetchErrors > 0 && pagesChecked === 0) {
    return `Every Stage page fetch failed (${fetchErrors} errors, 0 pages fetched): blocked or challenged.`;
  }
  if (extractOnly) {
    return reviewsExtracted === 0 ? 'ZERO reviews extracted from the archived roundups (archive missing or template drift).' : null;
  }
  return pagesChecked + cached === 0 ? 'ZERO roundup pages fetched or found cached from The Stage (likely blocked or site change).' : null;
}

module.exports = { extractReviews, writeReviewFiles, zeroDataFailure };

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
