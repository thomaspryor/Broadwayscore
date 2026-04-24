#!/usr/bin/env node
/**
 * BWW Reviews & Roundup Scraper
 *
 * Discovers reviews from BroadwayWorld via two page types:
 *
 * 1. /reviews/ Pages (e.g., /reviews/The-Lion-King)
 *    - 3-6 reviews with BWW 1-10 scores, review URLs, critic/outlet/date, excerpts
 *    - Discovery: direct URL construction (no Google)
 *
 * 2. Review Roundup Articles (e.g., /article/Review-Roundup-...-YYYYMMDD)
 *    - 10-20+ reviews with excerpts, review URLs, critic/outlet
 *    - New format (~2023+): thumb images (up/middle/down) + Average Rating %
 *    - Old format (pre-2023): plain text, no thumbs/scores
 *    - Discovery: Google search
 *
 * Usage:
 *   node scripts/scrape-bww-reviews.js                    # Both types, all shows
 *   node scripts/scrape-bww-reviews.js --type=reviews      # /reviews/ pages only
 *   node scripts/scrape-bww-reviews.js --type=roundup      # Roundup articles only
 *   node scripts/scrape-bww-reviews.js --shows=X,Y,Z       # Targeted
 *   node scripts/scrape-bww-reviews.js --limit=200 --force  # Batch with cache override
 *   node scripts/scrape-bww-reviews.js --verify             # Process 5 shows, print diff
 *   node scripts/scrape-bww-reviews.js --dry-run            # Parse only, no file writes
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');
const { serpQuery } = require('./lib/url-discovery');
const { matchTitleToShow, loadShows, titleWordsMatch } = require('./lib/show-matching');
const { validatePageMatchesShow } = require('./lib/page-validator');
const { normalizeOutlet, normalizeCritic, generateReviewFilename, findExistingReviewFile, isJunkOutlet, maybeUpgradeUrl } = require('./lib/review-normalization');
const { canonicalizeCritic } = require('./lib/critic-canonicalization');
const { classifyContentTier } = require('./lib/content-quality');
const { isNotBroadway, isUrlYearOutsideWindow } = require('./lib/content-filters');
const { isLondonMarket } = require('./lib/venue-classification');
const { fetchPage, cleanup: cleanupScraper } = require('./lib/scraper');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');
const { isBWWRoundupContent } = require('./lib/bww-roundup-validator');

// Paths
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const reviewsArchiveDir = path.join(__dirname, '../data/aggregator-archive/bww-reviews');
const roundupArchiveDir = path.join(__dirname, '../data/aggregator-archive/bww-roundups');
const showsPath = path.join(__dirname, '../data/shows.json');

// API keys
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

// Stats
const stats = {
  showsProcessed: 0,
  reviewsPagesFetched: 0,
  reviewsPagesHit: 0,
  reviewsPagesMiss: 0,
  roundupsFetched: 0,
  roundupsHit: 0,
  roundupsMiss: 0,
  googleSearches: 0,
  reviewsExtracted: 0,
  newReviews: 0,
  updatedReviews: 0,
  skippedExisting: 0,
  skippedGuards: 0,
  errors: [],
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Detect garbage outlet names that BWW roundup parsing can produce.
 * These are sentence fragments, photo credits, or other non-outlet text
 * that the regex extractors sometimes match.
 */
// isGarbageOutlet removed — now using centralized isJunkOutlet from review-normalization.js

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * Fetch HTML with ScrapingBee (fast, no JS render) → shared fetchPage() fallback.
 * ScrapingBee is tried first for BWW because it's cheaper and BWW /reviews/ pages
 * don't need JS rendering. If SB is unavailable or fails, fetchPage() provides
 * BrightData → Playwright fallback chain.
 */
async function fetchHtmlViaSB(url) {
  if (!SCRAPINGBEE_KEY) return null;
  const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=false`;
  return new Promise((resolve, reject) => {
    const req = https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else if (res.statusCode === 404 || res.statusCode === 410) resolve(null);
        else reject(new Error(`SB HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('SB Timeout')); });
  });
}

async function fetchHtml(url, maxRetries = 2) {
  // Attempt 1: ScrapingBee (cheap, no JS render)
  if (SCRAPINGBEE_KEY) {
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fetchHtmlViaSB(url);
      } catch (e) {
        lastError = e;
        if (attempt < maxRetries) {
          const delay = 3000 * (attempt + 1);
          await sleep(delay);
        }
      }
    }
    console.log(`    [WARN] ScrapingBee exhausted for ${url.slice(0, 60)}: ${lastError.message.slice(0, 60)}`);
  }

  // Attempt 2: Shared fetchPage() fallback chain (BrightData → Playwright)
  try {
    const result = await fetchPage(url);
    return result ? result.content : null;
  } catch (e) {
    throw new Error(`All fetch methods failed for ${url.slice(0, 60)}: ${e.message.slice(0, 80)}`);
  }
}

