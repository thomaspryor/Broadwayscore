#!/usr/bin/env node
/**
 * Scrape theatre.reviews roundup pages for West End shows
 *
 * theatre.reviews is a handcrafted WE review aggregator with per-outlet
 * star ratings (1-5), critic names, excerpts, and links to full reviews.
 * 10+ reviews per show, static HTML, no JS rendering needed.
 *
 * URL pattern: https://theatre.reviews/reviews-roundup/{title-slug}-{venue-slug}-reviews/
 * Discovery: category page at /category/reviews-roundup/ (10 per page)
 *   + SERP fallback: site:theatre.reviews "reviews roundup" "{show title}"
 *
 * HTML structure (WordPress, verified Mar 2026):
 *   - Each review is a <p> with <strong>Outlet Name</strong> + star chars (⭑) + excerpt + <a> link
 *   - Star ratings are unicode ⭑ characters (count them)
 *   - Average rating in header as "X.X⭑"
 *
 * Usage:
 *   node scripts/scrape-theatre-reviews.js [--shows=X,Y,Z] [--dry-run] [--force]
 *
 * Output: Archives to data/aggregator-archive/theatre-reviews/{show-id}.html
 *         Creates review files in data/review-texts/{show-id}/
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');
const { matchTitleToShow, loadShows } = require('./lib/show-matching');
const { normalizeOutlet, normalizeCritic, findExistingReviewFile } = require('./lib/review-normalization');
const { isLondonMarket } = require('./lib/venue-classification');

const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'aggregator-archive', 'theatre-reviews');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');
const showsArg = process.argv.find(a => a.startsWith('--shows='));
const TARGET_SHOWS = showsArg ? showsArg.split('=')[1].split(',') : null;

// Stats
const stats = { pagesChecked: 0, reviewsExtracted: 0, filesCreated: 0, filesUpdated: 0, errors: 0 };

/**
 * Fetch a URL via plain HTTPS (no API key needed — static HTML site)
 */
function fetchPage(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchPage(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

/**
 * Discover roundup URLs from the category page
 */
async function discoverRoundupUrls() {
  const urls = [];
  const html = await fetchPage('https://theatre.reviews/category/reviews-roundup/');
  if (!html) return urls;

  const $ = cheerio.load(html);
  $('a[href*="reviews-roundup"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href && href.includes('/reviews-roundup/') && !urls.includes(href)) {
      urls.push(href.startsWith('http') ? href : `https://theatre.reviews${href}`);
    }
  });

  console.log(`Discovered ${urls.length} roundup URLs from category page`);
  return urls;
}

/**
 * Extract show title from a roundup URL slug
 * e.g., "into-the-woods-bridge-reviews" → "Into the Woods"
 */
