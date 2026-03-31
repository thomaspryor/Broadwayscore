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
const https = require('https');
const cheerio = require('cheerio');
const { matchTitleToShow, loadShows } = require('./lib/show-matching');
const { normalizeOutlet, normalizeCritic, findExistingReviewFile } = require('./lib/review-normalization');
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

const stats = { pagesChecked: 0, reviewsExtracted: 0, filesCreated: 0, filesUpdated: 0, errors: 0 };

// ─── Browser Setup ───────────────────────────────────────────────────────────

async function launchBrowser() {
  if (BB_API_KEY && BB_PROJECT_ID) {
    console.log('  Using BrowserBase...');
    const sessionBody = JSON.stringify({
      projectId: BB_PROJECT_ID,
      browserSettings: { solveCaptchas: true },
    });
    const session = await new Promise((resolve, reject) => {
      const req = https.request('https://www.browserbase.com/v1/sessions', {
        method: 'POST',
        headers: { 'x-bb-api-key': BB_API_KEY, 'Content-Type': 'application/json' },
      }, (res) => {
        let d = '';
        res.on('data', c => d += c);
        res.on('end', () => resolve(JSON.parse(d)));
      });
      req.on('error', reject);
      req.end(sessionBody);
    });
    const connectUrl = `wss://connect.browserbase.com?apiKey=${BB_API_KEY}&sessionId=${session.id}`;
    const browser = await chromium.connectOverCDP(connectUrl);
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

/**
 * Extract reviews from a Stage roundup HTML.
 *
 * The Stage roundups are editorial prose. Critic references follow patterns:
 *   "Critic Name (link[Outlet, ★★★★])"  — outlet as link with stars
 *   "Critic Name (Outlet, ***)"          — plain text with ASCII stars
 *
 * Stars may be Unicode ★ (U+2605) or ASCII asterisks (*).
 * Link text sometimes includes leading `(` or trailing `)` from the parenthetical,
 * or the critic name may be captured inside the link text:
 *   "Critic Name (Outlet, ★★★★"  — opening paren before link, closing after
 *   "(Independent, ★★)"          — both parens inside link text
 *
 * Half-star ratings appear as "★★★★1/2" — counted as stars + 0.5.
 */
function extractReviews(html, showId) {
  const $ = cheerio.load(html);
  const reviews = [];
  const seen = new Set(); // dedup by outlet

  // Star character class: ASCII * or Unicode ★ (U+2605)
  // Regex to match link text containing "Outlet, <stars>" with optional surrounding parens/text
  // Handles: "Outlet, ★★★★", "(Outlet, ★★)", "Critic Name (Outlet, ★★★★",
  //          "The Stage, ***)", "Outlet, ★★★★1/2"
  const STAR_PATTERN = /(?:^|\()\s*(?:(?:[A-Z][a-z]+(?:\s+[A-Z][a-z']+(?:-[A-Z][a-z]+)?)*)\s*\()?\s*(?:the\s+)?(.+?),\s*([★*]{1,5})(?:1\/2)?\s*\)?\s*\.?$/;

  $('a[href]').each((_, el) => {
    const $a = $(el);
    const linkText = $a.text().trim();
    const href = $a.attr('href') || '';

    // Quick pre-filter: must contain at least one star character
    if (!linkText.includes('★') && !linkText.includes('*')) return;

    // Match star rating pattern in link text
    const starMatch = linkText.match(STAR_PATTERN);
    if (!starMatch) return;

    let outlet = starMatch[1].trim();
    const starChars = starMatch[2];
    const stars = starChars.length;
    // Detect half-star
    const hasHalf = /[★*]{1,5}1\/2/.test(linkText);

    // Clean up outlet name — remove leading "the ", "(", or other junk
    outlet = outlet.replace(/^\(+/, '').replace(/^the\s+/i, '').trim();

    // Fix known truncated outlet names from HTML rendering issues
    if (/^hatsOnStage$/i.test(outlet)) outlet = 'WhatsOnStage';

    // Skip bare star-only links with no outlet name
    if (!outlet || outlet.length < 1) return;

    // Skip if not a review URL
    if (!href.startsWith('http') && !href.startsWith('/')) return;
    const reviewUrl = href.startsWith('/') ? `https://www.thestage.co.uk${href}` : href;

    // Skip if we already have this outlet
    const outletId = normalizeOutlet(outlet);
    if (seen.has(outletId)) return;
    seen.add(outletId);

    // Extract critic name from surrounding HTML context
    // The pattern is: "Critic Name (" immediately before the <a> tag in the parent element
    const $parent = $a.closest('p');
    const parentHtml = $parent.html() || '';
    const parentText = $parent.text() || '';

    let critic = 'Unknown';

    // Strategy 1: Look at the HTML before this link for "Name (" pattern
    const linkHtml = $.html(el);
    const linkIdx = parentHtml.indexOf(linkHtml);
    if (linkIdx > 0) {
      // Get text content before this link by parsing the preceding HTML fragment
      const beforeHtml = parentHtml.substring(Math.max(0, linkIdx - 200), linkIdx);
      const beforeText = cheerio.load(`<p>${beforeHtml}</p>`)('p').text();

      // Match "Critic Name (" at the end of the preceding text
      // Handles: "writes Alice Saville (", "for Tim Bano (", "Dominic Cavendish ("
      // Use a non-capturing prefix to skip common prose words (for, and, but, etc.)
      const criticMatch = beforeText.match(
        /(?:^|[,;:]\s*|\.\s+|[""]\s*|[a-z]\s+)([A-Z][a-zé]+(?:['\u2019]?[A-Za-z]*)?(?:\s+(?:de\s+|van\s+|von\s+)?[A-Z][a-zé]+(?:-[A-Z][a-zé]+)?){1,3})\s*\(\s*$/
      );
      if (criticMatch) {
        critic = criticMatch[1].trim();
      }
    }

    // Clean up critic name — strip leading prose words captured by the regex
    // e.g. "For Clive Davis", "And Arifa Akbar", "But Tim Bano", "Only Martin Robinson"
    if (critic !== 'Unknown') {
      critic = critic.replace(/^(?:For|And|But|Only|While|As|Yet)\s+/i, '').trim();
    }

    // Strategy 2: If critic name was embedded in the link text itself
    // Pattern: "Critic Name (Outlet, ★★★★"
    if (critic === 'Unknown') {
      const embeddedCritic = linkText.match(
        /^([A-Z][a-zé]+(?:\s+[A-Z][a-zé]+(?:-[A-Z][a-zé]+)?){1,2})\s*\(/
      );
      if (embeddedCritic) {
        critic = embeddedCritic[1].trim();
      }
    }

    // Extract excerpt: the sentence/clause containing this critic reference
    let excerpt = '';
    const sentences = parentText.split(/(?<=[.!?])\s+/);
    for (const sent of sentences) {
      if (sent.includes(outlet) || (critic !== 'Unknown' && sent.includes(critic))) {
        // Clean up the sentence — remove parenthetical ratings (both Unicode and ASCII stars)
        excerpt = sent
          .replace(/\([^)]*[★*]{1,5}(?:1\/2)?\s*\)/g, '')
          .replace(/\s+/g, ' ')
          .trim();
        break;
      }
    }

    reviews.push({
      outlet,
      outletId,
      critic,
      stars: hasHalf ? stars + 0.5 : stars,
      starsOutOf: 5,
      excerpt: excerpt.substring(0, 500),
      url: reviewUrl,
      source: 'thestage-roundup',
    });
  });

  return reviews;
}

/**
 * Create or update review files from extracted reviews
 */
function writeReviewFiles(reviews, showId) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) fs.mkdirSync(showDir, { recursive: true });

  let created = 0, updated = 0;

  for (const review of reviews) {
    const criticSlug = normalizeCritic(review.critic);
    const outletId = review.outletId || normalizeOutlet(review.outlet);

    const existingMatch = findExistingReviewFile(showDir, outletId, criticSlug);
    const filePath = existingMatch ? existingMatch.path : path.join(showDir, `${outletId}--${criticSlug}.json`);

    let data = {};
    if (existingMatch && existingMatch.data) {
      data = existingMatch.data;
    }

    data.showId = data.showId || showId;
    data.outlet = data.outlet || review.outlet;
    data.outletId = data.outletId || outletId;
    data.criticName = data.criticName || review.critic;
    if (review.url && !data.url) data.url = review.url;
    if (review.excerpt) data.theStageExcerpt = review.excerpt;

    // Star rating from roundup — aggregator score, store as metadata only
    if (review.stars && !data.aggregatorStars) {
      data.aggregatorStars = `${review.stars}/${review.starsOutOf}`;
      data.scoreSource = 'thestage-roundup-star-rating';
    }

    if (!DRY_RUN) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      if (existingMatch) { updated++; } else { created++; }
    }
  }

  return { created, updated };
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

        const { created, updated } = writeReviewFiles(reviews, showId);
        stats.reviewsExtracted += reviews.length;
        stats.filesCreated += created;
        stats.filesUpdated += updated;
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

      const { created, updated } = writeReviewFiles(reviews, showId);
      stats.reviewsExtracted += reviews.length;
      stats.filesCreated += created;
      stats.filesUpdated += updated;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  Pages checked: ${stats.pagesChecked}`);
  console.log(`  Reviews extracted: ${stats.reviewsExtracted}`);
  console.log(`  Files created: ${stats.filesCreated}`);
  console.log(`  Files updated: ${stats.filesUpdated}`);
  console.log(`  Errors: ${stats.errors}`);
}

module.exports = { extractReviews };

if (require.main === module) {
  main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
