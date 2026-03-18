#!/usr/bin/env node
/**
 * WestEndTheatre.com Review Roundup Scraper
 *
 * Uses the WordPress REST API to extract critic star ratings from review
 * roundup posts. Each roundup has a wp-block-table with Publication/Rating
 * columns, using Unicode ★ characters (1-5 stars).
 *
 * API: GET /wp-json/wp/v2/posts?categories=10&per_page=50
 * Tag: reviews-round-up (ID 8631) for targeted roundup fetching
 *
 * Output: Creates/updates review files in data/review-texts/{showId}/
 * Archives: Saves raw API responses to data/aggregator-archive/westendtheatre/
 *
 * Usage:
 *   node scripts/scrape-westendtheatre-roundups.js [--show=SHOW_ID] [--dry-run] [--force]
 *
 * No external dependencies needed — WordPress API is public.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { matchTitleToShow, loadShows } = require('./lib/show-matching');
const {
  normalizeOutlet,
  normalizeCritic,
  generateReviewFilename,
  findExistingReviewFile,
  getOutletDisplayName,
} = require('./lib/review-normalization');

const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const archiveDir = path.join(__dirname, '../data/aggregator-archive/westendtheatre');

const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');

const RATE_LIMIT_MS = 1500;
const API_PAGE_DELAY_MS = 3000; // Delay between WP API page fetches (Sucuri WAF evasion)
const WP_API_BASE = 'https://www.westendtheatre.com/wp-json/wp/v2';
const COOKIE_JAR = '/tmp/westendtheatre-cookies.txt';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const PER_PAGE = 50; // Lower than 100 to look less bot-like
// Category 10 = reviews, Tag 8631 = reviews-round-up
const REVIEWS_CATEGORY = 10;
const ROUNDUP_TAG = 8631;

const stats = {
  apiPages: 0,
  totalPosts: 0,
  matchedShows: 0,
  newReviews: 0,
  updatedReviews: 0,
  skippedNoMatch: 0,
  skippedNoTable: 0,
  errors: [],
};

// --- HTTP helpers ---

/**
 * Fetch JSON from WordPress API using curl with Sucuri WAF handling.
 * Uses cookie jar to persist Sucuri challenge cookies, proper User-Agent,
 * and falls back to Node https if curl fails.
 */
async function fetchJSON(url) {
  const { execFileSync } = require('child_process');
  try {
    const result = execFileSync('curl', [
      '-s', '-i', url,
      '-H', 'Accept: application/json',
      '-H', `User-Agent: ${USER_AGENT}`,
      '-b', COOKIE_JAR,
      '-c', COOKIE_JAR,
      '--compressed',
    ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024, encoding: 'utf8' });

    const headerEnd = result.indexOf('\r\n\r\n');
    if (headerEnd === -1) throw new Error('No header/body separator found');

    const headers = result.slice(0, headerEnd).toLowerCase();
    const body = result.slice(headerEnd + 4);

    const totalPagesMatch = headers.match(/x-wp-totalpages:\s*(\d+)/);
    const totalPostsMatch = headers.match(/x-wp-total:\s*(\d+)/);
    const totalPages = totalPagesMatch ? parseInt(totalPagesMatch[1]) : 1;
    const totalPosts = totalPostsMatch ? parseInt(totalPostsMatch[1]) : 0;

    const parsed = JSON.parse(body);
    return { data: parsed, totalPages, totalPosts };
  } catch (e) {
    if (e.stdout) {
      try {
        const bodyPart = e.stdout.includes('\r\n\r\n')
          ? e.stdout.slice(e.stdout.indexOf('\r\n\r\n') + 4)
          : e.stdout;
        const parsed = JSON.parse(bodyPart);
        if (parsed.code === 'rest_post_invalid_page_number') {
          return { data: [], totalPages: 0, totalPosts: 0 };
        }
      } catch { /* not JSON */ }
    }
    // Fallback: try Node https
    console.log(`  ⚠️  curl failed, trying Node https fallback...`);
    return fetchJSONNodeHttps(url);
  }
}

/**
 * Node https fallback for when curl fails entirely.
 */
