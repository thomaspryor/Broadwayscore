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
const { matchTitleToShow, loadShows } = require('./lib/show-matching');
const { normalizeOutlet, normalizeCritic, generateReviewFilename, findExistingReviewFile } = require('./lib/review-normalization');
const { classifyContentTier } = require('./lib/content-quality');

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
function isGarbageOutlet(outletName) {
  if (!outletName) return true;
  const slug = outletName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  // Too long for a real outlet name
  if (slug.length > 45) return true;
  // Too many hyphens — sentence fragments
  if ((slug.match(/-/g) || []).length > 5) return true;
  // Matches known garbage patterns from BWW extraction
  if (/photo-credit|average-rating|read-the-reviews|reviewed-its|the-unthinkable/.test(slug)) return true;
  // Starts with conjunctions/articles that indicate a sentence fragment
  if (/^(but-|and-(?!juliet)|is-a-|are-|has-|enjoying-|id-wager|how-to-\w+-is-)/.test(slug)) return true;
  // Contains verb phrases never found in outlet names
  if (/(promises-the|crafted-a|likely-to|fun-surf|wager-that|silence-after|antidote-to|underdog-itself|make-it-fun)/.test(slug)) return true;
  // Ends with "-review" — show title fragment (e.g., "oscar-review", "new-york-review")
  if (/-review$/.test(slug)) return true;
  // Contains year numbers — sentence fragments like "saturday night live in 1985"
  if (/(?:19|20)\d{2}/.test(slug) && !/\d{2}-\d{2}/.test(slug)) return true;
  // Show title or person name used as outlet (critic name in outlet field)
  if (/^(garth-drabinsky|paradise-square)$/.test(slug)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function fetchHtml(url) {
  if (!SCRAPINGBEE_KEY) throw new Error('SCRAPINGBEE_API_KEY required');
  const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=false`;
  return new Promise((resolve, reject) => {
    const req = https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else if (res.statusCode === 404 || res.statusCode === 410) resolve(null);
        else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function googleSearch(query) {
  if (!SCRAPINGBEE_KEY) return [];
  const apiUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${SCRAPINGBEE_KEY}&search=${encodeURIComponent(query)}&nb_results=5`;
  return new Promise((resolve, reject) => {
    const req = https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const results = JSON.parse(data);
            resolve((results.organic_results || []).map(r => r.url).filter(Boolean));
          } catch (e) {
            resolve([]);
          }
        } else {
          reject(new Error(`Google search HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ---------------------------------------------------------------------------
// Production guards (shared with playbill-verdict)
// ---------------------------------------------------------------------------

function isNotBroadway(title) {
  const lower = title.toLowerCase();
  return (
    lower.includes('off-broadway') || lower.includes('off broadway') ||
    lower.includes('west end') || lower.includes('london') ||
    lower.includes('national tour') || lower.includes('touring production') ||
    lower.includes('apple tv') || lower.includes('netflix') ||
    lower.includes('hulu') || lower.includes('disney+') ||
    lower.includes('streaming') || lower.includes('amazon prime') ||
    lower.includes('tv series') || lower.includes('tv show')
  );
}

function extractUrlYear(url) {
  if (!url) return null;
  const match = url.match(/\/((?:19|20)\d{2})\//);
  return match ? parseInt(match[1]) : null;
}

function isUrlYearValid(url, showOpeningYear) {
  if (!showOpeningYear) return true;
  const urlYear = extractUrlYear(url);
  if (!urlYear) return true;
  return urlYear >= showOpeningYear - 3 && urlYear <= showOpeningYear + 2;
}

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

  // Google search for roundup article
  const year = show.openingDate ? new Date(show.openingDate).getFullYear() : '';
  let searchTitle = show.title
    .replace(/\s+at\s+the\s+.+$/i, '')
    .replace(/:\s+.+$/, '')
    .replace(/\s+[–—]\s+.+$/, '');

  const query = `site:broadwayworld.com/article "Review Roundup" "${searchTitle}" broadway ${year}`;

  try {
    stats.googleSearches++;
    const urls = await googleSearch(query);
    const roundupUrls = urls.filter(u => u.includes('Review-Roundup') || u.includes('review-roundup'));

    if (roundupUrls.length === 0) {
      stats.roundupsMiss++;
      return null;
    }

    // Validate URL contains show title words (prevents cross-show contamination)
    // e.g. searching "Chicago" might match a roundup mentioning "Chris Jones, Chicago Tribune"
    const titleWords = searchTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !['the', 'and', 'for', 'new', 'broadway'].includes(w));
    const validRoundupUrls = roundupUrls.filter(url => {
      const urlSlug = url.split('/article/')[1]?.toLowerCase() || '';
      return titleWords.some(w => urlSlug.includes(w));
    });

    if (validRoundupUrls.length === 0) {
      console.log(`  [MISS] roundup: no URL slug matches "${searchTitle}"`);
      stats.roundupsMiss++;
      return null;
    }

    // Try the first matching URL
    for (const url of validRoundupUrls.slice(0, 2)) {
      try {
        stats.roundupsFetched++;
        const html = await fetchHtml(url);
        if (html && (html.includes('critics') || html.includes('Review Roundup'))) {
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
  } catch (err) {
    console.log(`  [ERROR] roundup search for ${showId}: ${err.message.slice(0, 80)}`);
    stats.errors.push(`roundup-search: ${showId}: ${err.message}`);
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
  const hasThumbImages = html.includes('uptrans.png') || html.includes('middletrans.png') || html.includes('downtrans.png');
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

  // Method 1: Parse structured new-format with thumb images
  // Structure: <p><img src="uptrans/middletrans/downtrans.png"> CriticName, <a>Outlet:</a> excerpt</p>
  if (hasThumbImages) {
    const thumbImgs = container.find('img[src*="uptrans"], img[src*="middletrans"], img[src*="downtrans"]');

    thumbImgs.each((_, img) => {
      const $img = $(img);
      const src = $img.attr('src') || '';
      let thumb = null;
      if (src.includes('uptrans')) thumb = 'Up';
      else if (src.includes('middletrans')) thumb = 'Meh';
      else if (src.includes('downtrans')) thumb = 'Down';

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
      if (isGarbageOutlet(outlet)) return;

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

          if (outlet.length < 2 || outlet.length > 60) continue;
          // Filter garbage outlet names
          if (isGarbageOutlet(outlet)) continue;
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

  const showDir = path.join(reviewTextsDir, showId);
  const outletName = reviewData.outlet;
  const criticName = reviewData.critic || '';

  // Reject garbage outlet names before writing
  if (isGarbageOutlet(outletName)) {
    stats.skippedGuards++;
    return 'skipped';
  }

  // Normalize
  const outletId = normalizeOutlet(outletName);
  if (!outletId) return 'skipped';

  const criticSlug = criticName ? normalizeCritic(criticName) : 'unknown';

  // Check for existing file
  const existing = findExistingReviewFile(showDir, outletName, criticName || null);
  if (existing && existing.data) {
    // Merge BWW data into existing file
    let changed = false;

    // Add bwwExcerpt
    if (reviewData.excerpt && !existing.data.bwwExcerpt) {
      existing.data.bwwExcerpt = reviewData.excerpt;
      changed = true;
    }

    // Add bwwScore (from /reviews/ pages only)
    if (reviewData.bwwScore != null && existing.data.bwwScore == null) {
      existing.data.bwwScore = reviewData.bwwScore;
      changed = true;
    }

    // Add bwwThumb (from new-format roundups only)
    if (reviewData.bwwThumb && !existing.data.bwwThumb) {
      existing.data.bwwThumb = reviewData.bwwThumb;
      changed = true;
    }

    // Add bwwRoundupUrl
    if (reviewData.bwwRoundupUrl && !existing.data.bwwRoundupUrl) {
      existing.data.bwwRoundupUrl = reviewData.bwwRoundupUrl;
      changed = true;
    }

    // Set url only if file has no URL
    if (reviewData.url && !existing.data.url) {
      existing.data.url = reviewData.url;
      changed = true;
    }

    // Track sources
    if (changed) {
      const sources = new Set(existing.data.sources || [existing.data.source || '']);
      sources.add(reviewData.source);
      existing.data.sources = Array.from(sources).filter(Boolean);
      fs.writeFileSync(existing.path, JSON.stringify(existing.data, null, 2) + '\n');
      stats.updatedReviews++;
      return 'updated';
    }
    stats.skippedExisting++;
    return 'skipped';
  }

  // Also check exact filename
  const filename = `${outletId}--${criticSlug}.json`;
  const filepath = path.join(showDir, filename);
  if (fs.existsSync(filepath)) {
    const existingData = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    let changed = false;

    if (reviewData.excerpt && !existingData.bwwExcerpt) {
      existingData.bwwExcerpt = reviewData.excerpt;
      changed = true;
    }
    if (reviewData.bwwScore != null && existingData.bwwScore == null) {
      existingData.bwwScore = reviewData.bwwScore;
      changed = true;
    }
    if (reviewData.bwwThumb && !existingData.bwwThumb) {
      existingData.bwwThumb = reviewData.bwwThumb;
      changed = true;
    }
    if (reviewData.bwwRoundupUrl && !existingData.bwwRoundupUrl) {
      existingData.bwwRoundupUrl = reviewData.bwwRoundupUrl;
      changed = true;
    }
    if (reviewData.url && !existingData.url) {
      existingData.url = reviewData.url;
      changed = true;
    }

    if (changed) {
      const sources = new Set(existingData.sources || [existingData.source || '']);
      sources.add(reviewData.source);
      existingData.sources = Array.from(sources).filter(Boolean);
      fs.writeFileSync(filepath, JSON.stringify(existingData, null, 2) + '\n');
      stats.updatedReviews++;
      return 'updated';
    }
    stats.skippedExisting++;
    return 'skipped';
  }

  // Create new review file
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  const newReview = {
    showId,
    outletId,
    outlet: outletName,
    criticName: criticName || 'Unknown',
    url: reviewData.url || null,
    source: reviewData.source,
    sources: [reviewData.source],
    bwwExcerpt: reviewData.excerpt || null,
  };

  // Add source-specific fields
  if (reviewData.bwwScore != null) newReview.bwwScore = reviewData.bwwScore;
  if (reviewData.bwwThumb) newReview.bwwThumb = reviewData.bwwThumb;
  if (reviewData.bwwRoundupUrl) newReview.bwwRoundupUrl = reviewData.bwwRoundupUrl;

  // Classify content tier
  newReview.contentTier = 'excerpt';

  fs.writeFileSync(filepath, JSON.stringify(newReview, null, 2) + '\n');
  stats.newReviews++;
  return 'new';
}

// ---------------------------------------------------------------------------
// Process a single show
// ---------------------------------------------------------------------------

async function processShow(show, showId, options = {}) {
  const showOpeningYear = show.openingDate ? new Date(show.openingDate).getFullYear() : null;
  const results = { reviews: [], roundup: [] };

  // --- /reviews/ page ---
  if (options.type === 'all' || options.type === 'reviews') {
    const html = await fetchBwwReviewsPage(show, showId, options);
    if (html) {
      const { reviews, aggregateRating } = extractBwwReviewsPageData(html, showId);
      stats.reviewsExtracted += reviews.length;
      console.log(`    Extracted ${reviews.length} reviews from /reviews/ page${aggregateRating ? ` (rating: ${aggregateRating})` : ''}`);

      for (const review of reviews) {
        // URL year validation
        if (!isUrlYearValid(review.url, showOpeningYear)) {
          console.log(`    [SKIP] ${review.outlet}: URL year mismatch`);
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
        if (!isUrlYearValid(review.url, showOpeningYear)) {
          stats.skippedGuards++;
          continue;
        }
        if (review.outlet && isNotBroadway(review.outlet)) {
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
// Git checkpoint (CI only)
// ---------------------------------------------------------------------------

function gitCheckpoint(count, total, label) {
  if (!process.env.GITHUB_ACTIONS) return;

  const { execSync } = require('child_process');
  try {
    execSync('git add data/review-texts/ data/aggregator-archive/', { stdio: 'pipe' });
    const staged = execSync('git diff --cached --name-only', { stdio: 'pipe' }).toString().trim().split('\n').filter(Boolean).length;
    if (staged > 0) {
      execSync(`git commit -m "data: BWW checkpoint ${count}/${total} — ${staged} files (${label})"`, { stdio: 'pipe' });
      // Push with retry
      for (let i = 1; i <= 5; i++) {
        try {
          execSync('git push origin main', { stdio: 'pipe' });
          console.log(`  [GIT] Checkpoint ${count}/${total}: ${staged} files pushed`);
          break;
        } catch (e) {
          execSync('git pull --rebase -X theirs origin main', { stdio: 'pipe' }).toString();
          const backoff = Math.floor(Math.random() * 11 + 5) * 1000;
          require('child_process').execSync(`sleep ${backoff / 1000}`);
        }
      }
    }
  } catch (e) {
    console.log(`  [GIT] Checkpoint failed: ${e.message.slice(0, 80)}`);
  }
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

  // Filter shows
  let targetShows = shows;
  if (targetShowIds) {
    targetShows = shows.filter(s => targetShowIds.includes(s.id) || targetShowIds.includes(s.slug));
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

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
