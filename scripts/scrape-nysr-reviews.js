#!/usr/bin/env node
/**
 * NYSR (New York Stage Review) WordPress API Scraper
 *
 * Uses the WordPress REST API to discover and extract NYSR Broadway reviews.
 * - GET /wp-json/wp/v2/posts?categories=1&per_page=100 (Category 1 = Broadway)
 * - GET /wp-json/wp/v2/users (author ID → full name mapping)
 *
 * Handles:
 * - Star rating cross-contamination: strips [Read ... ★★★ review here] lines
 * - Extracts star rating from first line only
 * - Date validation: skips reviews > 1 year before show opening (wrong production)
 * - HTML → plain text conversion via cheerio
 *
 * Output: Creates/updates review files in data/review-texts/{showId}/nysr--{critic}.json
 * Archives: Saves API responses to data/aggregator-archive/nysr/
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');
const { matchTitleToShow, loadShows } = require('./lib/show-matching');
const { normalizeOutlet, normalizeCritic, generateReviewFilename } = require('./lib/review-normalization');

// Paths
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const archiveDir = path.join(__dirname, '../data/aggregator-archive/nysr');

// Stats
const stats = {
  apiPages: 0,
  totalPosts: 0,
  matchedShows: 0,
  newReviews: 0,
  updatedReviews: 0,
  skippedWrongProduction: 0,
  skippedNoMatch: 0,
  skippedAlreadyComplete: 0,
  errors: [],
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'BroadwayScorecard/1.0 (review aggregator)',
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const totalPages = parseInt(res.headers['x-wp-totalpages'] || '1', 10);
            const totalPosts = parseInt(res.headers['x-wp-total'] || '0', 10);
            resolve({ data: JSON.parse(data), totalPages, totalPosts });
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        } else if (res.statusCode === 400 && data.includes('rest_post_invalid_page_number')) {
          // Past the last page
          resolve({ data: [], totalPages: 0, totalPosts: 0 });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Author mapping
// ---------------------------------------------------------------------------

async function fetchAuthorMapping() {
  console.log('Fetching NYSR author mapping...');
  const { data: users } = await fetchJSON('https://nystagereview.com/wp-json/wp/v2/users?per_page=100');

  const mapping = {};
  for (const user of users) {
    mapping[user.id] = user.name;
  }

  console.log(`  Found ${Object.keys(mapping).length} authors:`);
  for (const [id, name] of Object.entries(mapping)) {
    console.log(`    ID ${id} → ${name}`);
  }
  return mapping;
}

// ---------------------------------------------------------------------------
// HTML → Plain Text
// ---------------------------------------------------------------------------

function htmlToPlainText(html) {
  if (!html) return '';

  const $ = cheerio.load(html);

  // Remove images, scripts, styles
  $('img, script, style, iframe').remove();

  // Process paragraphs → double newlines
  const paragraphs = [];
  $('p, h1, h2, h3, h4, h5, h6, blockquote, li').each((_, el) => {
    const text = $(el).text().trim();
    if (text) paragraphs.push(text);
  });

  let text = paragraphs.join('\n\n');

  // If no paragraphs found, fall back to raw text extraction
  if (!text.trim()) {
    text = $.root().text().trim();
  }

  // Clean up whitespace
  text = text
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();

  return text;
}

// ---------------------------------------------------------------------------
// Cross-reference stripping
// ---------------------------------------------------------------------------

/**
 * Strip NYSR cross-reference lines like:
 *   [Read Michael Sommers' ★★★★☆ review here.]
 *   [Read Frank Scheck's ★★★ review here.]
 */
function stripCrossReferences(text) {
  if (!text) return text;

  // Match lines like: [Read Someone's ★★★★☆ review here.]
  // Also match without brackets and with variations
  const patterns = [
    /\[Read .+?★+☆*.+?review here\.?\]/gi,
    /Read .+?★+☆*.+?review here\.?/gi,
    /\[Read .+?review here\.?\]/gi,
  ];

  let cleaned = text;
  for (const pattern of patterns) {
    cleaned = cleaned.replace(pattern, '');
  }

  // Clean up any leftover double newlines
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return cleaned;
}

/**
 * Extract star rating from the FIRST LINE only (to avoid cross-contamination).
 * NYSR puts the star rating as the first line of the review.
 */