async function googleSearch(query, numResults = 10) {
  try {
    const results = await serpQuery(query, { nbResults: numResults });
    if (!results) return [];
    return results.map(r => r.url).filter(Boolean);
  } catch (e) {
    console.log(`  Google search error: ${e.message}`);
    return [];
  }
}

/**
 * Search BWW's own internal search for review roundups.
 * This catches roundups that Google doesn't surface.
 */
async function bwwInternalSearch(showTitle) {

  const searchQuery = `${showTitle} review roundup`;
  const searchUrl = `https://www.broadwayworld.com/search/?q=${encodeURIComponent(searchQuery)}&searchtype=articles`;

  try {
    const html = await fetchHtml(searchUrl);
    if (!html) return [];

    const $ = cheerio.load(html);
    const urls = [];

    // BWW search results contain links with "Review-Roundup" in the URL
    $('a[href*="Review-Roundup"], a[href*="review-roundup"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && href.includes('/article/')) {
        // Normalize to full URL
        const fullUrl = href.startsWith('http') ? href : `https://www.broadwayworld.com${href}`;
        if (!urls.includes(fullUrl)) urls.push(fullUrl);
      }
    });

    // Also check for any review article links as fallback
    if (urls.length === 0) {
      $('a[href*="/article/"]').each((_, el) => {
        const href = $(el).attr('href');
        if (href && (href.includes('Review') || href.includes('review'))) {
          const fullUrl = href.startsWith('http') ? href : `https://www.broadwayworld.com${href}`;
          if (!urls.includes(fullUrl)) urls.push(fullUrl);
        }
      });
    }

    return urls;
  } catch (err) {
    console.log(`    [WARN] BWW internal search failed: ${err.message.slice(0, 80)}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Production guards (shared with playbill-verdict)
// ---------------------------------------------------------------------------

// isNotBroadway() imported from ./lib/content-filters
// extractUrlYear/isUrlYearValid REMOVED — violates CLAUDE.md Rule 6 (never extract metadata from URLs)

// ---------------------------------------------------------------------------
// /reviews/ page: URL construction
// ---------------------------------------------------------------------------

function constructBwwReviewsSlugs(show) {
  const title = show.title;
  const slugs = [];

  // Primary: basic title → dashes
  const base = title
    .replace(/['']/g, '')
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
  slugs.push(base);

  // Without subtitle (after colon or dash)
  const noSubtitle = title.replace(/[:–—]\s+.+$/, '').trim();
  if (noSubtitle !== title) {
    const noSubSlug = noSubtitle
      .replace(/['']/g, '')
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
    slugs.push(noSubSlug);
  }

  // Without leading "The"
  if (title.match(/^The\s+/i)) {
    const noThe = title.replace(/^The\s+/i, '');
    const noTheSlug = noThe
      .replace(/['']/g, '')
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
    slugs.push(noTheSlug);
  }

  // Deduplicate
  return [...new Set(slugs)];
}

// ---------------------------------------------------------------------------
// /reviews/ page: Fetch and extract
// ---------------------------------------------------------------------------

async function fetchBwwReviewsPage(show, showId, options = {}) {
  const archivePath = path.join(reviewsArchiveDir, `${showId}.html`);

  // Check cache freshness
  if (!options.force && fs.existsSync(archivePath)) {
    const age = (Date.now() - fs.statSync(archivePath).mtimeMs) / (1000 * 60 * 60 * 24);
    if (age < 14) {
      console.log(`  [CACHE] /reviews/ for ${showId}`);
      return fs.readFileSync(archivePath, 'utf8');
    }
  }

  const slugs = constructBwwReviewsSlugs(show);
  for (const slug of slugs) {
    const url = `https://www.broadwayworld.com/reviews/${slug}`;
    try {
      stats.reviewsPagesFetched++;
      const html = await fetchHtml(url);
      if (html && html.includes('feedbacks')) {
        // Validate page is actually about this show
        const validation = await validatePageMatchesShow(html, show.title, {
          openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null,
          pageUrl: url,
        });
        if (!validation.valid) {
          console.log(`  [SKIP] /reviews/${slug} wrong show: ${validation.reason}`);
          continue;
        }
        // Archive and return
        if (!options.dryRun) {
          if (!fs.existsSync(reviewsArchiveDir)) fs.mkdirSync(reviewsArchiveDir, { recursive: true });
          fs.writeFileSync(archivePath, html);
        }
        stats.reviewsPagesHit++;
        console.log(`  [HIT] /reviews/${slug}`);
        return html;
      }
      // Page exists but no review content — try next slug
      if (html) {
        console.log(`  [MISS] /reviews/${slug} (no review content)`);
      }
    } catch (err) {
      if (!err.message.includes('404') && !err.message.includes('410')) {
        console.log(`  [WARN] /reviews/${slug}: ${err.message.slice(0, 80)}`);
      }
    }
    await sleep(1500);
  }

  stats.reviewsPagesMiss++;
  return null;
}

