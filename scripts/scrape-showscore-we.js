#!/usr/bin/env node
/**
 * Scrape ShowScore London/West End critic reviews and create review-text files
 *
 * Uses Playwright to visit each WE show's ShowScore page,
 * extracts critic reviews (outlet, critic, star rating, excerpt, URL),
 * deduplicates against existing review-text files, and creates new entries.
 *
 * Usage: node scripts/scrape-showscore-we.js [--dry-run] [--show=SHOW_ID]
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { resolveOutletFromCritic, resolveOutletFromUrl } = require('./lib/review-normalization');
const { isLondonMarket } = require('./lib/venue-classification');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const SS_DATA_PATH = '/tmp/showscore-we-data.json';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SINGLE_SHOW = args.find(a => a.startsWith('--show='))?.split('=')[1];

// Map our show IDs to ShowScore slugs
const SHOW_TO_SS_SLUG = {
  'hadestown-west-end-2024': 'hadestown-west-end',
  'hamilton-west-end-2021': 'hamilton-london',
  'les-miserables-west-end-2021': 'les-miserables-london',
  'six-the-musical-west-end-2021': 'six-west-end',
  'the-book-of-mormon-west-end-2024': 'the-book-of-mormon-london',
  'harry-potter-and-the-cursed-child-both-parts-west-end-2021': 'harry-potter-and-the-cursed-child-london',
  'wicked-west-end-2024': 'wicked-london',
  'the-lion-king-west-end-2021': 'the-lion-king-london',
  'the-play-that-goes-wrong-west-end-2021': 'the-play-that-goes-wrong-london',
  'mamma-mia-west-end-2021': 'mamma-mia-london',
  'the-mousetrap-west-end-2021': 'the-mousetrap-london',
  'the-phantom-of-the-opera-west-end-1986': 'the-phantom-of-the-opera-london',
  'moulin-rouge-the-musical-west-end-2021': 'moulin-rouge-the-musical-london',
  'back-to-the-future-west-end-2021': 'back-to-the-future-london',
  'stranger-things-the-first-shadow-west-end-2023': 'stranger-things-the-first-shadow',
  'the-spy-who-came-in-from-the-cold-west-end-2025': 'the-spy-who-came-in-from-the-cold-west-end',
  'showstopper-the-improvised-musical-west-end-2023': 'showstopper-the-improvised-musical-london',
  'marie-and-rosetta-west-end-2026': 'marie-rosetta-west-end',
  'the-unlikely-pilgrimage-of-harold-fry-west-end-2026': 'the-unlikely-pilgrimage-of-harold-fry-west-end',
  'im-sorry-prime-minister-west-end-2026': 'i-m-sorry-prime-minister-west-end',
  'woman-in-mind-west-end-2025': 'woman-in-mind-west-end',
  'high-noon-west-end-2025': 'high-noon-west-end',
  'oliver-west-end-2024': 'oliver-west-end',
  'my-neighbour-totoro-west-end-2025': 'my-neighbour-totoro-west-end',
  'paddington-the-musical-west-end-2025': 'paddington-the-musical-west-end',
  'paranormal-activity-west-end-2025': 'paranormal-activity-west-end',
  'all-my-sons-west-end-2025': 'all-my-sons-west-end',
  'oh-mary-west-end-2025': 'oh-mary-west-end',
  'mj-the-musical-west-end-2024': 'mj-the-musical-west-end',
  'the-devil-wears-prada-west-end-2024': 'the-devil-wears-prada-west-end',
  'matilda-the-musical-west-end-2021': 'matilda-the-musical-west-end',
  'the-producers-west-end-2025': 'the-producers-west-end',
  'shadowlands-west-end-2026': 'shadowlands-west-end',
  'the-boy-who-harnessed-the-wind-west-end-2026': 'the-boy-who-harnessed-the-wind-west-end',
  'cyrano-de-bergerac-west-end-2026': 'cyrano-de-bergerac-west-end',
  'austentatious-an-improvised-jane-austen-novel-west-end-2025': 'austentatious-an-improvised-jane-austen-novel',
  'cabaret-at-the-kit-kat-club-west-end-2021': 'cabaret-at-the-kit-kat-club-london',
  'the-choir-of-man-west-end-2024': 'choir-of-man-west-end',
  'hercules-west-end-2025': 'hercules-west-end',
  'dracula-west-end-2025': 'dracula-west-end',
  'titanique-west-end-2024': 'titanique-west-end',
  'operation-mincemeat-west-end-2024': 'operation-mincemeat-west-end',
  // Shows not on ShowScore
  'murder-she-didnt-write-west-end-2025': null,
  'magic-mike-live-west-end-2021': null,
  'garry-starr-classic-penguins-garrick-west-end-2025': null,
  'black-is-the-color-of-my-voice-west-end-2025': null,
  'the-gruffalo-west-end-2023': 'the-gruffalo-west-end',
};

// Map ShowScore outlet names to our outlet IDs
function outletNameToId(name) {
  const map = {
    'London Theatre': 'london-theatre',
    'BroadwayWorld': 'broadwayworld',
    'The London Evening Standard': 'evening-standard',
    'The Guardian (UK)': 'the-guardian-uk',
    'Time Out London': 'time-out-london',
    'The Telegraph (UK)': 'the-telegraph-uk',
    'The Times (UK)': 'the-times-uk',
    'The Stage (UK)': 'the-stage-uk',
    'The Independent (UK)': 'the-independent-uk',
    'Theatre Weekly (UK)': 'theatre-weekly',
    'WhatsOnStage': 'whatsonstage',
    'Lost in Theatreland (UK)': 'lost-in-theatreland',
    'Starburst Magazine': 'starburst-magazine',
    'Everything Theatre (UK)': 'everything-theatre',
    'The Arts Desk': 'the-arts-desk',
    'Theatre and Tonic (UK)': 'theatre-and-tonic',
    'The Observer': 'the-observer',
    'iNews': 'inews',
    'Daily Mail (UK)': 'daily-mail-uk',
    'The Spectator': 'the-spectator',
    'Financial Times': 'financial-times',
    'London Theatre Reviews': 'london-theatre-reviews',
    'Musical Theatre Review': 'musical-theatre-review',
    'West End Best Friend': 'west-end-best-friend',
    'Exeunt Magazine': 'exeunt-magazine',
    'A Younger Theatre': 'a-younger-theatre',
    'Culture Whisper': 'culture-whisper',
    'British Theatre Guide': 'british-theatre-guide',
    'The Reviews Hub': 'the-reviews-hub',
    'LondonTheatre1': 'london-theatre-1',
    'Gay Times': 'gay-times',
    'Attitude Magazine': 'attitude-magazine',
    'Pocket Size Theatre': 'pocket-size-theatre',
    'The Upcoming': 'the-upcoming',
    'Love London Love Culture': 'love-london-love-culture',
    'The Play\'s The Thing': 'the-plays-the-thing',
    'Fairy Powered Productions': 'fairy-powered-productions',
    'Theatre Cat': 'theatre-cat',
    'London Box Office': 'london-box-office',
    'Daily Express (UK)': 'daily-express',
    'Metro (UK)': 'metro-uk',
  };
  if (map[name]) return map[name];
  // Fallback: slugify the name
  return name.toLowerCase()
    .replace(/[()]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  // "December 15th, 2023" → "2023-12-15"
  const cleaned = dateStr.replace(/(\d+)(st|nd|rd|th)/, '$1');
  const d = new Date(cleaned);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

function starRatingToScore(rating) {
  // ShowScore CSS variables --rating and --gaps represent the star count
  // Modern reviews: 1-5 scale. Older reviews: already on 0-100 scale (e.g., 80/80)
  if (!rating) return null;
  if (rating > 5) {
    // Already on a percentage scale (e.g., 80 = 80%)
    return Math.min(100, Math.round(rating));
  }
  return Math.round((rating / 5) * 100);
}

// Get all existing URLs for a show
function getExistingUrls(showId) {
  const urls = new Set();
  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) return urls;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (d.url) urls.add(d.url);
      // Also check normalized URL (without trailing slash, without www)
      if (d.url) {
        const norm = d.url.replace(/\/$/, '').replace(/^https?:\/\/www\./, 'https://');
        urls.add(norm);
      }
    } catch (e) {}
  }
  return urls;
}

function normalizeUrl(url) {
  if (!url) return null;
  return url.replace(/\/$/, '').replace(/^https?:\/\/www\./, 'https://');
}

// Extract reviews from HTML using JSDOM (for paginated responses)
function extractReviewsFromHtml(html) {
  const dom = new JSDOM('<div>' + html + '</div>');
  const doc = dom.window.document;
  return extractReviewTiles(doc);
}

function extractReviewTiles(doc) {
  const tiles = doc.querySelectorAll('.review-tile-v2.-critic');
  const reviews = [];

  for (const tile of tiles) {
    const review = {};

    // Outlet name from image alt
    const outletImg = tile.querySelector('.user-avatar-v2 img');
    review.outlet = outletImg ? (outletImg.getAttribute('alt') || null) : null;

    // Date
    const dateEl = tile.querySelector('.review-tile-v2__date');
    review.date = dateEl ? dateEl.textContent.trim() : null;

    // Critic name
    const authorEl = tile.querySelector('.review-tile-v2__authors a');
    review.critic = authorEl ? authorEl.textContent.trim() : null;

    // Star rating from CSS variable --rating and --gaps
    const starsEl = tile.querySelector('.review-tile-v2__stars');
    if (starsEl) {
      const style = starsEl.getAttribute('style') || '';
      const ratingMatch = style.match(/--rating:\s*([\d.]+)/);
      const gapsMatch = style.match(/--gaps:\s*([\d.]+)/);
      review.starRating = ratingMatch ? parseFloat(ratingMatch[1]) : null;
      review.starMax = gapsMatch ? parseInt(gapsMatch[1]) : null;
    }

    // Excerpt
    const excerptEl = tile.querySelector('.review-tile-v2__review p');
    if (excerptEl) {
      let text = excerptEl.textContent.trim();
      text = text.replace(/Read more\s*$/i, '').trim();
      review.excerpt = text || null;
    }

    // Review URL
    const reviewLink = tile.querySelector('.review-tile-v2__review a[href*="http"]');
    review.url = reviewLink ? reviewLink.getAttribute('href') : null;

    // Review ID
    const tileId = tile.id;
    review.ssReviewId = tileId ? tileId.replace('critic_review_', '') : null;

    if (review.outlet || review.critic) {
      reviews.push(review);
    }
  }

  return reviews;
}

async function scrapeShowPage(page, ssSlug) {
  const url = `https://www.show-score.com/uk/london/west-end-shows/${ssSlug}`;
  console.log(`  Loading: ${url}`);

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(2000);

  // Extract page 1 reviews from DOM
  const page1Data = await page.evaluate(() => {
    const reviews = [];
    const tiles = document.querySelectorAll('.review-tile-v2.-critic');

    for (const tile of tiles) {
      const review = {};
      const outletImg = tile.querySelector('.user-avatar-v2 img');
      review.outlet = outletImg ? (outletImg.getAttribute('alt') || null) : null;

      const dateEl = tile.querySelector('.review-tile-v2__date');
      review.date = dateEl ? dateEl.textContent.trim() : null;

      const authorEl = tile.querySelector('.review-tile-v2__authors a');
      review.critic = authorEl ? authorEl.textContent.trim() : null;

      const starsEl = tile.querySelector('.review-tile-v2__stars');
      if (starsEl) {
        const style = starsEl.getAttribute('style') || '';
        const rm = style.match(/--rating:\s*([\d.]+)/);
        const gm = style.match(/--gaps:\s*([\d.]+)/);
        review.starRating = rm ? parseFloat(rm[1]) : null;
        review.starMax = gm ? parseInt(gm[1]) : null;
      }

      const excerptEl = tile.querySelector('.review-tile-v2__review p');
      if (excerptEl) {
        let text = excerptEl.textContent.trim();
        text = text.replace(/Read more\s*$/i, '').trim();
        review.excerpt = text || null;
      }

      const reviewLink = tile.querySelector('.review-tile-v2__review a[href*="http"]');
      review.url = reviewLink ? reviewLink.getAttribute('href') : null;

      const tileId = tile.id;
      review.ssReviewId = tileId ? tileId.replace('critic_review_', '') : null;

      if (review.outlet || review.critic) reviews.push(review);
    }

    // Check for pagination
    const container = document.querySelector('.js-show-page-v2__critic-reviews');
    let paginatePath = null;
    let totalCount = null;
    if (container) {
      paginatePath = container.getAttribute('data-next-page-path');
      totalCount = parseInt(container.getAttribute('data-total-count') || '0');
    }

    // Get critic count from heading
    const heading = Array.from(document.querySelectorAll('h2')).find(h => h.textContent.includes('Critic Reviews'));
    const headingCount = heading ? parseInt((heading.textContent.match(/\((\d+)\)/) || [])[1] || '0') : 0;

    return {
      reviews,
      paginatePath,
      totalCount: totalCount || headingCount,
      displayedCount: reviews.length
    };
  });

  let allReviews = [...page1Data.reviews];

  // Fetch remaining pages if needed
  if (page1Data.paginatePath && page1Data.displayedCount < page1Data.totalCount) {
    let pageNum = 2;
    let hasMore = true;
    while (hasMore && pageNum < 10) { // Safety limit
      try {
        const moreData = await page.evaluate(async (opts) => {
          const resp = await fetch(`${opts.pagePath}?page=${opts.pg}`, {
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
          });
          if (!resp.ok) return { html: '', hasMore: false };
          const json = await resp.json();
          return { html: json.html || '', hasMore: !!json.has_next_page };
        }, { pagePath: page1Data.paginatePath, pg: pageNum });

        if (moreData.html) {
          // Parse HTML response using JSDOM (server-side)
          const dom = new JSDOM('<div>' + moreData.html + '</div>');
          const doc = dom.window.document;
          const tiles = doc.querySelectorAll('.review-tile-v2.-critic');

          for (const tile of tiles) {
            const review = {};
            const outletImg = tile.querySelector('.user-avatar-v2 img');
            review.outlet = outletImg ? (outletImg.getAttribute('alt') || null) : null;

            const dateEl = tile.querySelector('.review-tile-v2__date');
            review.date = dateEl ? dateEl.textContent.trim() : null;

            const authorEl = tile.querySelector('.review-tile-v2__authors a');
            review.critic = authorEl ? authorEl.textContent.trim() : null;

            const starsEl = tile.querySelector('.review-tile-v2__stars');
            if (starsEl) {
              const style = starsEl.getAttribute('style') || '';
              const rm = style.match(/--rating:\s*([\d.]+)/);
              const gm = style.match(/--gaps:\s*([\d.]+)/);
              review.starRating = rm ? parseFloat(rm[1]) : null;
              review.starMax = gm ? parseInt(gm[1]) : null;
            }

            const excerptEl = tile.querySelector('.review-tile-v2__review p');
            if (excerptEl) {
              let text = excerptEl.textContent.trim();
              text = text.replace(/Read more\s*$/i, '').trim();
              review.excerpt = text || null;
            }

            const reviewLink = tile.querySelector('.review-tile-v2__review a[href*="http"]');
            review.url = reviewLink ? reviewLink.getAttribute('href') : null;

            const tileId = tile.id;
            review.ssReviewId = tileId ? tileId.replace('critic_review_', '') : null;

            if (review.outlet || review.critic) allReviews.push(review);
          }
        }

        hasMore = moreData.hasMore;
        pageNum++;
      } catch (e) {
        console.log(`    Pagination error page ${pageNum}: ${e.message}`);
        hasMore = false;
      }
    }
  }

  console.log(`  Found ${allReviews.length}/${page1Data.totalCount} critic reviews`);
  return allReviews;
}

function createReviewFile(showId, review) {
  // Resolve outlet if null — try critic registry, then URL domain
  let outletName = review.outlet;
  if (!outletName && review.critic) {
    const resolved = resolveOutletFromCritic(review.critic);
    if (resolved) {
      outletName = resolved.displayName;
      console.log(`    Resolved outlet from critic "${review.critic}": ${outletName}${resolved.isFreelancer ? ' (freelancer)' : ''}`);
    }
  }
  if (!outletName && review.url) {
    const urlResolved = resolveOutletFromUrl(review.url);
    if (urlResolved) {
      outletName = urlResolved.displayName;
      console.log(`    Resolved outlet from URL: ${outletName}`);
    }
  }
  if (!outletName) {
    if (review.critic) {
      console.warn(`    WARNING: Could not resolve outlet for critic "${review.critic}" — using "unknown"`);
    }
    outletName = 'unknown';
  }

  const outletId = outletNameToId(outletName);
  const criticSlug = (review.critic || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const filename = `${outletId}--${criticSlug}.json`;
  const filePath = path.join(REVIEW_TEXTS_DIR, showId, filename);

  const score = starRatingToScore(review.starRating);
  const publishDate = parseDate(review.date);

  const data = {
    showId,
    outlet: outletName !== 'unknown' ? outletName : null,
    outletId,
    criticName: review.critic || null,
    url: review.url || null,
    urlSource: 'show-score',
    source: 'show-score',
    showScoreExcerpt: review.excerpt || null,
    publishDate,
    // Aggregator scores go to aggregatorStars, never originalScore
    originalScore: null,
    aggregatorStars: review.starRating
      ? (review.starRating > 5 ? `${review.starRating}/100` : `${review.starRating}/5`)
      : null,
    scoreSource: score ? 'show-score-stars' : null,
    assignedScore: score,
    confidence: score ? 'high' : null,
    contentTier: 'excerpt',
    ssReviewId: review.ssReviewId || null,
    fetchedAt: new Date().toISOString(),
    fetchMethod: 'showscore-scrape',
  };

  const dir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  return { filePath, filename };
}

async function main() {
  console.log('=== ShowScore West End Critic Review Scraper ===\n');
  if (DRY_RUN) console.log('*** DRY RUN — no files will be written ***\n');

  // Load our shows
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const weShows = shows.shows.filter(s => isLondonMarket(s.category));
  console.log(`Our WE shows: ${weShows.length}\n`);

  // Load ShowScore data
  let ssData = [];
  if (fs.existsSync(SS_DATA_PATH)) {
    ssData = JSON.parse(fs.readFileSync(SS_DATA_PATH, 'utf8'));
    console.log(`ShowScore WE shows: ${ssData.length}`);
    console.log(`Shows with critic reviews: ${ssData.filter(s => s.criticReviews > 0).length}\n`);
  } else {
    console.log('WARNING: No ShowScore data at', SS_DATA_PATH);
    console.log('Run the ShowScore listing scraper first.\n');
  }

  // Build reverse map: SS slug → our show ID
  const ssSlugToShowId = {};
  for (const [showId, ssSlug] of Object.entries(SHOW_TO_SS_SLUG)) {
    if (ssSlug) ssSlugToShowId[ssSlug] = showId;
  }

  // Also try auto-matching for any unmapped shows
  for (const show of weShows) {
    if (SHOW_TO_SS_SLUG[show.id] !== undefined) continue; // Already mapped (including null = not on SS)
    // Try to match by title similarity
    const normTitle = show.title.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    for (const ss of ssData) {
      const ssTitle = (ss.title || ss.slug).toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
      if (ssTitle === normTitle || ssTitle.includes(normTitle) || normTitle.includes(ssTitle)) {
        if (!ssSlugToShowId[ss.slug]) {
          ssSlugToShowId[ss.slug] = show.id;
          console.log(`  Auto-matched: ${show.id} → ${ss.slug}`);
        }
        break;
      }
    }
  }

  // Filter to shows with critic reviews
  const showsToScrape = [];
  for (const ss of ssData) {
    if (ss.criticReviews <= 0) continue;
    const showId = ssSlugToShowId[ss.slug];
    if (!showId) {
      console.log(`  UNMAPPED: ${ss.slug} (${ss.criticReviews} reviews) — no matching show ID`);
      continue;
    }
    if (SINGLE_SHOW && showId !== SINGLE_SHOW) continue;
    showsToScrape.push({ showId, ssSlug: ss.slug, expectedCount: ss.criticReviews });
  }

  console.log(`\nShows to scrape: ${showsToScrape.length}\n`);

  if (showsToScrape.length === 0) {
    console.log('Nothing to scrape.');
    return;
  }

  // Launch browser
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();

  let totalNew = 0, totalSkipped = 0, totalErrors = 0;

  for (let i = 0; i < showsToScrape.length; i++) {
    const { showId, ssSlug, expectedCount } = showsToScrape[i];
    console.log(`\n[${i + 1}/${showsToScrape.length}] ${showId} (expect ~${expectedCount} reviews)`);

    // Get existing URLs for this show
    const existingUrls = getExistingUrls(showId);

    try {
      const reviews = await scrapeShowPage(page, ssSlug);
      let newCount = 0, skipCount = 0;

      for (const review of reviews) {
        // Dedup by URL
        if (review.url) {
          const normUrl = normalizeUrl(review.url);
          if (existingUrls.has(review.url) || existingUrls.has(normUrl)) {
            skipCount++;
            continue;
          }
        }

        // Dedup by outlet+critic combo (for reviews without URLs)
        if (!review.url) {
          const outletId = outletNameToId(review.outlet || 'unknown');
          const criticSlug = (review.critic || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '-');
          const checkPath = path.join(REVIEW_TEXTS_DIR, showId, `${outletId}--${criticSlug}.json`);
          if (fs.existsSync(checkPath)) {
            skipCount++;
            continue;
          }
        }

        if (!DRY_RUN) {
          const { filename } = createReviewFile(showId, review);
          console.log(`    NEW: ${filename} (${review.starRating}/${review.starMax} stars)`);
        } else {
          console.log(`    [DRY] Would create: ${review.outlet} — ${review.critic} (${review.starRating}/${review.starMax})`);
        }
        newCount++;
      }

      console.log(`  Result: ${newCount} new, ${skipCount} duplicates skipped`);
      totalNew += newCount;
      totalSkipped += skipCount;

    } catch (e) {
      console.log(`  ERROR: ${e.message}`);
      totalErrors++;
    }

    // Rate limiting
    if (i < showsToScrape.length - 1) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  await browser.close();

  console.log('\n=== Summary ===');
  console.log(`New reviews created: ${totalNew}`);
  console.log(`Duplicates skipped: ${totalSkipped}`);
  console.log(`Errors: ${totalErrors}`);
  if (DRY_RUN) console.log('\n*** DRY RUN — no files were actually written ***');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
