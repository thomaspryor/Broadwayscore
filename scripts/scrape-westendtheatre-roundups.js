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
const { matchTitleToShow, loadShows } = require('./lib/show-matching');
const {
  normalizeOutlet,
  findExistingReviewFile,
  getOutletDisplayName,
} = require('./lib/review-normalization');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { fetchJSON: scraperFetchJSON, fetchPage, cleanup } = require('./lib/scraper');
const { parseTimeBudgetMin, createRunBudget } = require('./lib/run-budget');

const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const archiveDir = path.join(__dirname, '../data/aggregator-archive/westendtheatre');
// Negative-result cache: posts whose ratings required a rendered-page fetch
// but yielded nothing get NO archive file, so without this they were
// re-fetched every weekly run — a monotonically growing set that blew the
// 30-min workflow timeout. Keyed by WP post id; invalidated when the post's
// `modified` stamp changes or the entry ages past NO_RATINGS_RECHECK_DAYS
// (slow self-heal for transient fetch failures cached as negatives).
const noRatingsCachePath = path.join(archiveDir, '_no-ratings-cache.json');
const NO_RATINGS_RECHECK_DAYS = 45;

const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const timeBudget = createRunBudget(parseTimeBudgetMin(args));

const RATE_LIMIT_MS = 1500;
const API_PAGE_DELAY_MS = 3000;
const WP_API_BASE = 'https://www.westendtheatre.com/wp-json/wp/v2';
const PER_PAGE = 50;
const REVIEWS_CATEGORY = 10;

const stats = {
  apiPages: 0,
  totalPosts: 0,
  matchedShows: 0,
  newReviews: 0,
  updatedReviews: 0,
  skippedNoMatch: 0,
  skippedLowConfidence: 0,
  skippedContentMismatch: 0,
  skippedNoTable: 0,
  skippedCachedNoRatings: 0,
  pageFetches: 0,
  unprocessedPosts: 0,
  errors: [],
};

function loadNoRatingsCache() {
  try {
    const c = JSON.parse(fs.readFileSync(noRatingsCachePath, 'utf8'));
    return { posts: c.posts || {} };
  } catch { return { posts: {} }; }
}

function saveNoRatingsCache(cache) {
  if (dryRun) return;
  try {
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(noRatingsCachePath, JSON.stringify({
      updatedAt: new Date().toISOString(),
      posts: cache.posts,
    }, null, 2) + '\n');
  } catch (e) {
    console.log(`  ⚠️  Could not save no-ratings cache: ${e.message}`);
  }
}

function isCachedNoRatings(cache, post, now = Date.now) {
  const entry = cache.posts[post.id];
  if (!entry) return false;
  if (entry.modified !== (post.modified || post.date)) return false; // post updated → recheck
  const ageDays = (now() - new Date(entry.checkedAt).getTime()) / 86_400_000;
  return ageDays < NO_RATINGS_RECHECK_DAYS;
}

// --- HTTP helpers ---

/**
 * Fetch JSON from WordPress API using the shared scraper proxy chain.
 * ScrapingBee (1 credit, render_js=false) bypasses Sucuri WAF that blocks direct requests.
 * Falls back to direct fetch if no API key.
 *
 * Pagination: count-based (no WP headers needed — ScrapingBee doesn't expose them).
 * If a page returns PER_PAGE results, there's likely another page.
 */
async function fetchWpApiPage(url) {
  try {
    const data = await scraperFetchJSON(url);
    if (data && data.code === 'rest_post_invalid_page_number') {
      return [];
    }
    return Array.isArray(data) ? data : [];
  } catch (e) {
    // ScrapingBee may return the Sucuri challenge as HTML → JSON parse fails
    if (e.message.includes('JSON parse') || e.message.includes('all methods failed')) {
      console.log(`  ⚠️  API fetch failed (likely WAF): ${e.message}`);
    }
    throw e;
  }
}

/**
 * Fetch rendered page HTML for posts where review content is JS-rendered.
 * Uses the shared scraper (Playwright → Bright Data → ScrapingBee fallback).
 */