function extractBwwReviewsPageData(html, showId) {
  const reviews = [];
  const $ = cheerio.load(html);

  // Extract from HTML: div.feedbacks > div.one-feed blocks
  $('div.one-feed').each((_, el) => {
    const $el = $(el);

    // Score: div.score (1-10 integer)
    const scoreText = $el.find('div.score').text().trim();
    const bwwScore = parseInt(scoreText);

    // URL + title: p.title a
    const titleLink = $el.find('p.title a');
    const url = titleLink.attr('href') || null;
    const reviewTitle = titleLink.text().trim();

    // Outlet, critic, date from div.sub-info
    const subInfo = $el.find('div.sub-info').text();
    const fromMatch = subInfo.match(/From:\s*([^|]+)/);
    const byMatch = subInfo.match(/By:\s*([^|]+)/);
    const dateMatch = subInfo.match(/Date:\s*(.+)/);

    const outlet = fromMatch ? fromMatch[1].trim() : '';
    const critic = byMatch ? byMatch[1].trim() : '';
    const date = dateMatch ? dateMatch[1].trim() : '';

    // Excerpt from div.text
    const excerpt = $el.find('div.text').text().trim();

    if (!outlet || !excerpt) return;

    reviews.push({
      showId,
      url,
      reviewTitle,
      outlet,
      critic,
      date,
      excerpt,
      bwwScore: isNaN(bwwScore) ? null : bwwScore,
      source: 'bww-reviews',
    });
  });

  // Also extract aggregate rating from JSON-LD if available
  let aggregateRating = null;
  try {
    $('script[type="application/ld+json"]').each((_, el) => {
      const json = JSON.parse($(el).html());
      if (json.aggregateRating && json.aggregateRating.ratingValue) {
        aggregateRating = json.aggregateRating.ratingValue;
      }
    });
  } catch (e) { /* ignore JSON-LD parse errors */ }

  return { reviews, aggregateRating };
}

// ---------------------------------------------------------------------------
// Roundup articles: Discovery
// ---------------------------------------------------------------------------

