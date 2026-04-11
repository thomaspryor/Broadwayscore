#!/usr/bin/env node
/**
 * Generalized WordPress Theater Blog Scraper
 *
 * Scrapes Broadway reviews from theater blogs with public WordPress REST APIs.
 * Currently supports: The Front Row Center, Theater Life.
 * Theater Pizzazz deferred until API is confirmed working.
 *
 * Usage:
 *   node scripts/scrape-wp-theater-blogs.js                    # Scrape all sites
 *   node scripts/scrape-wp-theater-blogs.js --site=theater-life # Single site
 *   node scripts/scrape-wp-theater-blogs.js --dry-run           # Print matches, don't write
 *
 * Output: Creates/updates review files in data/review-texts/{showId}/{outlet}--{critic}.json
 * Archives: Saves API responses to data/aggregator-archive/{site-id}/
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');
const { matchTitleToShow, loadShows } = require('./lib/show-matching');
const { normalizeCritic, generateReviewFilename } = require('./lib/review-normalization');
const { classifyContentTier } = require('./lib/content-quality');
const { cleanText } = require('./lib/text-cleaning');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const SITE_FILTER = args.find(a => a.startsWith('--site='))?.split('=')[1] || '';

// ---------------------------------------------------------------------------
// Site configurations
// ---------------------------------------------------------------------------

const SITES = [
  {
    id: 'front-row-center',
    name: 'The Front Row Center',
    domain: 'thefrontrowcenter.com',
    apiBase: 'https://thefrontrowcenter.com/wp-json/wp/v2',
    categoryId: 1,          // "Reviews" category
    minContentLength: 500,
    extractStarRating: false,
    usersEndpointPublic: false, // Returns 401 — use hardcoded author map
    // Hardcoded WP author ID → name (users REST API returns 401/404 for this site)
    knownAuthors: {
      2: 'Tulis McCall', 10: 'Kathleen Campion', 19: 'Raphael Badagliacca',
      23: 'Taffy Jaffe', 24: 'Casey Curtis', 35: 'Natalie Allen',
      36: 'Alice Klugherz', 37: 'Margret Echeverria', 42: 'Constance Rodgers',
      48: 'Jervelle Frederick', 49: 'Jessica Mastronardi', 51: 'Sarah Tuft',
      53: 'Stanford Friedman', 57: 'Michael Hillyer', 58: 'Elise Marenson',
      61: 'Lee Sachs', 63: 'Daniel Dunlow', 64: 'George Crowley',
      66: 'Jean Sidden', 67: 'Ann Firestone', 68: 'Steve Babyak',
      69: 'Sarah Downs', 72: 'Joy Notoma', 74: 'Holli Harms',
      77: 'Donna Herman', 78: 'Victoria Weisfeld', 81: 'Betsyann Faiella',
      82: 'Massimo Iacoboni', 84: 'John Bakewell', 85: 'Austin Yang',
      89: 'David Walters', 97: 'Brittany Crowell', 99: 'Elizabeth Ann Foster',
      104: 'Nishka Jain', 105: 'Edward Kliszus', 114: 'Victoria Dammer',
      117: 'Kendra Jones', 119: 'Ilaria Cutolo', 120: 'Cameron Hughes',
      121: 'Nicole Itkin', 122: 'Barbare Sturua', 125: 'Eryn Malafronte',
      126: 'Vahni Kurra', 127: 'Yuval Jonas',
    },
  },
  {
    id: 'theater-life',
    name: 'Theater Life',
    domain: 'theaterlife.com',
    apiBase: 'https://theaterlife.com/wp-json/wp/v2',
    categoryId: 2,          // "Reviews" category
    minContentLength: 500,
    extractStarRating: true,  // "Show Name *** 1/2" in titles
    usersEndpointPublic: true,
  },
];

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const archiveBaseDir = path.join(__dirname, '../data/aggregator-archive');

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
          resolve({ data: [], totalPages: 0, totalPosts: 0 });
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// HTML → Plain Text
// ---------------------------------------------------------------------------

function htmlToPlainText(html) {
  if (!html) return '';

  const $ = cheerio.load(html);

  // Remove images, scripts, styles, iframes
  $('img, script, style, iframe').remove();

  // Process structural elements → double newlines
  const paragraphs = [];
  $('p, h1, h2, h3, h4, h5, h6, blockquote, li').each((_, el) => {
    const text = $(el).text().trim();
    if (text) paragraphs.push(text);
  });

  let text = paragraphs.join('\n\n');

  // Fallback to raw text extraction if no structured elements found
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
// Star rating extraction (theaterlife.com)
// ---------------------------------------------------------------------------

function extractStarRatingFromTitle(title) {
  // Match: "Show Name *** 1/2", "Show Name ****", "Show Name **"
  // Anchored to end-of-string with \s+ prefix to avoid mid-title matches
  const match = title.match(/\s+([*★]{1,5})\s*(1\/2)?\s*$/);
  if (!match) return { cleanTitle: title, rating: null };

  const stars = match[1].length;
  const halfStar = match[2] ? 0.5 : 0;
  const total = stars + halfStar;

  const cleanTitle = title.replace(/\s+[*★]{1,5}\s*(1\/2)?\s*$/, '').trim();
  return { cleanTitle, rating: `${total}/5 stars` };
}

// ---------------------------------------------------------------------------
// Author mapping (with pagination)
// ---------------------------------------------------------------------------

async function fetchAuthorMapping(site) {
  if (!site.usersEndpointPublic) {
    console.log(`  [${site.id}] Users endpoint not public — will extract authors from post content`);
    return {};
  }

  console.log(`  [${site.id}] Fetching author mapping...`);
  const mapping = {};
  let page = 1;

  while (true) {
    try {
      const url = `${site.apiBase}/users?per_page=50&page=${page}`;
      const { data: users, totalPages } = await fetchJSON(url);

      if (!users || users.length === 0) break;

      for (const user of users) {
        mapping[user.id] = user.name;
      }

      if (page >= totalPages) break;
      page++;
      await sleep(500);
    } catch (err) {
      if (err.message.includes('401') || err.message.includes('403')) {
        console.log(`  [${site.id}] Users endpoint returned ${err.message.slice(0, 20)} — will use fallback`);
        return {};
      }
      console.error(`  [${site.id}] Error fetching users page ${page}: ${err.message}`);
      break;
    }
  }

  console.log(`  [${site.id}] Found ${Object.keys(mapping).length} authors`);
  return mapping;
}

// ---------------------------------------------------------------------------
// Author extraction fallback
// ---------------------------------------------------------------------------

function extractAuthorFromContent(post) {
  // Non-greedy name regex: 2-4 words starting with uppercase (handles McCall, O'Brien, Porter II)
  // Lookahead stops at newlines, punctuation, or lowercase words to avoid capturing sentence text
  const bylineRegex = /(?:By|Written by)\s+([A-Z][A-Za-z']+(?:\s+(?:[A-Z][A-Za-z']+|[IVX]+|Jr|Sr)){1,3}?)(?=\s*[\n,.\-;:]|\s+[a-z]|\s*$)/;

  // Try excerpt.rendered first
  const excerptText = cheerio.load(post.excerpt?.rendered || '').text();
  const excerptMatch = excerptText.match(bylineRegex);
  if (excerptMatch) return excerptMatch[1].trim();

  // Try first 2000 chars of content (byline is always near top)
  const contentText = cheerio.load((post.content?.rendered || '').slice(0, 2000)).text();
  const contentMatch = contentText.match(bylineRegex);
  if (contentMatch) return contentMatch[1].trim();

  return null;
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

function saveReviewFile(showId, outletId, criticSlug, reviewData) {
  const showDir = path.join(reviewTextsDir, showId);
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  const filename = `${outletId}--${criticSlug}.json`;
  const filepath = path.join(showDir, filename);

  if (fs.existsSync(filepath)) {
    const existing = JSON.parse(fs.readFileSync(filepath, 'utf8'));

    // Skip if existing is already complete with longer text
    if (existing.contentTier === 'complete' && (existing.fullText || '').length >= (reviewData.fullText || '').length) {
      return 'skipped';
    }

    // Update if we have better data
    let updated = false;

    if (reviewData.fullText && (!existing.fullText || reviewData.fullText.length > existing.fullText.length)) {
      existing.fullText = reviewData.fullText;
      existing.contentTier = reviewData.contentTier;
      existing.tierReason = reviewData.tierReason;
      existing.wordCount = reviewData.wordCount;
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
    sources.add(reviewData.source);
    existing.sources = Array.from(sources).filter(Boolean);

    if (updated) {
      fs.writeFileSync(filepath, JSON.stringify(existing, null, 2) + '\n');
      return 'updated';
    }
    return 'skipped';
  }

  // Create new review file
  fs.writeFileSync(filepath, JSON.stringify(reviewData, null, 2) + '\n');
  return 'new';
}

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

async function healthCheck(site) {
  try {
    const url = `${site.apiBase}/posts?per_page=1`;
    const { data } = await fetchJSON(url);
    if (!data || data.length === 0) {
      console.log(`  [${site.id}] Health check: API returned empty — skipping`);
      return false;
    }
    console.log(`  [${site.id}] Health check: OK`);
    return true;
  } catch (err) {
    console.log(`  [${site.id}] Health check FAILED: ${err.message} — skipping`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main scraping logic (per site)
// ---------------------------------------------------------------------------

async function scrapeSite(site, shows) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Scraping: ${site.name} (${site.domain})`);
  console.log(`${'='.repeat(60)}\n`);

  const siteStats = {
    apiPages: 0,
    totalPosts: 0,
    matchedShows: 0,
    newReviews: 0,
    updatedReviews: 0,
    skippedComplete: 0,
    skippedNoMatch: 0,
    skippedWrongProduction: 0,
    skippedShortContent: 0,
    skippedInvalidTier: 0,
    errors: [],
  };

  // Health check
  const healthy = await healthCheck(site);
  if (!healthy) return siteStats;

  // Fetch author mapping
  const authorMapping = await fetchAuthorMapping(site);

  // Ensure archive directory exists
  const archiveDir = path.join(archiveBaseDir, site.id);
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  // Paginate through all review posts
  let page = 1;
  let allPosts = [];

  while (true) {
    const categoryParam = site.categoryId ? `&categories=${site.categoryId}` : '';
    const url = `${site.apiBase}/posts?per_page=50&page=${page}${categoryParam}`;

    console.log(`  Fetching page ${page}...`);
    try {
      const { data: posts, totalPages } = await fetchJSON(url);

      if (!posts || posts.length === 0) {
        console.log('    No more posts.');
        break;
      }

      // Archive this page
      const archivePath = path.join(archiveDir, `api-page-${page}.json`);
      fs.writeFileSync(archivePath, JSON.stringify(posts, null, 2));

      allPosts = allPosts.concat(posts);
      siteStats.apiPages++;
      console.log(`    Got ${posts.length} posts (total: ${allPosts.length})`);

      if (page >= totalPages) {
        console.log(`    Reached last page (${totalPages}).`);
        break;
      }

      page++;
      await sleep(1000); // Rate limit: 1s between pages
    } catch (err) {
      console.error(`    Error fetching page ${page}: ${err.message}`);
      siteStats.errors.push(`Page ${page}: ${err.message}`);
      break;
    }
  }

  siteStats.totalPosts = allPosts.length;
  console.log(`\n  Total posts fetched: ${allPosts.length}\n`);

  // Process each post
  for (const post of allPosts) {
    const rawTitle = post.title?.rendered || '';
    const cleanTitle = cheerio.load(rawTitle).text().trim(); // Decode HTML entities
    const postUrl = post.link || '';
    const postDate = post.date || '';
    const authorId = post.author;
    const htmlContent = post.content?.rendered || '';

    // Skip short content (news snippets, link posts)
    if (!htmlContent || htmlContent.length < site.minContentLength) {
      siteStats.skippedShortContent++;
      continue;
    }

    // Extract star rating from title if applicable
    let titleForMatching = cleanTitle;
    let starRating = null;
    if (site.extractStarRating) {
      const extracted = extractStarRatingFromTitle(cleanTitle);
      titleForMatching = extracted.cleanTitle;
      starRating = extracted.rating;
    }

    // Match title to show — ALWAYS pass year hint (P0 from pre-mortem review)
    const postYear = postDate ? new Date(postDate).getFullYear() : null;
    const match = matchTitleToShow(titleForMatching, shows, { market: 'broadway', ...(postYear ? { year: postYear } : {}) });
    if (!match) {
      siteStats.skippedNoMatch++;
      continue;
    }
    if (match.confidence !== 'high') {
      siteStats.skippedNoMatch++;
      console.log(`  [LOW CONFIDENCE] "${titleForMatching}" → ${match.show.title} (${match.confidence}) — skipped`);
      continue;
    }

    const { show } = match;
    const showId = show.slug || show.id;

    siteStats.matchedShows++;

    // Date validation: skip wrong productions
    if (isWrongProduction(postDate, show.openingDate)) {
      console.log(`    [SKIP] Wrong production: "${cleanTitle}" (${postDate}) vs opening ${show.openingDate}`);
      siteStats.skippedWrongProduction++;
      continue;
    }

    // Convert HTML to plain text
    let plainText = htmlToPlainText(htmlContent);

    // Apply boilerplate stripping
    if (plainText) {
      plainText = cleanText(plainText);
    }

    // Classify content tier
    const tierResult = classifyContentTier({ fullText: plainText });
    if (tierResult.contentTier === 'invalid') {
      siteStats.skippedInvalidTier++;
      continue;
    }

    // Resolve author: knownAuthors map → WP users mapping → regex fallback
    let authorName = (site.knownAuthors && site.knownAuthors[authorId]) || authorMapping[authorId] || extractAuthorFromContent(post) || 'Unknown';

    // Generate critic slug
    const criticSlug = normalizeCritic(authorName) || authorName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');

    // Build review data
    const reviewData = {
      showId,
      outletId: site.id,
      outlet: site.name,
      criticName: authorName,
      url: postUrl,
      publishDate: postDate,
      fullText: plainText,
      wordCount: plainText ? plainText.split(/\s+/).length : 0,
      contentTier: tierResult.contentTier,
      tierReason: tierResult.tierReason,
      source: `wp-api-${site.id}`,
      sources: [`wp-api-${site.id}`],
    };

    if (starRating) {
      reviewData.originalScore = starRating;
    }

    if (DRY_RUN) {
      console.log(`    [DRY] ${showId}: ${authorName} — "${titleForMatching}" (${tierResult.contentTier}, ${reviewData.wordCount} words)${starRating ? ` [${starRating}]` : ''}`);
      siteStats.newReviews++; // Count as potential new for dry-run reporting
      continue;
    }

    // Save
    const result = saveReviewFile(showId, site.id, criticSlug, reviewData);
    if (result === 'new') {
      siteStats.newReviews++;
      console.log(`    [NEW] ${showId}: ${authorName}${starRating ? ` (${starRating})` : ''}`);
    } else if (result === 'updated') {
      siteStats.updatedReviews++;
      console.log(`    [UPD] ${showId}: ${authorName}${starRating ? ` (${starRating})` : ''}`);
    } else {
      siteStats.skippedComplete++;
    }
  }

  // Print site summary
  console.log(`\n  --- ${site.name} Summary ---`);
  console.log(`  API pages fetched: ${siteStats.apiPages}`);
  console.log(`  Total posts: ${siteStats.totalPosts}`);
  console.log(`  Matched to shows: ${siteStats.matchedShows}`);
  console.log(`  New reviews: ${siteStats.newReviews}`);
  console.log(`  Updated reviews: ${siteStats.updatedReviews}`);
  console.log(`  Skipped (already complete): ${siteStats.skippedComplete}`);
  console.log(`  Skipped (no match): ${siteStats.skippedNoMatch}`);
  console.log(`  Skipped (wrong production): ${siteStats.skippedWrongProduction}`);
  console.log(`  Skipped (short content): ${siteStats.skippedShortContent}`);
  console.log(`  Skipped (invalid tier): ${siteStats.skippedInvalidTier}`);
  if (siteStats.errors.length > 0) {
    console.log(`  Errors: ${siteStats.errors.length}`);
    siteStats.errors.forEach(e => console.log(`    - ${e}`));
  }

  return siteStats;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== WordPress Theater Blog Scraper ===');
  if (DRY_RUN) console.log('*** DRY RUN — no files will be written ***');
  if (SITE_FILTER) console.log(`*** Filtering to site: ${SITE_FILTER} ***`);
  console.log('');

  // Load shows
  const shows = loadShows();
  console.log(`Loaded ${shows.length} shows from shows.json\n`);

  // Filter sites
  const sitesToScrape = SITE_FILTER
    ? SITES.filter(s => s.id === SITE_FILTER)
    : SITES;

  if (sitesToScrape.length === 0) {
    console.error(`No site found matching "${SITE_FILTER}". Available: ${SITES.map(s => s.id).join(', ')}`);
    process.exit(1);
  }

  // Scrape each site
  const allStats = [];
  for (const site of sitesToScrape) {
    try {
      const stats = await scrapeSite(site, shows);
      allStats.push({ site: site.id, ...stats });
    } catch (err) {
      console.error(`\nFATAL error scraping ${site.id}: ${err.message}`);
      allStats.push({ site: site.id, error: err.message });
    }
  }

  // Overall summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('OVERALL SUMMARY');
  console.log(`${'='.repeat(60)}`);
  let totalNew = 0, totalUpdated = 0;
  for (const s of allStats) {
    if (s.error) {
      console.log(`  ${s.site}: ERROR — ${s.error}`);
    } else {
      console.log(`  ${s.site}: ${s.newReviews} new, ${s.updatedReviews} updated, ${s.totalPosts} posts scanned`);
      totalNew += s.newReviews || 0;
      totalUpdated += s.updatedReviews || 0;
    }
  }
  console.log(`\n  TOTAL: ${totalNew} new, ${totalUpdated} updated`);
  if (DRY_RUN) console.log('  (dry run — no files written)');

  // Zero-data guard: if ALL sites returned 0 posts, likely network/WAF issue
  const totalPosts = allStats.reduce((sum, s) => sum + (s.totalPosts || 0), 0);
  if (totalPosts === 0 && allStats.length > 0) {
    console.error('❌ ZERO POSTS fetched across all WP theater blog sites — likely blocked. Failing.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
