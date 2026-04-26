#!/usr/bin/env node
/**
 * Scrape theatre.reviews roundup pages for West End shows
 *
 * theatre.reviews is a handcrafted WE review aggregator with per-outlet
 * star ratings (1-5), critic names, excerpts, and links to full reviews.
 * 10+ reviews per show, static HTML, no JS rendering needed.
 *
 * URL pattern: https://theatre.reviews/reviews-roundup/{title-slug}-{venue-slug}-reviews/
 * Discovery: category archive at /category/reviews-roundup/ (10 per page, paginated)
 *
 * HTML structure (WordPress, verified Mar 2026):
 *   - Star tier headers: <p><span style="color: #ff0000;">N stars ⭑⭑⭑</span></p>
 *     or plain <p>N stars ⭑⭑⭑</p>
 *   - Review paragraphs follow each tier header (no stars in them)
 *   - Outlet in <a href="reviewURL">Outlet Name</a> or plain text
 *   - Critic name embedded in prose: "Outlet's CriticName" or "CriticName for Outlet"
 *   - Excerpts in single curly quotes: 'text...'
 *   - Average rating at bottom: <strong>Critics' Average Rating X.X⭑</strong>
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
const { matchTitleToShow, loadShows, validateRoundupPageTitle } = require('./lib/show-matching');
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
 * Discover roundup URLs by paginating the category archive.
 * /category/reviews-roundup/ shows 10 per page; we follow /page/N/ links.
 */
