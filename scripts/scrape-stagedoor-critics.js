#!/usr/bin/env node
/**
 * Scrape Stagedoor critic reviews for West End shows
 *
 * Stagedoor (stagedoor.com) is the only structured multi-outlet WE critic
 * review aggregator. Each show has per-critic star ratings (1-5), one-line
 * excerpts, and outlet names. 10-15 critics per major show.
 *
 * Two-phase single-pass:
 * 1. Visit category listing pages to discover all show IDs + URLs
 * 2. Visit each show's /critic-reviews page to extract reviews
 *
 * Uses Playwright (Cloudflare blocks plain HTTP requests).
 * All URLs discovered from listings — never guessed.
 *
 * HTML structure (verified via Playwright MCP on Hamilton + Hadestown):
 *   - Review block: generic element with outlet name + "N out of 5 stars" aria + excerpt
 *   - Audience rating: "★ X.X / 5" in header link
 *
 * Usage:
 *   node scripts/scrape-stagedoor-critics.js [--show=SHOW_ID] [--limit=N] [--dry-run]
 *
 * Environment: Requires Playwright + Chromium installed
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { matchTitleToShow } = require('./lib/show-matching');
const { isLondonMarket } = require('./lib/venue-classification');

const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'aggregator-archive', 'stagedoor');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const RATE_LIMIT_MS = 3000;

// BrowserBase config (needed to bypass Cloudflare — headless Playwright is blocked)
const BB_API_KEY = process.env.BROWSERBASE_API_KEY;
const BB_PROJECT_ID = process.env.BROWSERBASE_PROJECT_ID;

// CLI args
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const limitArg = args.find(a => a.startsWith('--limit='));
const showLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;
const dryRun = args.includes('--dry-run');

// Stagedoor category pages to scrape for show discovery
const CATEGORY_PAGES = [
  '/musicals?t=5',
  '/plays?t=18',
  '/comedy?t=10',
  '/family-theatre?t=9',
  '/shakespeare?t=1',
  '/immersive-site-specific?t=3',
  '/dance?t=13',
  '/opera-ballet?t=4',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Phase A: Discover all shows from Stagedoor category listings
 */
async function discoverShows(page) {
  const allShows = new Map(); // keyed by stagedoor ID to dedup across categories

  for (const categoryPath of CATEGORY_PAGES) {
    const url = `https://stagedoor.com${categoryPath}`;
    console.log(`  Discovering: ${url}`);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await sleep(1000); // Let JS render

      // Scroll down to load more shows (category pages lazy-load on scroll)
      for (let scroll = 0; scroll < 10; scroll++) {
        const prevCount = await page.$$eval('a[href*="?p="]', els => els.length);
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(1500);
        const newCount = await page.$$eval('a[href*="?p="]', els => els.length);
        if (newCount === prevCount) break; // No more to load
      }

      const shows = await page.evaluate(() => {
        const links = document.querySelectorAll('a[href*="?p="]');
        const results = [];
        for (const link of links) {
          const href = link.getAttribute('href');
          const match = href.match(/^\/([\w-]+)\/([\d]+)-([\w-]+)\?p=\d+$/);
          if (match) {
            const textEls = link.querySelectorAll('div');
            const title = textEls[1]?.textContent?.trim() || textEls[0]?.textContent?.trim() || '';
            if (title) {
              results.push({
                category: match[1],
                id: parseInt(match[2]),
                slug: match[3],
                title,
              });
            }
          }
        }
        return results;
      });

      for (const show of shows) {
        if (!allShows.has(show.id)) {
          allShows.set(show.id, show);
        }
      }

      console.log(`    Found ${shows.length} shows (${allShows.size} unique total)`);
    } catch (e) {
      console.error(`    ⚠️  Failed to load ${url}: ${e.message}`);
    }

    await sleep(RATE_LIMIT_MS);
  }

  return Array.from(allShows.values());
}

