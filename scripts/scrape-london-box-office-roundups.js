#!/usr/bin/env node
/**
 * London Box Office Review Roundups Scraper
 *
 * Discovers and extracts review data from londonboxoffice.co.uk roundup pages.
 * These roundups contain outlet name, star rating (★), critic name, excerpt,
 * and link to full review — all structured under <h4> headings.
 *
 * Strategy:
 * 1. Crawl /news-sitemap.xml for "review-round-up-" URLs
 * 2. Match roundup URLs to shows.json (West End category)
 * 3. Fetch HTML via ScrapingBee (static, no JS needed)
 * 4. Extract: outlet → ★ count → P0 score → critic → excerpt → review URL
 * 5. Dedup via findExistingReviewFile(), write review-text files
 *
 * Requires: SCRAPINGBEE_API_KEY
 *
 * Output: Updates/creates review files in data/review-texts/{showId}/
 * Archives: Saves HTML to data/aggregator-archive/lbo-roundups/
 *
 * Usage: node scripts/scrape-london-box-office-roundups.js [--shows=X,Y,Z] [--dry-run] [--force]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');
const { matchTitleToShow, loadShows, titleWordsMatch } = require('./lib/show-matching');
const { normalizeOutlet, normalizeCritic, findExistingReviewFile } = require('./lib/review-normalization');

// Paths
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const archiveDir = path.join(__dirname, '../data/aggregator-archive/lbo-roundups');

const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const DRY_RUN = process.argv.includes('--dry-run');
const FORCE = process.argv.includes('--force');

// Stats
const stats = {
  sitemapUrls: 0,
  matchedShows: 0,
  pagesFetched: 0,
  reviewsExtracted: 0,
  newReviews: 0,
  updatedReviews: 0,
  skippedExisting: 0,
  skippedArchived: 0,
  errors: [],
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function fetchUrl(url, renderJs = false) {
  // LBO pages are static HTML — try direct fetch first, fall back to ScrapingBee
  const targetUrl = SCRAPINGBEE_KEY
    ? `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=${renderJs}`
    : url;

  return new Promise((resolve, reject) => {
    const handler = (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        https.get(res.headers.location, handler).on('error', reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    };
    const req = https.get(targetUrl, handler);
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function fetchWithRetry(url, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchUrl(url);
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        await sleep(3000 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

// Fetch raw XML without ScrapingBee (sitemap is public, no bot protection)
function fetchRaw(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // Follow redirect
        fetchRaw(res.headers.location).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// ---------------------------------------------------------------------------
// Sitemap discovery
// ---------------------------------------------------------------------------

async function discoverRoundupUrls() {
  console.log('Fetching LBO sitemap...');

  const xml = await fetchRaw('https://londonboxoffice.co.uk/news-sitemap.xml');
  const $ = cheerio.load(xml, { xmlMode: true });

  const urls = [];
  $('url > loc').each((_, el) => {
    const loc = $(el).text().trim();
    // Match "review-round-up-", "review-roundup-", "Review-Round-Up:-", "-review-round-up" (suffix)
    if (/review-round-?up[-:]|review-round-?up$/i.test(loc)) {
      urls.push(loc);
    }
  });

  console.log(`Found ${urls.length} review roundup URLs in sitemap`);
  stats.sitemapUrls = urls.length;
  return urls;
}

// ---------------------------------------------------------------------------
// URL → show matching
// ---------------------------------------------------------------------------

function extractShowTitleFromUrl(url) {
  // URL pattern: /news/post/review-round-up-{show-name}-{theatre-name}
  // Also handles: /news/post/Review-Round-Up:-SHOW-NAME-at-the-Theatre
  const match = url.match(/review-round-?up[:-]+(.+)$/i);
  if (!match) return null;

  const slug = match[1];

  // Known theatre names to strip from the end
  const theatres = [
    'noel-coward-theatre', 'aldwych-theatre', 'apollo-theatre',
    'theatre-royal-haymarket', 'harold-pinter-theatre', 'duke-of-yorks-theatre',
    'duke-of-york-s-theatre', 'trafalgar-theatre', 'ambassadors-theatre',
    'bridge-theatre', 'savoy-theatre', 'wyndhams-theatre', 'wyndham-s-theatre',
    'donmar-warehouse', 'old-vic', 'the-old-vic', 'young-vic',
    'national-theatre', 'gielgud-theatre', 'lyceum-theatre',
    'london-palladium', 'phoenix-theatre', 'playhouse-theatre',
    'vaudeville-theatre', 'noël-coward-theatre', 'garrick-theatre',
    'criterion-theatre', 'duchess-theatre', 'fortune-theatre',
    'palace-theatre', 'piccadilly-theatre', 'prince-edward-theatre',
    'prince-of-wales-theatre', 'queens-theatre', 'savoy-theatre',
    'shaftesbury-theatre', 'st-james-theatre', 'st-martins-theatre',
    'gillian-lynne-theatre', 'barbican', 'soho-place',
    '@soho-place', 'at-the-ambassadors-theatre',
    'at-soho-place',
  ];

  let cleaned = slug;
  for (const theatre of theatres) {
    const suffix = new RegExp(`-${theatre.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    if (suffix.test(cleaned)) {
      cleaned = cleaned.replace(suffix, '');
      break;
    }
  }

  // Convert hyphens to spaces, handle URL encoding
  return decodeURIComponent(cleaned).replace(/-/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Extract reviews from roundup HTML
// ---------------------------------------------------------------------------

function extractReviewsFromLBO(html, showId) {
  const $ = cheerio.load(html);
  const reviews = [];
  const seenOutlets = new Set();

  // LBO structure: <h4>Outlet Name</h4> followed by star rating, critic, excerpt
  // Stars are Unicode ★ characters
  // Critic line: "Reviewer: Name" (bold)
  // Review link: <a> within or after excerpt

  // Strategy: iterate through content elements, use h3/h4 as outlet markers
  // Some LBO pages use h3 for outlets (e.g., Hunger Games), others use h4
  const contentElements = $('h3, h4, p, blockquote').toArray();

  let currentOutlet = null;
  let currentStars = null;
  let currentCritic = null;
  let currentExcerpt = null;
  let currentUrl = null;

  function flushReview() {
    if (currentOutlet && (currentExcerpt || currentStars !== null)) {
      const key = currentOutlet.toLowerCase();
      if (!seenOutlets.has(key)) {
        seenOutlets.add(key);
        reviews.push({
          outlet: currentOutlet,
          stars: currentStars,
          score: currentStars !== null ? Math.round((currentStars / 5) * 100) : null,
          critic: currentCritic || 'Unknown',
          excerpt: currentExcerpt || '',
          url: currentUrl || '',
          showId,
        });
      }
    }
    currentOutlet = null;
    currentStars = null;
    currentCritic = null;
    currentExcerpt = null;
    currentUrl = null;
  }

  for (const el of contentElements) {
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().trim();

    if (tag === 'h3' || tag === 'h4') {
      // LBO puts star ratings in heading elements too — check for stars first
      const hStars = text.match(/^(★+)\s*$/);
      if (hStars && currentOutlet) {
        currentStars = hStars[1].length;
        continue;
      }

      // New outlet — flush previous
      flushReview();

      // Skip non-outlet headings (navigation, ads, etc.)
      if (text.length > 80 || text.length < 3) continue;
      if (/book tickets|buy tickets|related|share|newsletter|categories|connect with|latest news/i.test(text)) continue;
      // Skip pure star strings without a preceding outlet
      if (/^★+$/.test(text)) continue;

      currentOutlet = text;
      continue;
    }

    if (!currentOutlet) continue;

    // Star rating line — Unicode ★ characters (in <p> elements)
    const starMatch = text.match(/^(★+)\s*$/);
    if (starMatch) {
      currentStars = starMatch[1].length;
      continue;
    }

    // Stars might be inline with other text
    const inlineStars = text.match(/(★+)/);
    if (inlineStars && text.length < 20) {
      currentStars = inlineStars[1].length;
      continue;
    }

    // Numeric rating like "4/5" or "4 out of 5"
    const numericRating = text.match(/^(\d(?:\.\d)?)\s*(?:\/|out of)\s*5\s*$/);
    if (numericRating) {
      currentStars = parseFloat(numericRating[1]);
      continue;
    }

    // Critic line: "Reviewer: Name" or just bold name
    const reviewerMatch = text.match(/^Reviewer:\s*(.+)/i);
    if (reviewerMatch) {
      currentCritic = reviewerMatch[1].trim();
      continue;
    }

    // Check for bold critic attribution
    const boldEl = $(el).find('strong, b').first();
    const boldText = boldEl.text().trim();
    if (boldText && /^Reviewer/i.test(boldText)) {
      const criticText = text.replace(boldText, '').trim().replace(/^:\s*/, '');
      if (criticText.length > 0 && criticText.length < 60) {
        currentCritic = criticText;
        continue;
      }
    }

    // Short "Read the review here" link paragraphs (LBO puts these in separate <p>)
    if (text.length <= 40 && /read the review|read more|full review/i.test(text)) {
      const link = $(el).find('a').first();
      const linkHref = link.length ? link.attr('href') : '';
      if (linkHref && linkHref.startsWith('http') && !linkHref.includes('londonboxoffice.co.uk')) {
        currentUrl = linkHref;
      }
      continue;
    }

    // Excerpt — longer paragraph text
    if (text.length > 40) {
      // Capture first link as review URL
      const link = $(el).find('a').first();
      if (link.length && link.attr('href')) {
        const href = link.attr('href');
        // Only capture external review links (not LBO internal or relative links)
        if (!href.includes('londonboxoffice.co.uk') && href.startsWith('http')) {
          currentUrl = href;
        }
      }

      // Also check for "Read the full review" style links
      const allLinks = $(el).find('a').toArray();
      for (const a of allLinks) {
        const href = $(a).attr('href') || '';
        const linkText = $(a).text().toLowerCase();
        if ((linkText.includes('full review') || linkText.includes('read more')) && !href.includes('londonboxoffice.co.uk')) {
          currentUrl = href;
          break;
        }
      }

      // Clean excerpt — remove "Read the full review" suffix
      let excerpt = text.replace(/\s*Read the full review\.?\s*$/i, '').trim();
      excerpt = excerpt.replace(/\s*Read more\.?\s*$/i, '').trim();

      if (excerpt.length > 30) {
        currentExcerpt = excerpt;
      }
    }
  }

  // Flush last review
  flushReview();

  // Also try: look for links that might be review URLs after excerpts
  // Some LBO pages put the review link as a separate <p><a>Read full review</a></p>
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    const text = $(el).text().toLowerCase();
    if ((text.includes('full review') || text.includes('read more')) && !href.includes('londonboxoffice.co.uk')) {
      // Try to associate with nearest preceding review
      // (handled in main loop above, this is a backup)
    }
  });

  return reviews;
}