async function discoverBwwRoundup(show, showId, options = {}) {
  const archivePath = path.join(roundupArchiveDir, `${showId}.html`);

  // Check cache freshness
  if (!options.force && fs.existsSync(archivePath)) {
    const age = (Date.now() - fs.statSync(archivePath).mtimeMs) / (1000 * 60 * 60 * 24);
    if (age < 14) {
      console.log(`  [CACHE] roundup for ${showId}`);
      return fs.readFileSync(archivePath, 'utf8');
    }
  }

  // Search for roundup article via Google + BWW internal search
  const year = show.openingDate ? new Date(show.openingDate).getFullYear() : '';
  let searchTitle = show.title
    .replace(/\s+at\s+the\s+.+$/i, '')
    .replace(/:\s+.+$/, '')
    .replace(/\s+[–—]\s+.+$/, '');

  // Title words for URL validation (prevents cross-show contamination)
  const titleWords = searchTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !['the', 'and', 'for', 'new', 'broadway'].includes(w));

  // Collect candidate URLs from multiple sources
  let allCandidateUrls = [];

  // Source 1: Google search (10 results)
  const query = `site:broadwayworld.com/article "Review Roundup" "${searchTitle}" broadway ${year}`;
  try {
    stats.googleSearches++;
    const googleUrls = await googleSearch(query, 10);
    allCandidateUrls.push(...googleUrls);
  } catch (err) {
    console.log(`  [WARN] Google search for ${showId}: ${err.message.slice(0, 80)}`);
  }

  // Source 2: BWW internal search (catches what Google misses)
  if (allCandidateUrls.filter(u => u.includes('Review-Roundup') || u.includes('review-roundup')).length === 0) {
    try {
      const bwwUrls = await bwwInternalSearch(searchTitle);
      // Add only URLs not already found via Google
      for (const url of bwwUrls) {
        if (!allCandidateUrls.includes(url)) {
          allCandidateUrls.push(url);
        }
      }
      if (bwwUrls.length > 0) {
        console.log(`  [BWW-SEARCH] Found ${bwwUrls.length} additional candidate(s) for ${showId}`);
      }
      await sleep(1500);
    } catch (err) {
      // Non-fatal — Google results may still work
    }
  }

  // Filter to roundup URLs only
  const roundupUrls = allCandidateUrls.filter(u => u.includes('Review-Roundup') || u.includes('review-roundup'));

  if (roundupUrls.length === 0) {
    stats.roundupsMiss++;
    return null;
  }

  // Validate URL slug matches show title using robust word matching
  // Also reject tour/regional roundup articles (e.g., "National-Tour-of-...", "on-Tour")
  const validRoundupUrls = roundupUrls.filter(url => {
    const urlSlug = (url.split('/article/')[1] || '').replace(/-/g, ' ').toLowerCase();
    if (!titleWordsMatch(searchTitle, urlSlug)) return false;
    // General non-Broadway check (tours, streaming, off-Broadway, etc.)
    // For off-Broadway shows, allow off-Broadway content through
    if (isNotBroadway(urlSlug, { allowOffBroadway: show.category === 'off-broadway', allowWestEnd: isLondonMarket(show.category) })) {
      console.log(`  [SKIP] roundup: non-Broadway article: ${url.split('/article/')[1] || url}`);
      return false;
    }
    // Additional roundup-specific checks (safe in article titles, too aggressive for review text)
    if (/\bon tour\b/.test(urlSlug) || /\bat the kennedy center\b/.test(urlSlug) ||
        /\bat the (ahmanson|old globe|la jolla|goodman|steppenwolf|arena stage)\b/.test(urlSlug)) {
      console.log(`  [SKIP] roundup: non-Broadway venue/tour in title: ${url.split('/article/')[1] || url}`);
      return false;
    }
    return true;
  });

  if (validRoundupUrls.length === 0) {
    console.log(`  [MISS] roundup: no URL slug matches "${searchTitle}"`);
    stats.roundupsMiss++;
    return null;
  }

  // Try the first matching URL (check up to 3 candidates)
  for (const url of validRoundupUrls.slice(0, 3)) {
    try {
      stats.roundupsFetched++;
      const html = await fetchHtml(url);
      if (html && isBWWRoundupContent(html)) {
        // Validate page actually matches show (LLM tiebreaker for edge cases)
        const validation = await validatePageMatchesShow(html, searchTitle, {
          openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null,
          pageUrl: url,
        });
        if (!validation.valid) {
          console.log(`  [SKIP] roundup page doesn't match "${searchTitle}": ${validation.reason}`);
          continue;
        }

        if (!options.dryRun) {
          if (!fs.existsSync(roundupArchiveDir)) fs.mkdirSync(roundupArchiveDir, { recursive: true });
          fs.writeFileSync(archivePath, html);
        }
        stats.roundupsHit++;
        console.log(`  [HIT] roundup: ${url.split('/article/')[1]?.slice(0, 60)}`);
        return html;
      }
    } catch (err) {
      console.log(`  [WARN] roundup fetch: ${err.message.slice(0, 80)}`);
    }
    await sleep(1500);
  }

  stats.roundupsMiss++;
  return null;
}

// ---------------------------------------------------------------------------
// Roundup articles: Extraction (handles both old and new formats)
// ---------------------------------------------------------------------------