// Known Stagedoor show IDs for shows that category listings don't surface.
// Discovered via manual site navigation + Google search (Mar 2026).
// Format: ourShowId → { category, id, slug }
const SD_KNOWN_SHOWS = {
  // Musicals
  'six-the-musical-west-end-2021': { category: 'musicals', id: 15640, slug: 'six' },
  'into-the-woods-west-end-2025': { category: 'musicals', id: 15368, slug: 'into-the-woods-15368' },
  'cabaret-at-the-kit-kat-club-west-end-2021': { category: 'musicals', id: 15642, slug: 'cabaret' },
  'titanique-west-end-2024': { category: 'musicals', id: 18295, slug: 'titanique-the-musical' },
  'operation-mincemeat-west-end-2024': { category: 'musicals', id: 13086, slug: 'operation-mincemeat' },
  'the-producers-west-end-2025': { category: 'musicals', id: 218, slug: 'the-producers' },
  'the-devil-wears-prada-west-end-2024': { category: 'musicals', id: 17973, slug: 'the-devil-wears-prada' },
  'kinky-boots-the-musical-west-end-2026': { category: 'musicals', id: 192, slug: 'kinky-boots' },
  // Plays
  'arcadia-west-end-2026': { category: 'plays', id: 18946, slug: 'arcadia' },
  'all-my-sons-west-end-2025': { category: 'plays', id: 6839, slug: 'all-my-sons' },
  'paranormal-activity-west-end-2025': { category: 'plays', id: 18945, slug: 'paranormal-activity' },
  'dracula-west-end-2025': { category: 'plays', id: 18829, slug: 'dracula' },
  'the-hunger-games-on-stage-west-end-2025': { category: 'plays', id: 18724, slug: 'the-hunger-games-on-stage' },
  'harry-potter-and-the-cursed-child-both-parts-west-end-2021': { category: 'family-theatre', id: 791, slug: 'harry-potter-and-the-cursed-child' },
  'broken-glass-west-end-2026': { category: 'plays', id: 19050, slug: 'broken-glass' },
  'evening-all-afternoon-west-end-2026': { category: 'plays', id: 19048, slug: 'evening-all-afternoon' },
  'the-holy-rosenbergs-west-end-2026': { category: 'plays', id: 19049, slug: 'the-holy-rosenbergs' },
  'shadowlands-west-end-2026': { category: 'plays', id: 19001, slug: 'shadowlands' },
  // Venue-specific
  'les-miserables-west-end-2021': { category: 'sondheim-theatre', id: 15639, slug: 'les-miserables' },
};

/**
 * Phase A.5: Fetch known Stagedoor shows not found in category listings.
 * Uses hardcoded IDs for shows that don't appear in category pages.
 */
async function fetchKnownMissingShows(page, alreadyFound, ourShows) {
  const foundIds = new Set(alreadyFound.map(s => s.ourShowId || ''));
  const toFetch = Object.entries(SD_KNOWN_SHOWS).filter(([showId]) => !foundIds.has(showId));

  if (toFetch.length === 0) return [];

  console.log(`\n  [SD] Fetching ${toFetch.length} known shows not in category listings...`);
  const found = [];

  for (const [ourShowId, sd] of toFetch) {
    const ourShow = ourShows.find(s => s.id === ourShowId);
    if (!ourShow) continue;

    // Construct the critic-reviews URL
    const url = sd.id > 0
      ? `https://stagedoor.com/${sd.category}/${sd.id}-${sd.slug}/critic-reviews`
      : `https://stagedoor.com/${sd.category}/${sd.slug}/critic-reviews`;

    console.log(`    Fetching: ${ourShow.title} → ${url}`);
    found.push({
      category: sd.category,
      id: sd.id,
      slug: sd.slug,
      title: ourShow.title,
      ourShowId,
      ourTitle: ourShow.title,
    });

    await sleep(500);
  }

  console.log(`  [SD] Added ${found.length} known shows\n`);
  return found;
}

/**
 * Phase B: Extract critic reviews from a show's critic-reviews page
 */