function extractStarRatingFromFirstLine(text) {
  if (!text) return null;

  // Get first non-empty line
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  const firstLine = lines[0].trim();

  // Match star symbols: ★★★★☆, ★★★☆☆, etc.
  const match = firstLine.match(/★+☆*/);
  if (!match) return null;

  const filled = (match[0].match(/★/g) || []).length;
  const empty = (match[0].match(/☆/g) || []).length;
  const total = filled + empty;

  // Only trust 4-star or 5-star scales
  if (total >= 4 && total <= 5) {
    return `${filled}/${total} stars`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trailing bio/boilerplate stripping
// ---------------------------------------------------------------------------

function stripTrailingBio(text, criticName) {
  if (!text) return text;

  // Common NYSR bio patterns
  const bioPatterns = [
    /David Finkle is a freelance journalist[\s\S]*$/,
    /Frank Scheck has been covering[\s\S]*$/,
    /Melissa Rose Bernardo[\s\S]*?Email:[\s\S]*$/,
    /Michael Sommers[\s\S]*?Email:[\s\S]*$/,
    /Roma Torre[\s\S]*?Email:[\s\S]*$/,
    /Email:\s*\S+@nystagereview\.com[\s\S]*$/,
    /For an archive of older reviews[\s\S]*$/,
  ];

  let cleaned = text;
  for (const pattern of bioPatterns) {
    cleaned = cleaned.replace(pattern, '').trim();
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Date validation
// ---------------------------------------------------------------------------

function isWrongProduction(reviewDate, openingDate) {
  if (!reviewDate || !openingDate) return false;

  const review = new Date(reviewDate);
  const opening = new Date(openingDate);

  if (isNaN(review.getTime()) || isNaN(opening.getTime())) return false;

  // Skip if review is > 1 year before opening date
  const oneYearBefore = new Date(opening);
  oneYearBefore.setFullYear(oneYearBefore.getFullYear() - 1);

  return review < oneYearBefore;
}

// ---------------------------------------------------------------------------
// File operations
// ---------------------------------------------------------------------------

function saveReviewFile(showId, criticSlug, reviewData) {
  const showDir = path.join(reviewTextsDir, showId);
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  const filename = `nysr--${criticSlug}.json`;
  const filepath = path.join(showDir, filename);

  if (fs.existsSync(filepath)) {
    // Merge with existing
    const existing = JSON.parse(fs.readFileSync(filepath, 'utf8'));

    // Only update if we have new/better data
    let updated = false;

    if (reviewData.fullText && (!existing.fullText || reviewData.fullText.length > existing.fullText.length)) {
      existing.fullText = reviewData.fullText;
      updated = true;
    }
    if (reviewData.originalScore && !existing.originalScore) {
      existing.originalScore = reviewData.originalScore;
      updated = true;
    }
    if (reviewData.url && !existing.url) {
      existing.url = reviewData.url;
      updated = true;
    }
    if (reviewData.publishDate && !existing.publishDate) {
      existing.publishDate = reviewData.publishDate;
      updated = true;
    }

    // Track source
    const sources = new Set(existing.sources || [existing.source || '']);
    sources.add('nysr-api');
    existing.sources = Array.from(sources).filter(Boolean);

    if (updated) {
      fs.writeFileSync(filepath, JSON.stringify(existing, null, 2) + '\n');
      stats.updatedReviews++;
      return 'updated';
    }
    stats.skippedAlreadyComplete++;
    return 'skipped';
  }

  // Create new review file
  fs.writeFileSync(filepath, JSON.stringify(reviewData, null, 2) + '\n');
  stats.newReviews++;
  return 'new';
}

// ---------------------------------------------------------------------------
// Main scraping logic
// ---------------------------------------------------------------------------

async function scrapeNYSRReviews() {
  console.log('=== NYSR WordPress API Scraper ===\n');

  // Ensure archive directory exists
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  // Load shows data
  const shows = loadShows();
  console.log(`Loaded ${shows.length} shows from shows.json\n`);

  // Fetch author mapping
  const authorMapping = await fetchAuthorMapping();
  console.log('');

  // Paginate through all Broadway posts
  let page = 1;
  let allPosts = [];

  while (true) {
    console.log(`Fetching page ${page}...`);
    try {
      const url = `https://nystagereview.com/wp-json/wp/v2/posts?categories=1&per_page=100&page=${page}`;
      const { data: posts, totalPages } = await fetchJSON(url);

      if (!posts || posts.length === 0) {
        console.log('  No more posts.');
        break;
      }

      // Archive this page
      const archivePath = path.join(archiveDir, `api-page-${page}.json`);
      fs.writeFileSync(archivePath, JSON.stringify(posts, null, 2));

      allPosts = allPosts.concat(posts);
      stats.apiPages++;
      console.log(`  Got ${posts.length} posts (total: ${allPosts.length})`);

      if (page >= totalPages) {
        console.log(`  Reached last page (${totalPages}).`);
        break;
      }

      page++;
      await sleep(1000); // Rate limit: 1s between pages
    } catch (err) {
      console.error(`  Error fetching page ${page}: ${err.message}`);
      stats.errors.push(`Page ${page}: ${err.message}`);
      break;
    }
  }

  stats.totalPosts = allPosts.length;
  console.log(`\nTotal posts fetched: ${allPosts.length}\n`);

  // Process each post
  for (const post of allPosts) {
    const title = post.title?.rendered || '';
    const cleanTitle = cheerio.load(title).text().trim(); // Decode HTML entities
    const postUrl = post.link || '';
    const postDate = post.date || '';
    const authorId = post.author;
    const authorName = authorMapping[authorId] || `Author-${authorId}`;
    const htmlContent = post.content?.rendered || '';
    const excerptHtml = post.excerpt?.rendered || '';

    // Skip non-review posts (NYSR also publishes news, interviews)
    if (!htmlContent || htmlContent.length < 500) {
      continue;
    }

    // Match title to show
    const match = matchTitleToShow(cleanTitle, shows);
    if (!match) {
      stats.skippedNoMatch++;
      continue;
    }

    const { show, confidence } = match;
    const showId = show.slug || show.id;

    // Skip low-confidence matches
    if (confidence === 'medium') {
      console.log(`  [SKIP] Low-confidence match: "${cleanTitle}" → ${showId}`);
      stats.skippedNoMatch++;
      continue;
    }

    stats.matchedShows++;

    // Date validation: skip wrong productions
    if (isWrongProduction(postDate, show.openingDate)) {
      console.log(`  [SKIP] Wrong production: "${cleanTitle}" (${postDate}) vs opening ${show.openingDate}`);
      stats.skippedWrongProduction++;
      continue;
    }

    // Convert HTML to plain text
    let plainText = htmlToPlainText(htmlContent);

    // Strip cross-reference lines BEFORE star rating extraction
    plainText = stripCrossReferences(plainText);

    // Strip trailing bio text
    plainText = stripTrailingBio(plainText, authorName);

    // Extract star rating from excerpt (most reliable source — always present)
    // Falls back to first line of body text
    const excerptText = cheerio.load(excerptHtml).text().trim();
    const starRating = extractStarRatingFromFirstLine(excerptText) || extractStarRatingFromFirstLine(plainText);

    // Generate critic slug
    const criticSlug = normalizeCritic(authorName) || authorName.toLowerCase().replace(/\s+/g, '-');

    // Build review data
    const reviewData = {
      showId,
      outletId: 'nysr',
      outlet: 'New York Stage Review',
      criticName: authorName,
      url: postUrl,
      publishDate: postDate,
      fullText: plainText,
      isFullReview: true,
      source: 'nysr-api',
      sources: ['nysr-api'],
    };

    if (starRating) {
      reviewData.originalScore = starRating;
    }

    // Save
    const result = saveReviewFile(showId, criticSlug, reviewData);
    if (result === 'new') {
      console.log(`  [NEW] ${showId}: ${authorName}${starRating ? ` (${starRating})` : ''}`);
    } else if (result === 'updated') {
      console.log(`  [UPD] ${showId}: ${authorName}${starRating ? ` (${starRating})` : ''}`);
    }
  }

  // Print summary
  console.log('\n=== NYSR Scrape Summary ===');
  console.log(`API pages fetched: ${stats.apiPages}`);
  console.log(`Total posts: ${stats.totalPosts}`);
  console.log(`Matched to shows: ${stats.matchedShows}`);
  console.log(`New reviews created: ${stats.newReviews}`);
  console.log(`Existing reviews updated: ${stats.updatedReviews}`);
  console.log(`Skipped (already complete): ${stats.skippedAlreadyComplete}`);
  console.log(`Skipped (no match): ${stats.skippedNoMatch}`);
  console.log(`Skipped (wrong production): ${stats.skippedWrongProduction}`);
  if (stats.errors.length > 0) {
    console.log(`Errors: ${stats.errors.length}`);
    stats.errors.forEach(e => console.log(`  - ${e}`));
  }

  return stats;
}

// Run
scrapeNYSRReviews().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