function extractBwwRoundupData(html, showId) {
  const reviews = [];
  const $ = cheerio.load(html);

  // Detect format by checking for thumb images
  // BWW uses two image naming schemes:
  //   Old (~pre-2023): uptrans.png, middletrans.png, downtrans.png
  //   New (~2023+): like-button-icon.png, midlike-button-icon.png, dislike-button-icon.png
  const hasOldThumbImages = html.includes('uptrans.png') || html.includes('middletrans.png') || html.includes('downtrans.png');
  const hasNewThumbImages = html.includes('like-button-icon') || html.includes('midlike-button-icon') || html.includes('dislike-button-icon');
  const hasThumbImages = hasOldThumbImages || hasNewThumbImages;
  const hasAverageRating = html.includes('Average Rating:');

  // Extract the roundup URL from canonical link
  const roundupUrl = $('link[rel="canonical"]').attr('href') || $('meta[property="og:url"]').attr('content') || '';

  // Strategy 1: Parse from HTML article body (works for both formats)
  // The article body contains: CriticName, [OutletName](URL): excerpt text
  // With optional thumb images before each review

  // Get the main article content
  const articleBody = $('article, .article-content, .article-body, .entry-content, main').first();
  const container = articleBody.length ? articleBody : $.root();

  // Build review entries by scanning through the content
  // New format has thumb images (uptrans/middletrans/downtrans) before each review
  // Old format uses "CriticName, OutletName:" pattern

  // Collect all links with review URLs + surrounding text
  const allLinks = [];
  container.find('a').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    if (!href || !text) return;
    // Skip internal BWW links, social media, ticketing
    if (href.includes('broadwayworld.com') && !href.includes('/article/BWW-Review')) return;
    if (href.includes('facebook.com') || href.includes('twitter.com') ||
        href.includes('instagram.com') || href.includes('ticketmaster') ||
        href.includes('telecharge') || href.includes('todaytix')) return;
    if (href.length < 20) return;

    allLinks.push({ href, text, el });
  });

  // Method 1: Parse structured format with thumb images
  // Old: <p><img src="uptrans/middletrans/downtrans.png"> CriticName, <a>Outlet:</a> excerpt</p>
  // New: <p><img src="like-button-icon/midlike-button-icon/dislike-button-icon.png" alt="Thumbs Up"> CriticName, <a>Outlet:</a> excerpt</p>
  if (hasThumbImages) {
    const thumbImgs = container.find('img[src*="uptrans"], img[src*="middletrans"], img[src*="downtrans"], img[src*="like-button-icon"], img[src*="midlike-button-icon"], img[src*="dislike-button-icon"]');

    thumbImgs.each((_, img) => {
      const $img = $(img);
      const src = $img.attr('src') || '';
      const alt = ($img.attr('alt') || '').toLowerCase();
      let thumb = null;
      // Old format
      if (src.includes('uptrans')) thumb = 'Up';
      else if (src.includes('middletrans')) thumb = 'Meh';
      else if (src.includes('downtrans')) thumb = 'Down';
      // New format — check src URL first
      else if (src.includes('dislike-button-icon')) thumb = 'Down';
      else if (src.includes('midlike-button-icon')) thumb = 'Meh';
      else if (src.includes('like-button-icon')) thumb = 'Up';
      // Fallback: check alt text (BWW uses dual alt attributes)
      if (!thumb) {
        if (alt.includes('thumbs up')) thumb = 'Up';
        else if (alt.includes('thumbs sideways') || alt.includes('thumbs mid')) thumb = 'Meh';
        else if (alt.includes('thumbs down')) thumb = 'Down';
      }

      // The thumb and review text are in the SAME <p> element
      const parent = $img.closest('p, div, li');
      if (!parent.length) return;

      const textBlock = parent.text().trim();
      if (textBlock.length < 10) return; // Skip image-only paragraphs

      // Extract review URL from the link in this paragraph
      let reviewUrl = null;
      let outletFromLink = '';
      parent.find('a').each((_, a) => {
        if (reviewUrl) return;
        const href = $(a).attr('href');
        if (href && !href.includes('broadwayworld.com')) {
          reviewUrl = href;
          outletFromLink = $(a).text().replace(/:$/, '').trim();
        }
      });

      // Parse: CriticName, OutletName: excerpt
      const criticOutletMatch = textBlock.match(/^([A-Z][a-z'\u2019\-]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z'\u2019\-]+(?:\s+[A-Z][a-z'\u2019\-]+)?),\s*(.+)/s);
      let critic = '';
      let outlet = outletFromLink;
      let excerpt = textBlock;

      if (criticOutletMatch) {
        critic = criticOutletMatch[1].trim();
        const rest = criticOutletMatch[2];
        // Outlet may come from link text or from text before colon
        const colonIdx = rest.indexOf(':');
        if (outlet) {
          // Outlet from link — excerpt is everything after "Outlet:" in the text
          const outletIdx = rest.indexOf(outlet);
          if (outletIdx >= 0) {
            excerpt = rest.slice(outletIdx + outlet.length).replace(/^[:\s]+/, '').trim();
          }
        } else if (colonIdx > 0 && colonIdx < 80) {
          outlet = rest.slice(0, colonIdx).trim();
          excerpt = rest.slice(colonIdx + 1).trim();
        }
      }

      if (!outlet && !critic) return;
      // Reject garbage outlet names at extraction time
      if (isJunkOutlet(outlet)) return;

      reviews.push({
        showId,
        url: reviewUrl,
        outlet: outlet || 'Unknown',
        critic,
        excerpt: excerpt.slice(0, 500),
        bwwThumb: thumb,
        bwwRoundupUrl: roundupUrl,
        source: 'bww-roundup',
      });
    });
  }

  // Method 2: Parse from JSON-LD articleBody (old format)
  if (reviews.length === 0) {
    try {
      let articleBodyText = '';
      let datePublished = '';
      $('script[type="application/ld+json"]').each((_, el) => {
        try {
          const json = JSON.parse($(el).html());
          if (json.articleBody) articleBodyText = json.articleBody;
          if (json.datePublished) datePublished = json.datePublished;
          // Also check @graph array
          if (Array.isArray(json['@graph'])) {
            for (const item of json['@graph']) {
              if (item.articleBody) articleBodyText = item.articleBody;
              if (item.datePublished) datePublished = item.datePublished;
            }
          }
        } catch (e) { /* ignore */ }
      });

      if (articleBodyText) {
        // Find review section — usually starts with "Let's see what the critics had to say"
        const reviewSection = articleBodyText.replace(/.*(?:critics had to say|critics think|reviews are in)[.!…]*\s*/i, '');

        // Parse CriticName, Outlet: ReviewText pattern
        const reviewPattern = /([A-Z][a-z'\-]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z'\-]+(?:\s+[A-Z][a-z'\-]+)?),\s+([A-Za-z][A-Za-z\s&'.]+?):\s*([^]+?)(?=(?:[A-Z][a-z'\-]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z'\-]+,\s+[A-Za-z][A-Za-z\s&'.]+:)|Photo Credit:|$)/g;

        let match;
        const seen = new Set();
        while ((match = reviewPattern.exec(reviewSection)) !== null) {
          const critic = match[1].trim();
          const outlet = match[2].trim();
          const excerpt = match[3].trim().slice(0, 500);

          if (outlet.length < 2) continue;
          // Filter garbage outlet names (isJunkOutlet handles length > 45)
          if (isJunkOutlet(outlet)) continue;
          // Filter false positives
          const outletLower = outlet.toLowerCase();
          if (['in', 'the', 'and', 'but', 'for', 'not', 'all', 'this', 'that', 'with'].includes(outletLower)) continue;

          const key = `${critic}|${outlet}`;
          if (seen.has(key)) continue;
          seen.add(key);

          // Try to find the review URL from HTML links
          let reviewUrl = null;
          for (const link of allLinks) {
            const linkText = link.text.toLowerCase();
            if (linkText.includes(outlet.toLowerCase()) || linkText.includes(critic.split(' ')[1]?.toLowerCase() || '___')) {
              reviewUrl = link.href;
              break;
            }
          }

          reviews.push({
            showId,
            url: reviewUrl,
            outlet,
            critic,
            excerpt,
            bwwRoundupUrl: roundupUrl,
            source: 'bww-roundup',
          });
        }
      }
    } catch (e) {
      console.log(`    [WARN] JSON-LD parse error: ${e.message}`);
    }
  }

  // Method 3: Parse from HTML links + surrounding text (fallback)
  if (reviews.length === 0) {
    // Look for links to external review sites with critic names nearby
    for (const link of allLinks) {
      try {
        const urlObj = new URL(link.href);
        if (urlObj.pathname === '/' || urlObj.pathname === '') continue;

        const domain = urlObj.hostname.replace('www.', '');
        const parentText = $(link.el).parent().text().trim().slice(0, 500);

        // Try to extract critic name from text before the link
        const beforeLink = parentText.split(link.text)[0] || '';
        const criticMatch = beforeLink.match(/([A-Z][a-z'\-]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z'\-]+),?\s*$/);
        const critic = criticMatch ? criticMatch[1].trim() : '';
        const excerpt = parentText.split(link.text).slice(1).join('').replace(/^[:\s]+/, '').trim().slice(0, 500);

        if (excerpt.length < 20) continue;

        reviews.push({
          showId,
          url: link.href,
          outlet: link.text.replace(/:$/, '').trim() || domain,
          critic,
          excerpt,
          bwwRoundupUrl: roundupUrl,
          source: 'bww-roundup',
        });
      } catch (e) { continue; }
    }
  }

  // Extract Average Rating if present
  let averageRating = null;
  const avgMatch = html.match(/Average Rating:\s*([\d.]+)%/);
  if (avgMatch) averageRating = avgMatch[1];

  return { reviews, averageRating, hasThumbImages };
}

// ---------------------------------------------------------------------------
// Save review data
// ---------------------------------------------------------------------------

function saveReview(showId, reviewData, options = {}) {
  if (options.dryRun || options.verify) return 'dry-run';

  const fields = { bwwExcerpt: reviewData.excerpt || null };
  if (reviewData.bwwScore != null) fields.bwwScore = reviewData.bwwScore;
  if (reviewData.bwwThumb) fields.bwwThumb = reviewData.bwwThumb;
  if (reviewData.bwwRoundupUrl) fields.bwwRoundupUrl = reviewData.bwwRoundupUrl;

  // Session 3 #13 — canonicalize known mis-attributions at single-author outlets.
  let criticName = reviewData.critic;
  if (criticName) {
    const oid = normalizeOutlet(reviewData.outlet);
    const canon = canonicalizeCritic(oid, criticName);
    if (canon.canonicalized) {
      console.log(`  [BWW canon] ${canon.from} → ${canon.name} (outletId=${oid})`);
      criticName = canon.name;
    }
  }

  const result = createOrMergeReviewFile(showId, {
    outlet: reviewData.outlet,
    criticName,
    url: reviewData.url,
    source: reviewData.source,
    fields,
  });

  if (result.action === 'new') stats.newReviews++;
  else if (result.action === 'updated') stats.updatedReviews++;
  else if (result.reason === 'junk-outlet') stats.skippedGuards++;
  else if (result.reason?.startsWith('domain-mismatch')) stats.skippedDomainMismatch = (stats.skippedDomainMismatch || 0) + 1;
  else stats.skippedExisting++;

  return result.action === 'skipped' ? 'skipped' : result.action;
}

// ---------------------------------------------------------------------------
// Process a single show
// ---------------------------------------------------------------------------

async function processShow(show, showId, options = {}) {
  // Skip shows in previews — they haven't opened yet, any scraped reviews are wrong-production
  if (show.status === 'previews') {
    console.log(`  [SKIP] ${showId}: Show is in previews (opens ${show.openingDate})`);
    return { reviews: [], roundup: [] };
  }

  // Production date window for URL guards
  const showOpeningYear = show.openingDate ? new Date(show.openingDate).getFullYear() : null;
  const showClosingYear = show.closingDate ? new Date(show.closingDate).getFullYear() : null;

  const results = { reviews: [], roundup: [] };

  // --- /reviews/ page ---
  if (options.type === 'all' || options.type === 'reviews') {
    const html = await fetchBwwReviewsPage(show, showId, options);
    if (html) {
      const { reviews, aggregateRating } = extractBwwReviewsPageData(html, showId);
      stats.reviewsExtracted += reviews.length;
      console.log(`    Extracted ${reviews.length} reviews from /reviews/ page${aggregateRating ? ` (rating: ${aggregateRating})` : ''}`);

      for (const review of reviews) {
        // URL year guard: skip if URL year is clearly outside production window
        if (review.url && isUrlYearOutsideWindow(review.url, showOpeningYear, showClosingYear)) {
          const urlYear = review.url.match(/\/((?:19|20)\d{2})\//)?.[1];
          console.log(`    [SKIP] ${review.outlet}: URL year ${urlYear} outside production window`);
          stats.skippedGuards++;
          continue;
        }

        if (options.verify) {
          results.reviews.push(review);
        } else {
          const result = saveReview(showId, review, options);
          if (result === 'new') console.log(`    [NEW] ${review.outlet}: ${review.critic}`);
          else if (result === 'updated') console.log(`    [UPD] ${review.outlet}: ${review.critic}`);
        }
      }
    }
    await sleep(2000);
  }

  // --- Roundup article ---
  if (options.type === 'all' || options.type === 'roundup') {
    const html = await discoverBwwRoundup(show, showId, options);
    if (html) {
      const { reviews, averageRating, hasThumbImages } = extractBwwRoundupData(html, showId);
      stats.reviewsExtracted += reviews.length;
      const format = hasThumbImages ? 'new' : 'old';
      console.log(`    Extracted ${reviews.length} reviews from roundup (${format} format)${averageRating ? ` (avg: ${averageRating}%)` : ''}`);

      for (const review of reviews) {
        if (review.outlet && isNotBroadway(review.outlet, { allowOffBroadway: show.category === 'off-broadway', allowWestEnd: isLondonMarket(show.category) })) {
          stats.skippedGuards++;
          continue;
        }

        // URL year guard: skip if URL year is clearly outside production window
        if (review.url && isUrlYearOutsideWindow(review.url, showOpeningYear, showClosingYear)) {
          const urlYear = review.url.match(/\/((?:19|20)\d{2})\//)?.[1];
          console.log(`    [SKIP] ${review.outlet}: URL year ${urlYear} outside production window`);
          stats.skippedGuards++;
          continue;
        }

        if (options.verify) {
          results.roundup.push(review);
        } else {
          const result = saveReview(showId, review, options);
          if (result === 'new') console.log(`    [NEW] ${review.outlet}: ${review.critic}`);
          else if (result === 'updated') console.log(`    [UPD] ${review.outlet}: ${review.critic}`);
        }
      }
    }
  }

  stats.showsProcessed++;
  return results;
}

// ---------------------------------------------------------------------------
// Git checkpoint (CI only) — aggregator-archive is now in private repo,
// pushed via push-aggregator-archive action at workflow end (if: always()).
// This function is retained as a no-op so callers don't need updating.
// ---------------------------------------------------------------------------

function gitCheckpoint(count, total, label) {
  // No-op: aggregator-archive is gitignored, pushed by composite action
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== BWW Reviews & Roundup Scraper ===\n');

  // Parse CLI flags
  const args = process.argv.slice(2);
  const showsArg = args.find(a => a.startsWith('--shows='));
  const limitArg = args.find(a => a.startsWith('--limit='));
  const typeArg = args.find(a => a.startsWith('--type='));
  const force = args.includes('--force');
  const dryRun = args.includes('--dry-run');
  const verify = args.includes('--verify');

  const targetShowIds = showsArg ? showsArg.replace('--shows=', '').split(',').map(s => s.trim()).filter(Boolean) : null;
  const limit = limitArg ? parseInt(limitArg.replace('--limit=', '')) : null;
  const type = typeArg ? typeArg.replace('--type=', '') : 'all';

  const options = { type, force, dryRun, verify };

  console.log(`Type: ${type} | Force: ${force} | Dry-run: ${dryRun} | Verify: ${verify}`);
  if (targetShowIds) console.log(`Target shows: ${targetShowIds.join(', ')}`);
  if (limit) console.log(`Limit: ${limit}`);

  // Ensure archive directories exist
  for (const dir of [reviewsArchiveDir, roundupArchiveDir]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  // Load shows
  const shows = loadShows();
  console.log(`Loaded ${shows.length} shows\n`);

  // Filter shows — exclude closed shows (won't get new reviews) and pre-2023 unless targeted
  let targetShows = shows;
  if (targetShowIds) {
    targetShows = shows.filter(s => targetShowIds.includes(s.id) || targetShowIds.includes(s.slug));
  } else {
    targetShows = shows.filter(s => {
      if (s.status === 'closed') return false;
      const opening = s.openingDate ? new Date(s.openingDate) : null;
      return opening && opening >= new Date('2023-01-01');
    });
  }

  // In verify mode, pick 5 representative shows
  if (verify && !targetShowIds) {
    const verifyIds = ['leopoldstadt-2022', 'shucked-2023', 'hamilton-2015', 'chicago-1996'];
    targetShows = shows.filter(s => verifyIds.includes(s.id));
    if (targetShows.length === 0) targetShows = shows.slice(0, 5);
    console.log(`Verify mode: processing ${targetShows.length} shows\n`);
  }

  if (limit && targetShows.length > limit) {
    targetShows = targetShows.slice(0, limit);
  }

  console.log(`Processing ${targetShows.length} shows...\n`);

  const CHECKPOINT_EVERY = 25;
  let count = 0;
  const verifyResults = {};

  for (const show of targetShows) {
    const showId = show.id;
    count++;
    console.log(`[${count}/${targetShows.length}] ${showId} (${show.title})`);

    try {
      const results = await processShow(show, showId, options);

      if (verify) {
        verifyResults[showId] = results;
      }

      // Checkpoint in CI
      if (count % CHECKPOINT_EVERY === 0) {
        gitCheckpoint(count, targetShows.length, type);
      }
    } catch (err) {
      console.error(`  [ERROR] ${showId}: ${err.message}`);
      stats.errors.push(`${showId}: ${err.message}`);
    }
  }

  // Final checkpoint
  if (count > 0) {
    gitCheckpoint(count, targetShows.length, `${type}-final`);
  }

  // Print summary
  console.log('\n=== BWW Scraper Summary ===');
  console.log(`Shows processed: ${stats.showsProcessed}`);
  console.log(`/reviews/ pages: ${stats.reviewsPagesHit} hit, ${stats.reviewsPagesMiss} miss (${stats.reviewsPagesFetched} fetched)`);
  console.log(`Roundups: ${stats.roundupsHit} hit, ${stats.roundupsMiss} miss (${stats.roundupsFetched} fetched, ${stats.googleSearches} searches)`);
  console.log(`Reviews extracted: ${stats.reviewsExtracted}`);
  console.log(`New reviews: ${stats.newReviews}`);
  console.log(`Updated reviews: ${stats.updatedReviews}`);
  console.log(`Skipped (existing): ${stats.skippedExisting}`);
  console.log(`Skipped (guards): ${stats.skippedGuards}`);
  if (stats.errors.length > 0) {
    console.log(`Errors: ${stats.errors.length}`);
    stats.errors.slice(0, 10).forEach(e => console.log(`  - ${e}`));
  }

  // Print verify results
  if (verify) {
    console.log('\n=== Verify Results ===');
    for (const [showId, results] of Object.entries(verifyResults)) {
      console.log(`\n${showId}:`);
      if (results.reviews.length > 0) {
        console.log(`  /reviews/ page (${results.reviews.length} reviews):`);
        for (const r of results.reviews) {
          console.log(`    ${r.bwwScore || '-'}/10 | ${r.outlet} | ${r.critic} | ${r.url?.slice(0, 60) || 'no-url'}`);
        }
      }
      if (results.roundup.length > 0) {
        console.log(`  Roundup (${results.roundup.length} reviews):`);
        for (const r of results.roundup) {
          const thumb = r.bwwThumb ? ` [${r.bwwThumb}]` : '';
          console.log(`    ${r.outlet} | ${r.critic}${thumb} | ${r.url?.slice(0, 60) || 'no-url'}`);
        }
      }
      if (results.reviews.length === 0 && results.roundup.length === 0) {
        console.log('  No data found');
      }
    }
  }
}

main()
  .catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  })
  .finally(() => cleanupScraper());