async function fetchRenderedPageHtml(url) {
  try {
    const result = await fetchPage(url, { preferPlaywright: true });
    return result?.content || null;
  } catch (e) {
    console.log(`  ⚠️  Page fetch failed: ${e.message}`);
    return null;
  }
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
 *
 * WET uses many title patterns. Real examples from the API:
 *   "Into the Woods Reviews Round-up – Bridge Theatre London [Updated]"
 *   "Oliver! in the West End Reviews Round-up – Gielgud Theatre London [Updated]"
 *   "Oh, Mary! Reviews: Is it the most outrageous comedy in London?"
 *   "American Psycho reviews: Is Rupert Goold's 2026 London revival a killer?"
 *   "Reviews round-up of The Comedy About Spies in the West End [Updated]"
 *   "Summerfolk reviews: What do the critics think of the National Theatre's new production?"
 *   "Romeo & Juliet" (simple, no cruft)
 */
function extractShowTitle(wpTitle) {
  let title = stripHtml(wpTitle);

  // Strip [Updated] tag (very common in WET)
  title = title.replace(/\s*\[Updated\]\s*/gi, ' ').trim();

  // Strip trailing star ratings: ★★★★ or ★★★★★
  title = title.replace(/\s*★+\s*$/, '').trim();

  // Strip common review prefixes
  title = title
    .replace(/^reviews?\s+of\s+/i, '')
    .replace(/^reviews?\s+round-?up\s+of\s+/i, '')
    .replace(/^reviews?\s+round-?up:?\s*/i, '')
    .replace(/^reviews?:\s*/i, '')
    .replace(/^review\s+roundup:\s*/i, '')
    .replace(/^what the critics (are )?say(ing)? about\s+/i, '')
    .replace(/^what the critics think (about|of)\s+/i, '')
    .replace(/^what do the critics (think|say) (about|of)\s+/i, '')
    .replace(/^critics (on|review)\s+/i, '')
    .replace(/^the reviews are in for\s+/i, '')
    .replace(/^west end reviews?\s+of\s+/i, '')
    .trim();

  // Strip middle/trailing review cruft:
  //   "X Reviews Round-up – Y" → "X"
  //   "X reviews: subtitle here" → "X"
  //   "X in the West End Reviews Round-up" → "X"
  //   "X – Reviews Round-up" → "X"
  title = title
    .replace(/\s+reviews?\s+round-?up\b.*$/i, '')       // "X Reviews Round-up – venue"
    .replace(/\s+reviews?:\s+.+$/i, '')                   // "X reviews: Is it the best..."
    .replace(/\s+in\s+(the\s+)?west\s+end\b.*$/i, '')    // "X in the West End ..."
    .replace(/\s+in\s+london\b.*$/i, '')                  // "X in London"
    .trim();

  // Strip trailing " starring ...", " at the [Venue]", " – reviews"
  title = title
    .replace(/\s+starring\s+.+$/i, '')
    .replace(/\s+at\s+(the\s+)?west\s+end'?s?\b.*$/i, '')   // "at the West End's Theatre Royal"
    .replace(/\s+at\s+(the\s+)?(donmar|bridge|national|old vic|young vic|soho|gielgud|garrick|apollo|lyceum|lyric|savoy|noël coward|noel coward|harold pinter|wyndham|duchess|duke of york|fortune|vaudeville|criterion|adelphi|gillian lynne|phoenix|dominion|piccadilly|victoria palace|kit kat club|barbican|sadler'?s wells|menier|almeida|bush|kiln|hampstead|prince edward|prince of wales|theatre royal|shakespeare'?s globe|royal court|ambassadors)\b.*$/i, '')
    .replace(/\s+at\s+(the\s+)?[\w'-]+(\s+[\w'-]+){0,3}\s*(theatre|theater|playhouse|palace|house|hall|studio|space|centre|center|warehouse)$/i, '')
    .replace(/\s*[-–—]\s*reviews?\s*(round-?up)?$/i, '')  // "– Reviews" or "– Reviews Round-up"
    .replace(/\s*[-–—]\s*$/i, '')                          // trailing dash
    .replace(/\s+reviews?\s*(round-?up)?$/i, '')           // "reviews" or "reviews round-up"
    .replace(/\s+west\s+end$/i, '')                         // trailing "West End" (market, not title)
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
 * Extract reviews from section-format posts (rendered page HTML).
 * The rendered page uses structured CSS classes:
 *   div.reviewnewpubhead = outlet name
 *   div.reviewnewstars = ★ characters (1-5)
 *   div.reviewnewquote = excerpt text
 *   div.reviewnewauthor = "Critic Name, Outlet"
 *   <a href="..."> after author = review URL
 *
 * Falls back to text-based ★ parsing if no CSS classes found.
 */
function extractSectionReviews(htmlContent) {
  const cheerio = require('cheerio');
  const $ = cheerio.load(htmlContent);
  const reviews = [];

  // Strategy 1: Use CSS classes (rendered page from westendtheatre.com)
  const pubHeads = $('.reviewnewpubhead');
  if (pubHeads.length > 0) {
    pubHeads.each((_, el) => {
      const $pub = $(el);
      const outlet = $pub.text().trim();
      if (!outlet || outlet.length < 2) return;

      const starsText = $pub.next('.reviewnewstars').text().trim();
      const stars = (starsText.match(/★/g) || []).length;
      if (stars === 0) return;

      const $quote = $pub.nextAll('.reviewnewquote').first();
      const excerptText = $quote.text().trim();
      const excerpts = [];
      const qr = /[""\u201c]([^""\u201d]+)[""\u201d]/g;
      let qm;
      while ((qm = qr.exec(excerptText)) !== null) {
        if (qm[1].trim().length > 15) excerpts.push(qm[1].trim());
      }
      const excerpt = excerpts.join(' … ').substring(0, 800) || excerptText.substring(0, 300);

      const authorText = $pub.nextAll('.reviewnewauthor').first().text().trim();
      let critic = null;
      if (authorText) {
        const cm = authorText.match(/^([A-Z][a-z]+(?:\s[A-Z][a-z'-]+)+)/);
        if (cm) critic = cm[1].trim();
      }

      let reviewUrl = null;
      const $authorDiv = $pub.nextAll('.reviewnewauthor').first();
      const $link = $authorDiv.next('a[href]');
      if ($link.length) {
        const href = $link.attr('href');
        if (href && !href.includes('westendtheatre.com')) reviewUrl = href;
      }

      reviews.push({ outlet, stars, critic, excerpt, reviewUrl });
    });

    return reviews;
  }

  // Strategy 2: Text-based fallback (for content with ★ but no CSS classes)
  const text = stripHtml(htmlContent);
  const starRegex = /(★{1,5})/g;
  let starMatch;
  const starPositions = [];
  while ((starMatch = starRegex.exec(text)) !== null) {
    starPositions.push({ idx: starMatch.index, stars: starMatch[1].length });
  }

  for (let i = 0; i < starPositions.length; i++) {
    const { idx, stars } = starPositions[i];
    const beforeStars = text.substring(Math.max(0, idx - 200), idx).trim();
    const outletLine = beforeStars.split('\n').filter(l => l.trim()).pop()?.trim() || '';
    if (!outletLine || outletLine.length < 2 || outletLine.length > 50) continue;
    if (outletLine.startsWith('"') || outletLine.startsWith('\u201c')) continue;

    reviews.push({ outlet: outletLine, stars, critic: null, excerpt: null, reviewUrl: null });
  }

  return reviews;
}

/**
 * Save a review file, merging with existing if present.
 */
function saveReview(review) {
  const result = createOrMergeReviewFile(review.showId, {
    outlet: review.outlet,
    outletId: review.outletId,
    criticName: review.criticName,
    url: review.url,
    source: review.source || 'westendtheatre-roundup',
    fields: {
      westEndTheatreScore: review.westEndTheatreScore || null,
      westEndTheatreExcerpt: review.westEndTheatreExcerpt || null,
      aggregatorStars: review.aggregatorStars || null,
      publishDate: review.publishDate || null,
    },
  }, {
    onMerge(existing, input) {
      // WET is an aggregator — never write to originalScore (P0 slot).
      // Only update aggregatorStars metadata.
      if (input.fields?.aggregatorStars) {
        existing.aggregatorStars = input.fields.aggregatorStars;
      }
    },
  });

  if (result.action === 'new') stats.newReviews++;
  else if (result.action === 'updated') stats.updatedReviews++;

  return result.filepath;
}

// --- Main ---

async function main() {
  const shows = loadShows();
  const allShows = Array.isArray(shows) ? shows : Object.values(shows);

  console.log('📰 WestEndTheatre.com Review Roundup Scraper');
  console.log(`   Dry run: ${dryRun}`);
  console.log('');

  if (!dryRun) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  // Fetch all roundup posts via WP API (paginated, count-based)
  const allPosts = [];
  let page = 1;
  const MAX_PAGES = 30; // Safety limit (~1500 posts)

  console.log('📡 Fetching review roundup posts from WordPress API...\n');

  while (page <= MAX_PAGES) {
    const url = `${WP_API_BASE}/posts?categories=${REVIEWS_CATEGORY}&per_page=${PER_PAGE}&page=${page}`;
    try {
      const posts = await fetchWpApiPage(url);
      stats.apiPages++;

      if (posts.length === 0) break;

      allPosts.push(...posts);
      console.log(`  Page ${page}: ${posts.length} posts (${allPosts.length} total)`);

      // If we got fewer than PER_PAGE, this was the last page
      if (posts.length < PER_PAGE) break;

      page++;
      await sleep(API_PAGE_DELAY_MS);
    } catch (e) {
      console.error(`  ❌ API error on page ${page}: ${e.message}`);
      stats.errors.push(`API page ${page}: ${e.message}`);
      break;
    }
  }

  stats.totalPosts = allPosts.length;
  console.log(`\n   Total roundup posts: ${allPosts.length}\n`);

  // Zero-data guard: if API returned 0 posts, something is wrong (WAF, API change, etc.)
  // Don't silently succeed — alert so the issue is caught quickly, not after weeks.
  if (allPosts.length === 0 && !showFilter) {
    console.error('❌ ZERO POSTS fetched from WET API — likely WAF block or API change. Failing.');
    process.exit(1);
  }

  // Process each post
  const noRatingsCache = loadNoRatingsCache();
  for (let i = 0; i < allPosts.length; i++) {
    if (timeBudget.exceeded()) {
      stats.unprocessedPosts = allPosts.length - i;
      console.log(`\n⏱ Time budget (${timeBudget.minutes} min) reached — ${stats.unprocessedPosts} posts deferred to next run. If this recurs weekly, the no-ratings cache or archive checkout is not persisting; investigate before raising the budget.`);
      break;
    }
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

    // Match to our shows — require high confidence to prevent wrong-show contamination.
    // Medium-confidence (word-based fuzzy) matches caused 27 wrong-show archives (e.g.,
    // Mamma Mia archive had Into the Woods reviews, Matilda had Paddington).
    const matchResult = matchTitleToShow(showTitle, allShows, { market: 'west-end' });
    if (!matchResult || !matchResult.show) {
      stats.skippedNoMatch++;
      if (showFilter || dryRun) console.log(`  [NO MATCH] "${showTitle}" (from: ${stripHtml(wpTitle)})`);
      continue;
    }

    if (matchResult.confidence !== 'high') {
      stats.skippedLowConfidence++;
      console.log(`  [LOW CONFIDENCE] "${showTitle}" → ${matchResult.show.title} (${matchResult.confidence}) — skipped`);
      continue;
    }

    const show = matchResult.show;

    // Content validation: verify the matched show's title actually appears in the
    // post title or body. Prevents wrong-show archives when extractShowTitle strips
    // too aggressively and the matcher finds a spurious exact match.
    const postText = (stripHtml(wpTitle) + ' ' + stripHtml(htmlContent)).toLowerCase();
    const showTitleLower = show.title.toLowerCase();
    // Check: show title (or its significant words) appear in the post
    const significantWords = showTitleLower
      .replace(/^the\s+/i, '')
      .split(/[\s,]+/)
      .filter(w => w.length > 2 && !['the', 'a', 'an', 'musical', 'play'].includes(w));
    // For short-titled shows (MJ, Six) where no significant words survive filtering,
    // fall back to checking if the full title appears as a substring in the post text.
    const wordsFound = significantWords.filter(w => postText.includes(w)).length;
    const contentMatch = significantWords.length === 0
      ? postText.includes(showTitleLower)
      : wordsFound >= Math.ceil(significantWords.length * 0.5);
    if (!contentMatch) {
      stats.skippedContentMismatch++;
      console.log(`  [CONTENT MISMATCH] "${showTitle}" matched ${show.title} but post lacks show words — skipped`);
      continue;
    }

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
      // Fallback: try section-format extraction from API HTML
      const sectionReviews = extractSectionReviews(htmlContent);
      if (sectionReviews.length > 0) {
        ratings = sectionReviews;
        usedSectionFormat = true;
      }
    }

    // If still no ratings, the review content is JS-rendered (not in API).
    // Fetch the actual page HTML as last resort — unless a previous run
    // already fetched this exact post version and found nothing.
    let pageFetchSucceeded = false;
    if (ratings.length === 0 && postUrl) {
      if (!force && isCachedNoRatings(noRatingsCache, post)) {
        stats.skippedCachedNoRatings++;
        continue;
      }
      console.log(`  [FETCH PAGE] ${show.title} — API has no ratings, fetching rendered page...`);
      stats.pageFetches++;
      const pageHtml = await fetchRenderedPageHtml(postUrl);
      if (pageHtml) {
        pageFetchSucceeded = true;
        const pageRatings = extractSectionReviews(pageHtml);
        if (pageRatings.length > 0) {
          ratings = pageRatings;
          usedSectionFormat = true;
          console.log(`    ✓ ${pageRatings.length} ratings from rendered page`);
        }
      }
      await sleep(RATE_LIMIT_MS);
    }

    if (ratings.length === 0) {
      stats.skippedNoTable++;
      // Cache the negative ONLY when we actually got page HTML and found no
      // ratings in it. A failed fetch (WAF block, proxy outage) must stay
      // uncached or one bad week becomes a 45-day blind spot for the backlog.
      if (postUrl && pageFetchSucceeded && !dryRun) {
        noRatingsCache.posts[post.id] = {
          modified: post.modified || post.date,
          checkedAt: new Date().toISOString(),
          url: postUrl,
        };
        saveNoRatingsCache(noRatingsCache);
      }
      continue;
    }
    if (noRatingsCache.posts[post.id]) {
      delete noRatingsCache.posts[post.id];
      saveNoRatingsCache(noRatingsCache);
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
        extractedTitle: showTitle,
        matchConfidence: matchResult.confidence,
        postUrl,
        postDate,
        ratings,
        fetchedAt: new Date().toISOString().slice(0, 10),
      };
      fs.writeFileSync(archivePath, JSON.stringify(archiveData, null, 2) + '\n');
    }

    // Create review files for each rating
    for (const r of ratings) {
      let outletId = normalizeOutlet(r.outlet);
      // WET is a WE-only aggregator — bare "Time Out" always means Time Out London, not TONY
      if (outletId === 'timeout') outletId = 'timeout-london';
      const outletName = getOutletDisplayName(outletId) || r.outlet;

      const review = {
        showId: show.id,
        outletId,
        outlet: outletName,
        criticName: r.critic || null,
        url: r.reviewUrl || null, // Don't fall back to WET roundup URL — it's not the outlet's review
        publishDate: postDate,
        westEndTheatreScore: `${r.stars}/5 stars`,
        westEndTheatreExcerpt: r.excerpt || null,
        originalScore: null,
        aggregatorStars: `${r.stars}/5 stars`,
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
  console.log(`  Low confidence: ${stats.skippedLowConfidence}`);
  console.log(`  Content mismatch: ${stats.skippedContentMismatch}`);
  console.log(`  No table:       ${stats.skippedNoTable}`);
  console.log(`  Cached no-ratings skips: ${stats.skippedCachedNoRatings}`);
  console.log(`  Rendered-page fetches:   ${stats.pageFetches}`);
  if (stats.unprocessedPosts > 0) {
    console.log(`  ⏱ Unprocessed (time budget): ${stats.unprocessedPosts}`);
  }
  if (!dryRun) {
    console.log(`  New reviews:    ${stats.newReviews}`);
    console.log(`  Updated:        ${stats.updatedReviews}`);
  }
  if (stats.errors.length > 0) {
    console.log(`  Errors:         ${stats.errors.length}`);
    stats.errors.forEach(e => console.log(`    ⚠️  ${e}`));
  }
}

module.exports = { extractStarRatings, extractSectionReviews, extractShowTitle, stripHtml, fetchRenderedPageHtml, isCachedNoRatings, NO_RATINGS_RECHECK_DAYS };

if (require.main === module) {
  main()
    .then(() => cleanup())
    .then(() => process.exit(0))  // fetchPage() uses Playwright which hangs node
    .catch(e => {
      console.error('Fatal error:', e);
      cleanup().finally(() => process.exit(1));
    });
}
