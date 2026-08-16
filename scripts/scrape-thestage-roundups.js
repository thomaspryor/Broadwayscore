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

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { matchTitleToShow, loadShows, validateRoundupPageTitle } = require('./lib/show-matching');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { resolveArchiveRowOutletId } = require('./lib/archive-outlet-identity');
const { isLondonMarket } = require('./lib/venue-classification');

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
const showsArg = process.argv.find(a => a.startsWith('--shows='));
const TARGET_SHOWS = showsArg ? showsArg.split('=')[1].split(',') : null;

const stats = { pagesChecked: 0, reviewsExtracted: 0, filesCreated: 0, filesUpdated: 0, filesSkipped: 0, errors: 0 };

// ─── Browser Setup ───────────────────────────────────────────────────────────

async function launchBrowser() {
  if (BB_API_KEY && BB_PROJECT_ID) {
    console.log('  Using BrowserBase...');
    const { createBbSession } = require('./lib/browserbase-session');
    const session = await createBbSession({
      caller: 'scrape-thestage-roundups.js',
      purpose: 'The Stage review round-up login + fetch',
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
      waitUntil: 'networkidle', timeout: 30000,
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
    waitUntil: 'networkidle', timeout: 30000,
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

async function scrapeRoundups(page, urls, weShows) {
  const matched = [];

  for (const url of urls) {
    // Extract title from URL slug
    const slug = url.match(/review-round-ups\/(.+?)(?:-review-round-up)?\/?$/)?.[1] || '';
    const title = slug
      .replace(/-review-round-up$/, '')
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
    if (!FORCE && fs.existsSync(archivePath)) {
      console.log(`  [CACHED] ${match.show.title}`);
      matched.push({ showId, show: match.show, archivePath });
      continue;
    }

    console.log(`  Fetching: ${match.show.title} → ${url}`);
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(2000);

      const html = await page.content();

      // Validate page title matches the show before archiving — Stuart King 2026-04-25
      const v = validateRoundupPageTitle(html, match.show.title);
      if (!v.ok) {
        console.log(`    ✗ page-title mismatch (${v.reason}): "${(v.pageTitle||'').substring(0,60)}" — skipped`);
        stats.errors++;
        continue;
      }

      // Never archive a page with no extractable rows — a title-valid PAYWALLED
      // teaser (expired cookies) otherwise lands as a 0-row archive that the
      // gap-audit's thestage-archive reference reads as emptyParse every hour
      // (QA review 2026-07-11). Skipping (not caching) means a later run with
      // working cookies still gets to archive the real page.
      const extractedRows = extractReviews(html, showId);
      if (extractedRows.length === 0) {
        console.log(`    ✗ 0 extractable rows (paywalled teaser or template drift) — not archiving`);
        stats.errors++;
        continue;
      }

      if (!DRY_RUN) {
        fs.writeFileSync(archivePath, html);
      }

      matched.push({ showId, show: match.show, archivePath });
      stats.pagesChecked++;

      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    } catch (err) {
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

async function main() {
  console.log('=== The Stage Review Round-Ups Scraper ===\n');

  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const shows = loadShows();
  const weShows = shows.filter(s => isLondonMarket(s.category));
  console.log(`Loaded ${weShows.length} London market shows\n`);

  if (!EXTRACT_ONLY) {
    // Phase 1: Scrape with Playwright
    const { browser, page } = await launchBrowser();

    try {
      const loggedIn = await loginToTheStage(page);
      if (!loggedIn) {
        console.log('✗ Login failed — aborting');
        await browser.close();
        process.exit(1);
      }

      const urls = await discoverRoundupUrls(page);

      const matched = await scrapeRoundups(page, urls, weShows);
      console.log(`\nScraped ${matched.length} roundup pages\n`);

      // Phase 2: Extract from archives
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
    } finally {
      await browser.close();
    }
  } else {
    // Extract-only mode: process existing archives
    console.log('Extract-only mode: processing existing archives\n');
    const files = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.html'));
    for (const f of files) {
      const showId = f.replace('.html', '');
      if (TARGET_SHOWS && !TARGET_SHOWS.includes(showId)) continue;
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
  console.log(`  Pages checked: ${stats.pagesChecked}`);
  console.log(`  Reviews extracted: ${stats.reviewsExtracted}`);
  console.log(`  Files created: ${stats.filesCreated}`);
  console.log(`  Files updated: ${stats.filesUpdated}`);
  console.log(`  Files skipped (guard-rejected): ${stats.filesSkipped}`);
  console.log(`  Errors: ${stats.errors}`);

  // Zero-data guard: if no pages were checked, the scraper couldn't reach The Stage
  if (stats.pagesChecked === 0 && !TARGET_SHOWS) {
    console.error('❌ ZERO pages checked from The Stage — likely blocked or site change. Failing.');
    process.exit(1);
  }
}

module.exports = { extractReviews, writeReviewFiles };

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