function fetchJSONNodeHttps(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': USER_AGENT,
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.code === 'rest_post_invalid_page_number') {
            resolve({ data: [], totalPages: 0, totalPosts: 0 });
            return;
          }
          const totalPages = parseInt(res.headers['x-wp-totalpages'] || '1');
          const totalPosts = parseInt(res.headers['x-wp-total'] || '0');
          resolve({ data: parsed, totalPages, totalPosts });
        } catch (parseErr) {
          reject(new Error(`JSON parse failed: ${parseErr.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

/**
 * Fetch with headers to get WP total pages.
 * Now just delegates to fetchJSON which handles headers, cookies, and UA.
 * Kept as a separate function for call-site clarity.
 */
async function fetchJSONWithHeaders(url) {
  return fetchJSON(url);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- HTML parsing ---

/**
 * Strip HTML tags, decode entities
 */
function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#038;/g, '&')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8211;/g, '–')
    .replace(/&#8212;/g, '—')
    .trim();
}

/**
 * Extract show title from WP post title.
 * Strips common prefixes like "Reviews of", "Review:", etc.
 */
function extractShowTitle(wpTitle) {
  let title = stripHtml(wpTitle);

  // Strip common review prefixes
  title = title
    .replace(/^reviews?\s+of\s+/i, '')
    .replace(/^reviews?:\s*/i, '')
    .replace(/^review\s+roundup:\s*/i, '')
    .replace(/^what the critics (are )?say(ing)? about\s+/i, '')
    .replace(/^critics (on|review)\s+/i, '')
    .replace(/^the reviews are in for\s+/i, '')
    .trim();

  // Strip trailing " starring ...", " at ...", " – reviews"
  title = title
    .replace(/\s+starring\s+.+$/i, '')
    .replace(/\s+at\s+(the\s+)?\w+\s+(theatre|theater)$/i, '')
    .replace(/\s*[-–—]\s*reviews?$/i, '')
    .replace(/\s+reviews?$/i, '')
    .trim();

  return title;
}

/**
 * Extract star ratings from HTML table in post content.
 * Returns array of { outlet, stars, critic, excerpt, reviewUrl } objects.
 */
function extractStarRatings(htmlContent) {
  const ratings = [];

  // Find table rows: <tr><td>..outlet..</td><td>..stars..</td></tr>
  const rowRegex = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let match;

  while ((match = rowRegex.exec(htmlContent)) !== null) {
    const cellA = stripHtml(match[1]).trim();
    const cellB = match[2]; // Keep HTML to count star characters

    // Skip header row
    if (/^(publication|outlet|critic|newspaper|source)/i.test(cellA)) continue;
    if (!cellA || cellA.length < 2) continue;

    // Count filled star characters (★ = U+2605)
    const starCount = (cellB.match(/★/g) || []).length;

    // Some posts might use ⭐ or ✩ or text like "4/5"
    let finalStars = starCount;
    if (finalStars === 0) {
      // Try numeric format like "4/5" or "3.5/5"
      const numMatch = stripHtml(cellB).match(/(\d+\.?\d*)\s*\/\s*5/);
      if (numMatch) {
        finalStars = parseFloat(numMatch[1]);
      }
    }

    if (finalStars > 0 && finalStars <= 5) {
      ratings.push({
        outlet: cellA,
        stars: finalStars,
      });
    }
  }

  return ratings;
}

/**
 * Extract reviews from section-format posts (no table).
 * Format: Outlet heading → ★★★★ → "excerpts" → Critic Name, Outlet → Read the review
 * Returns array of { outlet, stars, critic, excerpt, reviewUrl } objects.
 */
function extractSectionReviews(htmlContent) {
  const reviews = [];
  const text = stripHtml(htmlContent);

  // Find star blocks: sequences of ★ characters
  const starRegex = /(★{1,5})/g;
  let starMatch;
  const starPositions = [];
  while ((starMatch = starRegex.exec(text)) !== null) {
    starPositions.push({ idx: starMatch.index, stars: starMatch[1].length });
  }

  if (starPositions.length === 0) return reviews;

  for (let i = 0; i < starPositions.length; i++) {
    const { idx, stars } = starPositions[i];
    const endIdx = i + 1 < starPositions.length ? starPositions[i + 1].idx : text.length;

    // Outlet: text line immediately before the stars
    const beforeStars = text.substring(Math.max(0, idx - 300), idx).trim();
    const beforeLines = beforeStars.split('\n').filter(l => l.trim());
    const outletLine = beforeLines[beforeLines.length - 1]?.trim() || '';

    if (!outletLine || outletLine.length < 2 || outletLine.length > 60) continue;
    // Skip if outlet line looks like a sentence (contains quotes or many words)
    if (outletLine.startsWith('"') || outletLine.startsWith('\u201c')) continue;

    const outlet = outletLine;

    // After stars until next star block: excerpts + critic attribution
    const afterStars = text.substring(idx + stars, endIdx).trim();

    // Extract critic name: "Firstname Lastname, Outlet" pattern
    let critic = null;
    const lines = afterStars.split('\n').map(l => l.trim()).filter(l => l);
    for (const line of lines) {
      if (line.startsWith('"') || line.startsWith('\u201c')) continue;
      if (line.startsWith('More ') || line.startsWith('Read the')) continue;
      const criticMatch = line.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z'-]+)+)(?:,\s*.+)?$/);
      if (criticMatch) {
        critic = criticMatch[1].trim();
        break;
      }
    }

    // Extract excerpts in quotes
    const excerpts = [];
    const quoteRegex = /[""\u201c]([^""\u201d]+)[""\u201d]/g;
    let qMatch;
    while ((qMatch = quoteRegex.exec(afterStars)) !== null) {
      const q = qMatch[1].trim();
      if (q.length > 15) excerpts.push(q);
    }
    const excerpt = excerpts.join(' … ').substring(0, 800);

    // Extract review URL from nearby <a> tags
    // We'll extract from the HTML using regex since we have the raw HTML
    let reviewUrl = null;
    const linkRegex = /<a[^>]*href="([^"]+)"[^>]*>[^<]*Read the review/gi;
    const allLinks = [];
    let lMatch;
    while ((lMatch = linkRegex.exec(htmlContent)) !== null) {
      if (!lMatch[1].includes('westendtheatre.com')) {
        allLinks.push(lMatch[1]);
      }
    }
    if (allLinks[i]) reviewUrl = allLinks[i];

    reviews.push({
      outlet,
      stars,
      critic,
      excerpt,
      reviewUrl,
    });
  }

  return reviews;
}

/**
 * Save a review file, merging with existing if present.
 */
function saveReview(review) {
  const showDir = path.join(reviewTextsDir, review.showId);
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  const filename = generateReviewFilename(review.outletId, review.criticName);
  let filepath = path.join(showDir, filename);

  const existingFile = findExistingReviewFile(showDir, review.outletId, review.criticName);
  if (existingFile && existingFile.data) {
    filepath = existingFile.path;
    const existing = existingFile.data;

    // Don't overwrite if existing has a better score source
    if (existing.originalScore && !review.originalScore) {
      review.originalScore = existing.originalScore;
    }

    review = {
      ...existing,
      // Update WET-specific fields
      westEndTheatreScore: review.westEndTheatreScore || existing.westEndTheatreScore || null,
      westEndTheatreExcerpt: review.westEndTheatreExcerpt || existing.westEndTheatreExcerpt || null,
      originalScore: existing.originalScore || review.originalScore,
      // Preserve all existing data
      fullText: existing.fullText || null,
      isFullReview: existing.isFullReview || false,
      dtliExcerpt: existing.dtliExcerpt || null,
      dtliThumb: existing.dtliThumb || null,
      showScoreExcerpt: existing.showScoreExcerpt || null,
      bwwExcerpt: existing.bwwExcerpt || null,
      bwwThumb: existing.bwwThumb || null,
      stagedoorExcerpt: existing.stagedoorExcerpt || null,
      nycTheatreExcerpt: existing.nycTheatreExcerpt || null,
      lboRoundupExcerpt: existing.lboRoundupExcerpt || null,
      url: existing.url || review.url,
      publishDate: existing.publishDate || review.publishDate,
      assignedScore: existing.assignedScore || null,
      llmScore: existing.llmScore || null,
      llmMetadata: existing.llmMetadata || null,
      ensembleData: existing.ensembleData || null,
      source: existing.source || review.source,
    };

    stats.updatedReviews++;
  } else {
    stats.newReviews++;
  }

  fs.writeFileSync(filepath, JSON.stringify(review, null, 2));
  return filepath;
}

// --- Main ---

async function main() {
  const shows = loadShows();
  const allShows = Array.isArray(shows) ? shows : Object.values(shows);

  console.log('📰 WestEndTheatre.com Review Roundup Scraper');
  console.log(`   Dry run: ${dryRun}`);
  console.log('');

  // Clean cookie jar from previous runs so Sucuri gets a fresh start
  try { fs.unlinkSync(COOKIE_JAR); } catch { /* doesn't exist yet */ }

  if (!dryRun) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  // Fetch all roundup posts via WP API (paginated)
  const allPosts = [];
  let page = 1;
  let totalPages = 1;

  console.log('📡 Fetching review roundup posts from WordPress API...\n');

  while (page <= totalPages) {
    // Fetch reviews category without tag filter — the star table format is recent (Dec 2025+)
    // and not consistently tagged. We filter by table presence instead.
    const url = `${WP_API_BASE}/posts?categories=${REVIEWS_CATEGORY}&per_page=${PER_PAGE}&page=${page}`;
    try {
      const result = await (page === 1 ? fetchJSONWithHeaders(url) : fetchJSON(url));
      if (page === 1) totalPages = result.totalPages;
      stats.apiPages++;

      if (result.data.length === 0) break;

      allPosts.push(...result.data);
      console.log(`  Page ${page}/${totalPages}: ${result.data.length} posts (${allPosts.length} total)`);

      page++;
      if (page <= totalPages) await sleep(API_PAGE_DELAY_MS);
    } catch (e) {
      console.error(`  ❌ API error on page ${page}: ${e.message}`);
      stats.errors.push(`API page ${page}: ${e.message}`);
      break;
    }
  }

  stats.totalPosts = allPosts.length;
  console.log(`\n   Total roundup posts: ${allPosts.length}\n`);

  // Process each post
  for (let i = 0; i < allPosts.length; i++) {
    const post = allPosts[i];
    const wpTitle = post.title?.rendered || '';
    const htmlContent = post.content?.rendered || '';
    const postDate = post.date?.split('T')[0] || null;
    const postUrl = post.link || '';

    // Extract show title from post title
    const showTitle = extractShowTitle(wpTitle);
    if (!showTitle || showTitle.length < 2) {
      continue;
    }

    // Match to our shows
    const matchResult = matchTitleToShow(showTitle, allShows, { market: 'west-end' });
    if (!matchResult || !matchResult.show) {
      stats.skippedNoMatch++;
      continue;
    }

    const show = matchResult.show;

    // Apply show filter
    if (showFilter && show.id !== showFilter) continue;

    // Check if archive already exists (skip unless --force)
    const archivePath = path.join(archiveDir, `${show.id}.json`);
    if (!force && fs.existsSync(archivePath)) {
      continue;
    }

    // Extract star ratings from table (preferred) or section format (fallback)
    let ratings = extractStarRatings(htmlContent);
    let usedSectionFormat = false;

    if (ratings.length === 0) {
      // Fallback: try section-format extraction (outlet heading + ★ + excerpts)
      const sectionReviews = extractSectionReviews(htmlContent);
      if (sectionReviews.length > 0) {
        ratings = sectionReviews;
        usedSectionFormat = true;
      } else {
        stats.skippedNoTable++;
        continue;
      }
    }

    stats.matchedShows++;
    console.log(`[${stats.matchedShows}] ${show.title} (${show.id}) — ${ratings.length} ratings`);

    // Save archive
    if (!dryRun) {
      const archiveData = {
        ourShowId: show.id,
        title: show.title,
        wpPostId: post.id,
        wpTitle: stripHtml(wpTitle),
        postUrl,
        postDate,
        ratings,
        fetchedAt: new Date().toISOString().slice(0, 10),
      };
      fs.writeFileSync(archivePath, JSON.stringify(archiveData, null, 2) + '\n');
    }

    // Create review files for each rating
    for (const r of ratings) {
      const outletId = normalizeOutlet(r.outlet);
      const outletName = getOutletDisplayName(outletId) || r.outlet;

      const review = {
        showId: show.id,
        outletId,
        outlet: outletName,
        criticName: r.critic || null,
        url: r.reviewUrl || postUrl,
        publishDate: postDate,
        westEndTheatreScore: `${r.stars}/5 stars`,
        westEndTheatreExcerpt: r.excerpt || null,
        originalScore: `${r.stars}/5 stars`,
        fullText: null,
        isFullReview: false,
        assignedScore: null,
        source: 'westendtheatre',
      };

      if (dryRun) {
        const existing = findExistingReviewFile(
          path.join(reviewTextsDir, show.id),
          outletId,
          r.critic || null
        );
        console.log(`  ${existing ? '🔄' : '🆕'} ${outletId}${r.critic ? ' (' + r.critic + ')' : ''} — ${r.stars}/5`);
      } else {
        saveReview(review);
        console.log(`  ✅ ${outletId}${r.critic ? ' (' + r.critic + ')' : ''} — ${r.stars}/5`);
      }
    }
  }

  console.log('\n─── Summary ───');
  console.log(`  API pages:      ${stats.apiPages}`);
  console.log(`  Total posts:    ${stats.totalPosts}`);
  console.log(`  Matched shows:  ${stats.matchedShows}`);
  console.log(`  No match:       ${stats.skippedNoMatch}`);
  console.log(`  No table:       ${stats.skippedNoTable}`);
  if (!dryRun) {
    console.log(`  New reviews:    ${stats.newReviews}`);
    console.log(`  Updated:        ${stats.updatedReviews}`);
  }
  if (stats.errors.length > 0) {
    console.log(`  Errors:         ${stats.errors.length}`);
    stats.errors.forEach(e => console.log(`    ⚠️  ${e}`));
  }
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