async function extractCriticReviews(page, show) {
  const url = `https://stagedoor.com/${show.category}/${show.id}-${show.slug}/critic-reviews`;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(1500); // Let content render

    const data = await page.evaluate(() => {
      // Stagedoor review cards have CSS class "snap-always" (carousel items).
      // Structure per card:
      //   <div class="snap-always ...">
      //     <div>Outlet Name</div>          ← no star images
      //     <div>                           ← contains star images + excerpt
      //       <div><span class="flex">[5 star imgs]</span></div>
      //       <div>Excerpt text</div>
      //     </div>
      //   </div>
      //
      // Filled stars: src contains "star-normal-icon" (not "empty")
      // Empty stars: src contains "star-normal-empty-icon" or has class "grayscale"

      const cards = document.querySelectorAll('[class*="snap-always"]');
      const reviews = [];

      for (const card of cards) {
        const children = Array.from(card.children);
        let outlet = null, stars = null, excerpt = null;

        for (const child of children) {
          if (!child.querySelector('img[alt="Star icon"]')) {
            // First child without stars = outlet name
            if (!outlet) outlet = child.textContent?.trim();
          } else {
            // Child with stars: count filled stars + extract excerpt
            const starImgs = child.querySelectorAll('img[alt="Star icon"]');
            stars = Array.from(starImgs).filter(img => {
              const src = img.getAttribute('src') || '';
              return src.includes('star-normal-icon') && !src.includes('empty');
            }).length;
            // Excerpt: text div that doesn't contain star images
            for (const sub of child.children) {
              if (!sub.querySelector('img[alt="Star icon"]')) {
                const t = sub.textContent?.trim();
                if (t && t.length > 10) excerpt = t;
              }
            }
          }
        }

        if (outlet && stars) {
          reviews.push({ outlet, stars, excerpt: excerpt || null });
        }
      }

      return { reviews };
    });

    return data.reviews;
  } catch (e) {
    console.error(`    ⚠️  Failed to load critic reviews: ${e.message}`);
    return [];
  }
}