async function discoverRoundupUrls() {
  const seen = new Set();
  const urls = [];
  const MAX_PAGES = 30; // safety cap — site has ~23 pages

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = page === 1
      ? 'https://theatre.reviews/category/reviews-roundup/'
      : `https://theatre.reviews/category/reviews-roundup/page/${page}/`;

    const html = await fetchPage(pageUrl);
    if (!html) break; // 404 = no more pages

    const $ = cheerio.load(html);
    let found = 0;
    $('a[href*="/reviews-roundup/"]').each((_, el) => {
      const href = $(el).attr('href');
      if (!href || !href.includes('/reviews-roundup/')) return;
      // Skip the category page itself and pagination links
      if (href.match(/\/category\//) || href.match(/\/page\//)) return;
      const full = href.startsWith('http') ? href : `https://theatre.reviews${href}`;
      if (!seen.has(full)) {
        seen.add(full);
        urls.push(full);
        found++;
      }
    });

    console.log(`  Page ${page}: ${found} new URLs (${urls.length} total)`);
    if (found === 0) break; // no new URLs = last page

    await new Promise(r => setTimeout(r, 1000)); // rate limit between pages
  }

  console.log(`Discovered ${urls.length} roundup URLs from category archive\n`);
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
 * Extract reviews from a theatre.reviews roundup page.
 *
 * HTML structure: star-tier headers (<p> with "N stars ⭑⭑⭑") act as section
 * dividers. Review paragraphs follow each header and inherit that tier's rating.
 * Reviews themselves contain NO star characters — only the headers do.
 *
 * Returns array of { outlet, critic, stars, starsOutOf, excerpt, url, source }
 */
function extractReviews(html, showId) {
  const $ = cheerio.load(html);
  const reviews = [];

  const content = $('.entry-content, .post-content, article, .content').first();
  const paragraphs = content.length ? content.find('p') : $('p');

  let currentStars = 0;

  paragraphs.each((_, el) => {
    const $p = $(el);
    const text = $p.text().trim();
    if (!text) return;

    // --- Detect star-tier header ---
    // Patterns: "4 stars ⭑⭑⭑⭑" or "Three stars ⭑⭑⭑" (digit or word, with or without <span>)
    const WORD_TO_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    const tierMatch = text.match(/^(\d|one|two|three|four|five)\s*stars?\s*[⭑★]+$/i);
    if (tierMatch) {
      const raw = tierMatch[1].toLowerCase();
      currentStars = WORD_TO_NUM[raw] || parseInt(raw, 10);
      return;
    }

    // --- Detect "Critics' Average Rating" footer — stop processing ---
    if (text.match(/critics[''\u2019]?\s*(average|avg)\s*rating/i)) return;

    // --- Detect inline star format: "Outlet's Critic (N★)" or "(N★)" ---
    const inlineStarMatch = text.match(/\((\d)[★⭑\*]\)/);
    if (inlineStarMatch) {
      const inlineReview = parseReviewParagraph($, $p, text, parseInt(inlineStarMatch[1], 10));
      if (inlineReview) {
        reviews.push(inlineReview);
        return;
      }
    }

    // Skip if we haven't seen a star header yet
    if (currentStars === 0) return;

    // Skip editorial boilerplate
    if (text.match(/^\[Links to full reviews/i)) return;
    if (text.match(/^If you[''\u2019]ve seen/i)) return;
    if (text.match(/can be seen at/i) && text.length < 200) return;

    // --- Try to extract a review from this paragraph ---
    const review = parseReviewParagraph($, $p, text, currentStars);
    if (review) {
      reviews.push(review);
    }
  });

  return reviews;
}

/**
 * Parse a single review paragraph into structured data.
 * Returns null if the paragraph doesn't look like a review.
 */
function parseReviewParagraph($, $p, text, stars) {
  // Extract the first external link (usually the outlet link + review URL)
  const links = [];
  $p.find('a[href]').each((_, a) => {
    const href = $(a).attr('href');
    if (href && href.startsWith('http') && !href.includes('theatre.reviews')) {
      links.push({ href, text: $(a).text().trim() });
    }
  });

  let outlet = '';
  let critic = '';
  let reviewUrl = '';

  if (links.length > 0) {
    // First external link is typically the outlet
    const outletLink = links[0];
    reviewUrl = outletLink.href;

    // Handle possessive in link text: "The Independent's" → "The Independent"
    outlet = outletLink.text.replace(/['\u2018\u2019]s?\s*$/, '').trim();
  }

  // --- Extract critic name from prose patterns ---
  // Pattern A: "Outlet's CriticName verb:" — e.g., "The Guardian's Arifa Akbar was blown away:"
  // Pattern B: "CriticName for/at Outlet verb:" — e.g., "Dave Fargnoli for The Stage commented:"
  // Pattern C: "Outlet's CriticName verb:" where outlet is plain text (no link)

  // Try Pattern A: <Outlet>'s <Critic>
  // Note: theatre.reviews uses U+2018 (left single quote) for possessives
  const patternA = text.match(/^(?:<[^>]+>)?([A-Z][\w\s&.'-]+?)['\u2018\u2019]s\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+(?:-[A-Z][a-z]+)?)+)/);
  if (patternA) {
    if (!outlet) outlet = patternA[1].trim();
    critic = patternA[2].trim();
  }

  // Try Pattern B: <Critic> for/at <Outlet>
  if (!critic) {
    const patternB = text.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z]+(?:-[A-Z][a-z]+)?)+)\s+(?:for|at|of)\s+(?:the\s+)?([A-Z][\w\s&.'-]+?)(?:\s+(?:called|commented|described|concluded|noted|reported|thought|found|said|summed|began|looked|was|wrote|observed))/i);
    if (patternB) {
      critic = patternB[1].trim();
      if (!outlet) outlet = patternB[2].trim();
    }
  }

  // Try Pattern C: "The Outlet's CriticName" where outlet has no link
  if (!critic && !outlet) {
    const patternC = text.match(/^(?:The\s+)?([A-Z][\w\s&.'-]+?)['\u2018\u2019]s\s+([A-Z][a-z]+(?:\s[A-Z][a-z]+(?:-[A-Z][a-z]+)?)+)/);
    if (patternC) {
      outlet = patternC[1].trim();
      critic = patternC[2].trim();
    }
  }

  // If we still don't have an outlet, this probably isn't a review paragraph
  if (!outlet) return null;

  // Ensure outlet doesn't end with possessive artifacts
  outlet = outlet.replace(/['\u2018\u2019]s?\s*$/, '').trim();

  // --- Extract excerpts (text in single curly quotes) ---
  // Matches: \u2018...\u2019 (curly) and '...' (straight)
  const excerpts = [];
  const quoteRegex = /[\u2018']([^'\u2019]+)[\u2019']/g;
  let m;
  while ((m = quoteRegex.exec(text)) !== null) {
    const q = m[1].trim();
    if (q.length > 20) excerpts.push(q); // skip tiny fragments
  }
  const excerpt = excerpts.join(' … ');

  return {
    outlet,
    outletId: normalizeOutlet(outlet),
    critic: critic || 'Unknown',
    stars,
    starsOutOf: 5,
    excerpt,
    url: reviewUrl,
    source: 'theatre-reviews',
  };
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
    const existingMatch = findExistingReviewFile(showDir, outletId, criticSlug);
    const filePath = existingMatch ? existingMatch.path : path.join(showDir, `${outletId}--${criticSlug}.json`);

    let data = {};
    if (existingMatch && existingMatch.data) {
      data = existingMatch.data;
    }

    // Update with theatre.reviews data
    data.showId = data.showId || showId;
    data.outlet = data.outlet || review.outlet;
    data.outletId = data.outletId || outletId;
    data.criticName = data.criticName || review.critic;
    if (review.url && !data.url) data.url = review.url;
    if (review.excerpt) data.theatreReviewsExcerpt = review.excerpt;

    // Store theatre.reviews' star rating as metadata only — NOT as the outlet's
    // originalScore. TR rates shows independently; attributing TR's rating to
    // the listed outlet causes wrong scores (e.g. TR gives 3/5, outlet gave 5/5).
    if (review.stars) {
      data.theatreReviewsStars = `${review.stars}/${review.starsOutOf}`;
    }

    if (!DRY_RUN) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
      if (existingMatch) { updated++; } else { created++; }
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
    if (!match || !match.show) continue;
    if (match.confidence !== 'high') {
      console.log(`  [LOW CONFIDENCE] "${title}" → ${match.show.title} (${match.confidence}) — skipped`);
      continue;
    }
    if (TARGET_SHOWS && !TARGET_SHOWS.includes(match.show.id)) continue;
    matched.push({ url, show: match.show, extractedTitle: title });
    console.log(`  Matched: "${title}" → ${match.show.id}`);
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

      // Validate page title matches the show before archiving — Stuart King 2026-04-25
      const v = validateRoundupPageTitle(html, show.title);
      if (!v.ok) {
        console.log(`    ✗ page-title mismatch (${v.reason}): "${(v.pageTitle||'').substring(0,60)}" — skipped`);
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

// Only run main() when executed directly (not when required)
if (require.main === module) {
  main().then(() => {
    process.exit(0);
  }).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