// ---------------------------------------------------------------------------
// Save review data
// ---------------------------------------------------------------------------

function saveLBOReview(showId, reviewInfo) {
  const showDir = path.join(reviewTextsDir, showId);
  const outletId = normalizeOutlet(reviewInfo.outlet);
  if (!outletId) return 'skipped';

  // Use cross-scraper dedup
  const existing = findExistingReviewFile(showDir, reviewInfo.outlet, reviewInfo.critic !== 'Unknown' ? reviewInfo.critic : null);

  if (existing && existing.data) {
    if (existing.data.lboRoundupExcerpt) {
      stats.skippedExisting++;
      return 'skipped';
    }

    // Add LBO data to existing file
    if (reviewInfo.excerpt) {
      existing.data.lboRoundupExcerpt = reviewInfo.excerpt;
    }
    if (reviewInfo.score !== null && !existing.data.score && !existing.data.compositeScore) {
      existing.data.score = reviewInfo.score;
      existing.data.scoreSource = 'lbo-star-rating';
      existing.data.scorePriority = 'P0';
    }
    if (reviewInfo.url && !existing.data.url) {
      existing.data.url = reviewInfo.url;
    }
    if (reviewInfo.critic !== 'Unknown' && (!existing.data.criticName || existing.data.criticName === 'Unknown')) {
      existing.data.criticName = reviewInfo.critic;
    }

    const sources = new Set(existing.data.sources || [existing.data.source || '']);
    sources.add('lbo-roundup');
    existing.data.sources = Array.from(sources).filter(Boolean);

    if (!DRY_RUN) {
      fs.writeFileSync(existing.path, JSON.stringify(existing.data, null, 2) + '\n');
    }
    stats.updatedReviews++;
    return 'updated';
  }

  // Create new review file
  if (!DRY_RUN) {
    if (!fs.existsSync(showDir)) {
      fs.mkdirSync(showDir, { recursive: true });
    }
  }

  const criticId = normalizeCritic(reviewInfo.critic) || 'unknown';
  const filename = `${outletId}--${criticId}.json`;
  const filepath = path.join(showDir, filename);

  if (fs.existsSync(filepath)) {
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (!data.lboRoundupExcerpt) {
      if (reviewInfo.excerpt) data.lboRoundupExcerpt = reviewInfo.excerpt;
      if (reviewInfo.score !== null && !data.score) {
        data.score = reviewInfo.score;
        data.scoreSource = 'lbo-star-rating';
        data.scorePriority = 'P0';
      }
      if (!DRY_RUN) {
        fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n');
      }
      stats.updatedReviews++;
      return 'updated';
    }
    stats.skippedExisting++;
    return 'skipped';
  }

  const reviewData = {
    showId,
    outletId,
    outlet: reviewInfo.outlet,
    criticName: reviewInfo.critic,
    url: reviewInfo.url || '',
    score: reviewInfo.score,
    scoreSource: reviewInfo.score !== null ? 'lbo-star-rating' : undefined,
    scorePriority: reviewInfo.score !== null ? 'P0' : undefined,
    lboRoundupExcerpt: reviewInfo.excerpt || undefined,
    source: 'lbo-roundup',
    sources: ['lbo-roundup'],
  };

  // Clean undefined keys
  Object.keys(reviewData).forEach(k => reviewData[k] === undefined && delete reviewData[k]);

  if (!DRY_RUN) {
    fs.writeFileSync(filepath, JSON.stringify(reviewData, null, 2) + '\n');
  }
  stats.newReviews++;
  return 'new';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function scrapeLBORoundups() {
  console.log('=== London Box Office Review Roundups Scraper ===\n');

  // Parse CLI flags
  const args = process.argv.slice(2);
  const showsArg = args.find(a => a.startsWith('--shows='));
  const targetShowIds = showsArg ? showsArg.replace('--shows=', '').split(',').map(s => s.trim()).filter(Boolean) : null;

  if (targetShowIds) {
    console.log(`Targeted mode: ${targetShowIds.length} show(s): ${targetShowIds.join(', ')}`);
  }
  if (DRY_RUN) console.log('[DRY RUN] No files will be written\n');

  // Ensure archive directory exists
  if (!DRY_RUN && !fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const shows = loadShows();
  // Filter to West End shows only
  const weShows = shows.filter(s => s.category === 'west-end');
  console.log(`Loaded ${weShows.length} West End shows from shows.json\n`);

  // Discover roundup URLs from sitemap
  let roundupUrls;
  try {
    roundupUrls = await discoverRoundupUrls();
  } catch (err) {
    console.error(`Failed to fetch sitemap: ${err.message}`);
    console.log('Falling back to targeted shows with Google SERP...');
    roundupUrls = [];
  }

  // Match URLs to shows
  const matchedRoundups = [];

  for (const url of roundupUrls) {
    const extractedTitle = extractShowTitleFromUrl(url);
    if (!extractedTitle) continue;

    const match = matchTitleToShow(extractedTitle, weShows, { market: 'west-end' });
    if (match && match.show) {
      // Apply show filter if provided
      if (targetShowIds && !targetShowIds.includes(match.show.id)) continue;

      matchedRoundups.push({ url, show: match.show, extractedTitle });
    }
  }

  stats.matchedShows = matchedRoundups.length;
  console.log(`\nMatched ${matchedRoundups.length} roundups to West End shows\n`);

  // If targeted mode and some shows weren't matched via sitemap, try SERP fallback
  if (targetShowIds && SCRAPINGBEE_KEY) {
    const matchedIds = new Set(matchedRoundups.map(r => r.show.id));
    const unmatchedTargets = targetShowIds.filter(id => !matchedIds.has(id));

    for (const showId of unmatchedTargets) {
      const show = weShows.find(s => s.id === showId);
      if (!show) {
        console.log(`[WARN] Show ${showId} not found in West End shows`);
        continue;
      }

      console.log(`[SERP] Searching for ${show.title} roundup...`);
      try {
        const query = `site:londonboxoffice.co.uk "review round up" "${show.title}"`;
        const apiUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${SCRAPINGBEE_KEY}&search=${encodeURIComponent(query)}&nb_results=5`;

        const searchResult = await new Promise((resolve, reject) => {
          const req = https.get(apiUrl, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
              if (res.statusCode === 200) {
                try {
                  const results = JSON.parse(data);
                  const urls = (results.organic_results || [])
                    .map(r => r.url)
                    .filter(u => u && u.includes('londonboxoffice.co.uk') && /review-round-?up/i.test(u));
                  resolve(urls[0] || null);
                } catch (e) { resolve(null); }
              } else { resolve(null); }
            });
          });
          req.on('error', () => resolve(null));
          req.setTimeout(30000, () => { req.destroy(); resolve(null); });
        });

        if (searchResult) {
          console.log(`  Found via SERP: ${searchResult}`);
          matchedRoundups.push({ url: searchResult, show, extractedTitle: show.title });
          stats.matchedShows++;
        } else {
          console.log(`  No LBO roundup found for ${show.title}`);
        }
        await sleep(2000);
      } catch (err) {
        console.log(`  SERP error: ${err.message}`);
      }
    }
  }

  // Process each matched roundup
  for (const { url, show } of matchedRoundups) {
    const showId = show.id;
    const archivePath = path.join(archiveDir, `${showId}.html`);

    // Check cached archive (fresh < 14 days)
    const archiveFresh = !FORCE && fs.existsSync(archivePath) &&
      (Date.now() - fs.statSync(archivePath).mtimeMs) / (1000 * 60 * 60 * 24) < 14;

    let html;
    if (archiveFresh) {
      console.log(`[CACHE] ${showId}: Using archived HTML`);
      html = fs.readFileSync(archivePath, 'utf8');
      stats.skippedArchived++;
    } else {
      console.log(`[FETCH] ${showId}: ${url}`);
      try {
        html = await fetchWithRetry(url);
        if (!html || html.length < 500) {
          console.log(`  Empty or too short page, skipping`);
          continue;
        }
        if (!DRY_RUN) {
          // Archive with source URL header
          fs.writeFileSync(archivePath, `<!-- Source: ${url} -->\n${html}`);
        }
        stats.pagesFetched++;
        await sleep(1500); // Rate limit
      } catch (err) {
        console.error(`  [ERROR] ${showId}: ${err.message}`);
        stats.errors.push(`${showId}: ${err.message}`);
        continue;
      }
    }

    // Extract reviews
    const reviews = extractReviewsFromLBO(html, showId);
    stats.reviewsExtracted += reviews.length;
    console.log(`  Found ${reviews.length} reviews`);

    for (const review of reviews) {
      const result = saveLBOReview(showId, review);
      const starStr = review.stars !== null ? ` (${review.stars}★ → ${review.score})` : '';
      if (result === 'new') {
        console.log(`    [NEW] ${review.outlet}${starStr} — ${review.critic}`);
      } else if (result === 'updated') {
        console.log(`    [UPD] ${review.outlet}${starStr}`);
      }
    }
  }

  // Print summary
  console.log('\n=== LBO Roundups Summary ===');
  console.log(`Sitemap roundup URLs: ${stats.sitemapUrls}`);
  console.log(`Matched to WE shows: ${stats.matchedShows}`);
  console.log(`Pages fetched: ${stats.pagesFetched}`);
  console.log(`Used cached archives: ${stats.skippedArchived}`);
  console.log(`Total reviews extracted: ${stats.reviewsExtracted}`);
  console.log(`New reviews created: ${stats.newReviews}`);
  console.log(`Existing reviews updated: ${stats.updatedReviews}`);
  console.log(`Skipped (already have excerpt): ${stats.skippedExisting}`);
  if (stats.errors.length > 0) {
    console.log(`Errors: ${stats.errors.length}`);
    stats.errors.forEach(e => console.log(`  - ${e}`));
  }
  if (DRY_RUN) console.log('\n[DRY RUN] No files were written');

  return stats;
}

// Run
scrapeLBORoundups().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