async function main() {
  // Load our shows for matching
  const showsRaw = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const showsObj = showsRaw.shows || showsRaw;
  const ourShows = Object.values(showsObj).filter(s => s && s.id);

  console.log('🎭 Stagedoor Critic Review Scraper');
  console.log(`   Dry run: ${dryRun}`);
  console.log('');

  // Ensure archive directory exists
  if (!dryRun) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }

  // Use BrowserBase to bypass Cloudflare (headless Playwright is blocked)
  let browser, context, page;

  if (BB_API_KEY && BB_PROJECT_ID) {
    console.log('   Using BrowserBase (Cloudflare bypass)...');
    const sessionBody = JSON.stringify({
      projectId: BB_PROJECT_ID,
      keepAlive: true,
      timeout: 900,
      browserSettings: { solveCaptchas: true },
    });
    const session = await new Promise((resolve, reject) => {
      const req = https.request('https://www.browserbase.com/v1/sessions', {
        method: 'POST',
        headers: { 'x-bb-api-key': BB_API_KEY, 'Content-Type': 'application/json' },
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => res.statusCode < 300 ? resolve(JSON.parse(data)) : reject(new Error(`BB ${res.statusCode}: ${data}`)));
      });
      req.on('error', reject);
      req.end(sessionBody);
    });

    const connectUrl = `wss://connect.browserbase.com?apiKey=${BB_API_KEY}&sessionId=${session.id}`;
    console.log(`   Session: ${session.id.substring(0, 8)}...`);
    browser = await chromium.connectOverCDP(connectUrl);
    const contexts = browser.contexts();
    context = contexts[0] || await browser.newContext();
    page = await context.newPage();
  } else {
    console.log('   Using local Playwright (may be blocked by Cloudflare)...');
    browser = await chromium.launch({ headless: true });
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
    });
    page = await context.newPage();
  }

  try {
    // Accept cookies to prevent banner interference
    try {
      await page.goto('https://stagedoor.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
      const acceptBtn = page.locator('button:has-text("Accept")');
      if (await acceptBtn.isVisible({ timeout: 3000 })) {
        await acceptBtn.click();
        await sleep(500);
      }
    } catch { /* no cookie banner */ }

    // Phase A: Discover shows
    console.log('📡 Phase A: Discovering shows from listings...\n');
    const stagedoorShows = await discoverShows(page);
    console.log(`\n   Total discovered: ${stagedoorShows.length}\n`);

    // Match to our shows
    const matched = [];
    for (const sd of stagedoorShows) {
      const result = matchTitleToShow(sd.title, ourShows, { market: 'west-end' });
      if (result && result.show && result.confidence === 'high') {
        matched.push({
          ...sd,
          ourShowId: result.show.id,
          ourTitle: result.show.title,
          confidence: result.confidence,
        });
      } else if (result && result.show) {
        console.log(`  [LOW CONFIDENCE] "${sd.title}" → ${result.show.title} (${result.confidence}) — skipped`);
      }
    }

    console.log(`   Matched to our shows: ${matched.length}/${stagedoorShows.length}`);
    console.log('');

    // Phase A.5: Add known shows not found in category listings
    const searchResults = await fetchKnownMissingShows(page, matched, ourShows);
    for (const sr of searchResults) {
      matched.push(sr);
    }

    // Log matches for human review
    console.log('   Match results:');
    for (const m of matched) {
      const flag = m.title.toLowerCase() !== m.ourTitle.toLowerCase() ? ' ⚠️ ' : '  ✓ ';
      console.log(`   ${flag} "${m.title}" → ${m.ourShowId} (${m.confidence || 'search'})`);
    }
    console.log('');

    // Apply filters
    let toProcess = matched;
    if (showFilter) {
      toProcess = matched.filter(m => m.ourShowId === showFilter);
      if (toProcess.length === 0) {
        console.error(`❌ Show not found in Stagedoor matches: ${showFilter}`);
        process.exit(1);
      }
    }
    if (showLimit) {
      toProcess = toProcess.slice(0, showLimit);
    }

    // Phase B: Extract critic reviews
    console.log(`📰 Phase B: Extracting critic reviews for ${toProcess.length} shows...\n`);

    const stats = { processed: 0, withReviews: 0, totalReviews: 0, empty: 0 };
    // Load previous counts for health gate
    let previousTotalReviews = 0;
    try {
      const existingFiles = fs.readdirSync(ARCHIVE_DIR).filter(f => f.endsWith('.json'));
      for (const f of existingFiles) {
        const data = JSON.parse(fs.readFileSync(path.join(ARCHIVE_DIR, f), 'utf8'));
        previousTotalReviews += (data.criticReviews || []).length;
      }
    } catch { /* first run */ }

    for (let i = 0; i < toProcess.length; i++) {
      const show = toProcess[i];
      stats.processed++;

      console.log(`[${i + 1}/${toProcess.length}] ${show.title} (${show.ourShowId})`);

      const reviews = await extractCriticReviews(page, show);

      if (reviews.length === 0) {
        console.log(`  ⏭️  No critic reviews`);
        stats.empty++;
      } else {
        console.log(`  ✅ ${reviews.length} critic reviews:`);
        for (const r of reviews) {
          console.log(`     ${r.stars}/5 — ${r.outlet}: "${(r.excerpt || '').slice(0, 60)}..."`);
        }
        stats.withReviews++;
        stats.totalReviews += reviews.length;

        if (!dryRun) {
          const archiveData = {
            stagedoorId: show.id,
            stagedoorUrl: `/${show.category}/${show.id}-${show.slug}/critic-reviews`,
            title: show.title,
            ourShowId: show.ourShowId,
            criticReviews: reviews,
            fetchedAt: new Date().toISOString().slice(0, 10),
          };

          const archivePath = path.join(ARCHIVE_DIR, `${show.ourShowId}.json`);
          fs.writeFileSync(archivePath, JSON.stringify(archiveData, null, 2) + '\n');
        }
      }

      if (i < toProcess.length - 1) await sleep(RATE_LIMIT_MS);
    }

    // Health gate: abort if reviews dropped significantly (only for full runs)
    if (!showLimit && !showFilter && previousTotalReviews > 0 && stats.totalReviews < previousTotalReviews * 0.5) {
      console.error(`\n❌ HEALTH GATE: Total reviews (${stats.totalReviews}) < 50% of previous (${previousTotalReviews}). Possible HTML structure change.`);
      process.exit(1);
    }

    console.log('\n─── Summary ───');
    console.log(`  Processed:     ${stats.processed}`);
    console.log(`  With reviews:  ${stats.withReviews}`);
    console.log(`  Total reviews: ${stats.totalReviews}`);
    console.log(`  No reviews:    ${stats.empty}`);

    if (stats.withReviews === 0 && toProcess.length > 3) {
      console.error('\n❌ ZERO shows had critic reviews — possible scraper breakage.');
      process.exit(1);
    }

  } finally {
    await browser.close();
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