function extractTitleFromSlug(url) {
  const match = url.match(/reviews-roundup\/(.+?)\/?\s*$/);
  if (!match) return null;
  let slug = match[1]
    .replace(/-reviews$/, '')
    .replace(/-with-.*$/, '')     // strip "with-cynthia-erivo" etc
    .replace(/-at-.*$/, '');      // strip "at-the-bridge" etc

  // Try removing venue suffixes (common patterns)
  const venueSuffixes = [
    'bridge', 'donmar', 'hampstead', 'menier', 'old-vic', 'young-vic',
    'adelphi', 'gielgud', 'savoy', 'apollo', 'noel-coward', 'wyndham',
    'marylebone', 'almeida', 'barbican', 'soho-place', 'bonneville',
  ];
  for (const suffix of venueSuffixes) {
    slug = slug.replace(new RegExp(`-${suffix}$`), '');
  }

  // Convert slug to title case
  return slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * Extract reviews from a theatre.reviews roundup page
 * Returns array of { outlet, critic, stars, starsOutOf, excerpt, url }
 */
function extractReviews(html, showId) {
  const $ = cheerio.load(html);
  const reviews = [];

  // Reviews are in <p> tags within the main content
  // Pattern: <strong>Outlet Name</strong> ⭑⭑⭑⭑ "excerpt..." - Critic Name
  // Sometimes with <a> link to full review
  const content = $('.entry-content, .post-content, article, .content').first();
  const paragraphs = content.length ? content.find('p') : $('p');

  paragraphs.each((_, el) => {
    const $p = $(el);
    const text = $p.text().trim();

    // Must contain star characters
    const starCount = (text.match(/⭑/g) || []).length;
    if (starCount === 0) return;

    // Extract outlet name (usually in <strong> or <b>)
    const outletEl = $p.find('strong, b').first();
    let outlet = outletEl.text().trim();
    if (!outlet) return;

    // Clean outlet name (remove stars if they leaked in)
    outlet = outlet.replace(/[⭑★☆✩✪✫✬✭✮✯⭐]/g, '').trim();
    if (!outlet) return;

    // Extract excerpt (text in quotes)
    const excerptMatch = text.match(/"([^"]+)"|"([^"]+)"|"([^"]+)"/);
    const excerpt = excerptMatch ? (excerptMatch[1] || excerptMatch[2] || excerptMatch[3]) : '';

    // Extract critic name (often after dash at end, or after excerpt)
    let critic = '';
    // Look for "– Critic Name" or "- Critic Name" pattern after the excerpt
    const afterExcerpt = text.split(/[""]/).pop() || '';
    const criticMatch = afterExcerpt.match(/[-–—]\s*([A-Z][a-z]+ [A-Z][a-z]+(?:\s[A-Z][a-z]+)?)/);
    if (criticMatch) {
      critic = criticMatch[1].trim();
    }

    // Extract review URL
    const linkEl = $p.find('a[href*="http"]').last();
    const reviewUrl = linkEl.attr('href') || '';

    reviews.push({
      outlet,
      outletId: normalizeOutlet(outlet),
      critic: critic || 'Unknown',
      stars: starCount,
      starsOutOf: 5,
      excerpt,
      url: reviewUrl,
      source: 'theatre-reviews',
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

    // Check for existing file
    const existing = findExistingReviewFile(showDir, outletId, criticSlug);
    const filePath = existing || path.join(showDir, `${outletId}--${criticSlug}.json`);

    let data = {};
    if (existing && fs.existsSync(existing)) {
      try { data = JSON.parse(fs.readFileSync(existing, 'utf8')); } catch (e) {}
    }

    // Update with theatre.reviews data
    data.showId = data.showId || showId;
    data.outlet = data.outlet || review.outlet;
    data.outletId = data.outletId || outletId;
    data.criticName = data.criticName || review.critic;
    if (review.url && !data.url) data.url = review.url;
    if (review.excerpt) data.theatreReviewsExcerpt = review.excerpt;

    // Star rating → P0 score (X/5 → 0-100)
    if (review.stars && !data.originalScore) {
      data.originalScore = `${review.stars}/${review.starsOutOf}`;
      data.originalScoreNormalized = Math.round((review.stars / review.starsOutOf) * 100);
      data.scoreSource = 'theatre-reviews-star-rating';
    }

    if (!DRY_RUN) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      if (existing) { updated++; } else { created++; }
    }
  }

  return { created, updated };
}

async function main() {
  console.log('=== Theatre.Reviews Scraper ===\n');

  // Ensure archive dir exists
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  const shows = loadShows ? loadShows() : JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  const weShows = shows.filter(s => isLondonMarket(s.category));
  console.log(`Loaded ${weShows.length} London market shows\n`);

  // Step 1: Discover roundup URLs
  const roundupUrls = await discoverRoundupUrls();

  // Step 2: Match URLs to shows
  const matched = [];
  for (const url of roundupUrls) {
    const title = extractTitleFromSlug(url);
    if (!title) continue;

    const match = matchTitleToShow(title, weShows, { market: 'west-end' });
    if (match && match.show) {
      if (TARGET_SHOWS && !TARGET_SHOWS.includes(match.show.id)) continue;
      matched.push({ url, show: match.show, extractedTitle: title });
      console.log(`  Matched: "${title}" → ${match.show.id}`);
    }
  }

  console.log(`\nMatched ${matched.length} shows to roundup URLs\n`);

  // Step 3: Fetch and extract each roundup
  for (const { url, show } of matched) {
    const archivePath = path.join(ARCHIVE_DIR, `${show.id}.html`);

    // Skip if already archived (unless --force)
    if (!FORCE && fs.existsSync(archivePath)) {
      console.log(`  [CACHED] ${show.title}`);
      const html = fs.readFileSync(archivePath, 'utf8');
      const reviews = extractReviews(html, show.id);
      const { created, updated } = writeReviewFiles(reviews, show.id);
      stats.reviewsExtracted += reviews.length;
      stats.filesCreated += created;
      stats.filesUpdated += updated;
      continue;
    }

    console.log(`  Fetching: ${show.title} → ${url}`);
    try {
      const html = await fetchPage(url);
      if (!html) {
        console.log(`    ✗ Failed to fetch`);
        stats.errors++;
        continue;
      }

      // Archive
      if (!DRY_RUN) {
        fs.writeFileSync(archivePath, html);
      }

      const reviews = extractReviews(html, show.id);
      console.log(`    ✓ ${reviews.length} reviews extracted`);

      const { created, updated } = writeReviewFiles(reviews, show.id);
      stats.reviewsExtracted += reviews.length;
      stats.filesCreated += created;
      stats.filesUpdated += updated;
      stats.pagesChecked++;

      // Rate limit
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      console.log(`    ✗ Error: ${err.message}`);
      stats.errors++;
    }
  }

  console.log('\n=== Summary ===');
  console.log(`  Pages checked: ${stats.pagesChecked}`);
  console.log(`  Reviews extracted: ${stats.reviewsExtracted}`);
  console.log(`  Files created: ${stats.filesCreated}`);
  console.log(`  Files updated: ${stats.filesUpdated}`);
  console.log(`  Errors: ${stats.errors}`);
}

// Export for use by opening-night-poller
module.exports = { extractReviews, discoverRoundupUrls, extractTitleFromSlug };

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
