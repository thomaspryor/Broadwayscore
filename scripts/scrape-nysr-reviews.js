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
const { canonicalizeCritic } = require('./lib/critic-canonicalization');
const { setExtractedScore } = require('./lib/score-routing');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { generateReviewFilename } = require('./lib/review-normalization');
const { sanitizeCriticName } = require('./lib/byline-normalization');

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
  skippedGuardRejected: 0,
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

// Task #653/#816: if a wrongProduction/wrongShow/duplicateOf-flagged file
// already sits at the canonical path, a re-scrape's URL must never reach the
// writer — createOrMergeReviewFile's maybeUpgradeUrl() treats the flagged
// file's contentTier ('invalid', because it's flag-driven not quality-driven)
// as "bad content" and upgrades the URL, which clears wrongProduction and
// every other old-URL-derived field along with it (applyUrlChangeInvariant).
// Withholding url/publishDate reproduces the old preserveFlaggedFields()
// behavior: maybeUpgradeUrl's very first check (`!newUrl`) short-circuits, so
// the flagged file's own url/publishDate — and everything else, since the
// generic field merge below only fills falsy fields — survives untouched.
function isFlaggedOnDisk(showId, outletId, criticName, dir) {
  const sanitized = sanitizeCriticName(criticName) || 'Unknown';
  const filepath = path.join(dir, showId, generateReviewFilename(outletId, sanitized));
  if (!fs.existsSync(filepath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    return !!(data.wrongProduction || data.wrongShow || data.duplicateOf);
  } catch {
    return false;
  }
}

// Task #1687: routed through the shared writer (scripts/lib/review-file-writer.js)
// instead of a hand-rolled fs read/merge/write — that hand-rolled path bypassed
// Guard A (classifyMarketRouting, same-title cross-market sibling reroute), the
// only place a NYSR post whose matchTitleToShow() result is a same-title West
// End/Broadway sibling gets rerouted to the right production. Mirrors the
// migration commit e103b463a6f applied to scrape-theatre-reviews.js /
// scrape-thestage-roundups.js. Losing the previous "overwrite fullText only if
// longer" merge behavior is a non-issue here: NYSR's fullText always comes from
// a single WP REST API fetch of the complete post body, not an incremental
// paywall/retry fetch, so there is no shorter-then-longer sequence to compare.
function saveReviewFile(showId, reviewData, dir = reviewTextsDir) {
  const flagged = isFlaggedOnDisk(showId, 'nysr', reviewData.criticName, dir);

  const fields = {
    publishDate: flagged ? undefined : reviewData.publishDate,
    fullText: reviewData.fullText,
    isFullReview: reviewData.isFullReview,
    wordCount: reviewData.wordCount,
    textQuality: reviewData.textQuality,
  };

  if (reviewData.originalScore) {
    setExtractedScore(fields, {
      value: reviewData.originalScore,
      normalizedValue: reviewData.originalScoreNormalized || null,
      source: reviewData.scoreSource || 'nysr-scrape',
    });
  }

  const result = createOrMergeReviewFile(showId, {
    outlet: 'New York Stage Review',
    outletId: 'nysr',
    criticName: reviewData.criticName,
    url: flagged ? undefined : reviewData.url,
    publishDate: flagged ? undefined : reviewData.publishDate,
    source: 'nysr-api',
    fields,
  }, { reviewTextsDir: dir });

  if (result.action === 'new') {
    stats.newReviews++;
    return 'new';
  }
  if (result.action === 'updated') {
    stats.updatedReviews++;
    return 'updated';
  }
  if (result.reason === 'no-changes') {
    stats.skippedAlreadyComplete++;
  } else {
    stats.skippedGuardRejected++;
  }
  return 'skipped';
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

    // Match title to show (pass year for multi-production disambiguation)
    const postYear = postDate ? new Date(postDate).getFullYear() : null;
    const match = matchTitleToShow(cleanTitle, shows, { market: 'broadway', ...(postYear ? { year: postYear } : {}) });
    if (!match) {
      stats.skippedNoMatch++;
      continue;
    }
    if (match.confidence !== 'high') {
      stats.skippedNoMatch++;
      console.log(`  [LOW CONFIDENCE] "${cleanTitle}" → ${match.show.title} (${match.confidence}) — skipped`);
      continue;
    }

    const { show } = match;
    const showId = show.slug || show.id;

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

    // Session 3 #13 — canonicalize known mis-attributions. Defensive: CRITIC_CANONICAL_MAP
    // has no nysr entry today, but adding the hook means adding one later requires no
    // further wiring.
    let canonicalAuthorName = authorName;
    {
      const canon = canonicalizeCritic('nysr', authorName);
      if (canon.canonicalized) {
        console.log(`  [NYSR canon] ${canon.from} → ${canon.name}`);
        canonicalAuthorName = canon.name;
      }
    }

    // Build review data
    const reviewData = {
      criticName: canonicalAuthorName,
      url: postUrl,
      publishDate: postDate,
      fullText: plainText,
      isFullReview: true,
      wordCount: plainText ? plainText.split(/\s+/).length : 0,
      textQuality: 'full',
    };

    if (starRating) {
      reviewData.originalScore = starRating;
    }

    // Save
    const result = saveReviewFile(showId, reviewData);
    if (result === 'new') {
      console.log(`  [NEW] ${showId}: ${authorName}${starRating ? ` (${starRating})` : ''}`);
    } else if (result === 'updated') {
      console.log(`  [UPD] ${showId}: ${authorName}${starRating ? ` (${starRating})` : ''}`);
    }
  }

  // Zero-data guard: WP API may return 0 posts if blocked or API changes
  if (stats.totalPosts === 0) {
    console.error('❌ ZERO POSTS fetched from NYSR WP API — likely blocked or API change. Failing.');
    process.exit(1);
  }

  // Print summary
  console.log('\n=== NYSR Scrape Summary ===');
  console.log(`API pages fetched: ${stats.apiPages}`);
  console.log(`Total posts: ${stats.totalPosts}`);
  console.log(`Matched to shows: ${stats.matchedShows}`);
  console.log(`New reviews created: ${stats.newReviews}`);
  console.log(`Existing reviews updated: ${stats.updatedReviews}`);
  console.log(`Skipped (already complete): ${stats.skippedAlreadyComplete}`);
  console.log(`Skipped (guard-rejected): ${stats.skippedGuardRejected}`);
  console.log(`Skipped (no match): ${stats.skippedNoMatch}`);
  console.log(`Skipped (wrong production): ${stats.skippedWrongProduction}`);
  if (stats.errors.length > 0) {
    console.log(`Errors: ${stats.errors.length}`);
    stats.errors.forEach(e => console.log(`  - ${e}`));
  }

  return stats;
}

module.exports = { saveReviewFile };

if (require.main === module) {
  // Run
  scrapeNYSRReviews().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
