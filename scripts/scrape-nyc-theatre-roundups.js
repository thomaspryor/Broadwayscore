#!/usr/bin/env node
/**
 * NYC Theatre Review Roundups Scraper
 *
 * Discovers and extracts review excerpts from newyorkcitytheatre.com roundup pages.
 * These roundups contain excerpts for reviews we may already have URLs for but lack text.
 *
 * Strategy:
 * 1. Google search for each show (2023+): site:newyorkcitytheatre.com "{show title}" reviews
 * 2. Scrape roundup page HTML
 * 3. Extract excerpts by outlet from "The Reviews" section
 * 4. Add nycTheatreExcerpt to existing reviews or create new minimal files
 *
 * Requires: SCRAPINGBEE_API_KEY for Google searches
 *
 * Output: Updates/creates review files in data/review-texts/{showId}/
 * Archives: Saves HTML to data/aggregator-archive/nyc-theatre/
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');
const { matchTitleToShow, loadShows } = require('./lib/show-matching');
const { normalizeOutlet, normalizeCritic, findExistingReviewFile } = require('./lib/review-normalization');

// Paths
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const archiveDir = path.join(__dirname, '../data/aggregator-archive/nyc-theatre');

const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

// ---------------------------------------------------------------------------
// HTTP helper — fetch page via ScrapingBee
// ---------------------------------------------------------------------------

async function fetchHtml(url, renderJs = true) {
  if (!SCRAPINGBEE_KEY) {
    throw new Error('SCRAPINGBEE_API_KEY required');
  }

  const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=${renderJs}&wait=3000`;

  return new Promise((resolve, reject) => {
    const req = https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Stats
const stats = {
  showsSearched: 0,
  showsFound: 0,
  pagesFetched: 0,
  excerptsFounds: 0,
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
// Google Search via ScrapingBee
// ---------------------------------------------------------------------------

async function googleSearchForShow(showTitle) {
  if (!SCRAPINGBEE_KEY) {
    console.log('  [WARN] No SCRAPINGBEE_API_KEY set, skipping Google search');
    return null;
  }

  const query = `site:newyorkcitytheatre.com/news/reviews/ "${showTitle}" broadway`;
  const apiUrl = `https://app.scrapingbee.com/api/v1/store/google?api_key=${SCRAPINGBEE_KEY}&search=${encodeURIComponent(query)}&nb_results=5`;

  return new Promise((resolve, reject) => {
    const req = https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const results = JSON.parse(data);
            const urls = (results.organic_results || [])
              .map(r => r.url)
              .filter(url => url && url.includes('newyorkcitytheatre.com'));
            // Only accept /news/reviews/ URLs (critic roundups)
            const roundupUrl = urls.find(u => /\/news\/reviews\/\d+/.test(u));
            resolve(roundupUrl || null);
          } catch (e) {
            // Fallback: extract URLs from raw content, only /news/reviews/ paths
            const urls = [];
            const linkPattern = /(https?:\/\/(?:www\.)?newyorkcitytheatre\.com\/news\/reviews\/\d+)/gi;
            let match;
            while ((match = linkPattern.exec(data)) !== null) {
              urls.push(match[1]);
            }
            resolve(urls.length > 0 ? urls[0] : null);
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
// Parse NYC Theatre roundup page
// ---------------------------------------------------------------------------

// Known outlet names for Pattern C matching (outlet at start of paragraph)
const KNOWN_OUTLETS = [
  'The New York Times', 'New York Times', 'Variety', 'The Guardian', 'Guardian',
  'Vulture', 'Deadline', 'Theatermania', 'TheatreMania', 'Theatrely', 'Theatreley',
  'TimeOut', 'Time Out', 'Time Out New York', 'Timeout', 'TimeOutNY',
  'Entertainment Weekly', 'The Washington Post', 'Washington Post',
  'New York Theatre Guide', 'New York Post', 'The New York Post',
  'New York Magazine', 'New York Daily News', 'The Daily Beast',
  'USA Today', 'Chicago Tribune', 'The Wrap', 'TheWrap',
  'New York Stage Review', 'Broadway News', 'Cititour', 'CititourNY',
  'Culture Sauce', 'amNewYork', 'am New York',
  'Hollywood Reporter', 'The Hollywood Reporter', 'Observer',
  'Wall Street Journal', 'The Wall Street Journal',
  'Theater Pizzazz', 'Front Mezz Junkies',
  'Theatremania', 'Broadway World', 'BroadwayWorld',
];

function extractReviewsFromRoundup(html, showId) {
  const $ = cheerio.load(html);
  const reviews = [];

  // NYC Theatre roundups use three different HTML patterns:
  //
  // Pattern A: <h3>The Reviews</h3> → <h4>Outlet</h4> → <p>excerpt</p>
  // Pattern B: <p>"<strong>key quote</strong> more text" - Outlet Name</p>
  // Pattern C: <p>Outlet Name: "excerpt text"</p>

  // Track seen outlets to deduplicate
  const seenOutlets = new Set();

  function cleanOutletName(name) {
    // Strip trailing colons, whitespace, and non-breaking spaces
    return name.replace(/[\s\u00a0]*:[\s\u00a0]*$/, '').trim();
  }

  function addReview(outlet, excerpt, url) {
    outlet = cleanOutletName(outlet);
    // Skip junk outlets
    if (/book tickets|buy tickets|get tickets|subscribe|newsletter/i.test(outlet)) return;
    if (!outlet || outlet.length < 3) return;
    const key = outlet.toLowerCase();
    if (seenOutlets.has(key)) return;
    seenOutlets.add(key);
    reviews.push({ outlet, excerpt, url: url || '', showId });
  }

  // Build a lowercase set of known outlet names for validation
  const knownOutletSet = new Set(KNOWN_OUTLETS.map(o => o.toLowerCase()));
  function looksLikeOutlet(name) {
    const clean = cleanOutletName(name).toLowerCase();
    return knownOutletSet.has(clean);
  }

  // --- Pattern A: h4 outlet headings ---
  let inReviewSection = false;
  let currentOutlet = null;
  let reviewSectionEnded = false;

  $('h2, h3, h4, h5, p, blockquote').each((_, el) => {
    if (reviewSectionEnded) return;
    const tag = el.tagName.toLowerCase();
    const text = $(el).text().trim();

    // Detect review section start — "The Reviews" or similar
    if (['h2', 'h3'].includes(tag) && /^the reviews$/i.test(text.replace(/\s+/g, ' '))) {
      if (!inReviewSection) inReviewSection = true;
      return;
    }
    if (['h2', 'h3'].includes(tag) && /what.*critics|reviews? are in|critics? thought/i.test(text)) {
      if (!inReviewSection) inReviewSection = true;
      return;
    }

    // Also detect start when we see an h4 matching a known outlet name
    if (['h4', 'h5'].includes(tag) && !inReviewSection && looksLikeOutlet(text)) {
      inReviewSection = true;
      currentOutlet = text;
      return;
    }

    // End review section on CTA, footer, or "MORE reviews" sections
    if (['h2', 'h3'].includes(tag) && inReviewSection) {
      if (/more reviews|news.*tickets|need help|connect with/i.test(text) || $(el).attr('id') === 'cta-left-text') {
        inReviewSection = false;
        reviewSectionEnded = true;
        return;
      }
      if (text.length < 50 && !text.includes('"') && !/reviews?|critics?/i.test(text)) {
        inReviewSection = false;
        reviewSectionEnded = true;
        return;
      }
    }

    if (!inReviewSection && !currentOutlet) return;

    if (['h4', 'h5'].includes(tag) && text.length < 100) {
      currentOutlet = text;
      return;
    }

    if (['p', 'blockquote'].includes(tag) && currentOutlet && text.length > 30) {
      const link = $(el).find('a').first();
      addReview(currentOutlet, text, link.attr('href') || '');
    }

    // Only treat bold text as outlet name if it actually matches a known outlet
    if (tag === 'p') {
      const bold = $(el).find('b, strong').first().text().trim();
      if (bold && bold.length < 80 && bold.length > 3 && looksLikeOutlet(bold)) {
        const remainder = text.replace(bold, '').trim();
        if (remainder.length > 30) {
          addReview(bold, remainder, $(el).find('a').first().attr('href') || '');
        } else {
          currentOutlet = bold;
        }
      }
    }
  });

  if (reviews.length > 0) return reviews;

  // --- Pattern B: "excerpt text" - Outlet Name (outlet at end after dash) ---
  // Only accept outlet names that match KNOWN_OUTLETS to prevent capturing
  // excerpt text fragments as outlet names
  $('p').each((_, el) => {
    const text = $(el).text().trim();
    // Match: "...text..." - Outlet Name  or  "...text..." – Outlet Name
    const trailingOutlet = text.match(/["\u201d']\s*[-\u2013\u2014]\s*([A-Z][A-Za-z\s.&']{2,50})\s*$/);
    if (trailingOutlet && text.length > 60) {
      const outlet = trailingOutlet[1].trim();
      // Only accept if it matches a known outlet name
      if (!looksLikeOutlet(outlet)) return;
      // Strip the trailing " - Outlet" from the excerpt
      const excerpt = text.replace(/\s*[-\u2013\u2014]\s*[A-Z][A-Za-z\s.&']{2,50}\s*$/, '').trim();
      // Clean leading/trailing quotes
      const cleanExcerpt = excerpt.replace(/^["\u201c\u201d]+/, '').replace(/["\u201c\u201d]+$/, '').trim();
      if (cleanExcerpt.length > 30) {
        addReview(outlet, cleanExcerpt, $(el).find('a').first().attr('href') || '');
      }
    }
  });

  if (reviews.length > 0) return reviews;

  // --- Pattern C: Outlet Name: "excerpt text" (outlet at start before colon) ---
  $('p').each((_, el) => {
    const text = $(el).text().trim();
    // Try matching known outlet names at start of paragraph
    for (const outlet of KNOWN_OUTLETS) {
      // Match: "Outlet Name: "excerpt"" or "Outlet Name:\xa0"excerpt""
      const pattern = new RegExp(`^${outlet.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[:\u00a0]\\s*(?:["\u201c])?`, 'i');
      if (pattern.test(text)) {
        const excerpt = text.replace(pattern, '').replace(/["\u201d]+$/, '').trim();
        if (excerpt.length > 30) {
          addReview(outlet, excerpt, $(el).find('a').first().attr('href') || '');
        }
        break;
      }
    }
  });

  return reviews;
}

// ---------------------------------------------------------------------------
// Save review excerpt
// ---------------------------------------------------------------------------

function saveNycTheatreExcerpt(showId, reviewInfo) {
  const showDir = path.join(reviewTextsDir, showId);

  // Normalize outlet
  const outletId = normalizeOutlet(reviewInfo.outlet);
  if (!outletId) return 'skipped';

  // Use cross-scraper dedup: find existing review file regardless of filename format
  const existing = findExistingReviewFile(showDir, reviewInfo.outlet, null);

  if (existing && existing.data) {
    if (existing.data.nycTheatreExcerpt) {
      stats.skippedExisting++;
      return 'skipped';
    }

    // Add the excerpt to existing file
    existing.data.nycTheatreExcerpt = reviewInfo.excerpt;
    if (reviewInfo.url && !existing.data.url) {
      existing.data.url = reviewInfo.url;
    }

    const sources = new Set(existing.data.sources || [existing.data.source || '']);
    sources.add('nyc-theatre');
    existing.data.sources = Array.from(sources).filter(Boolean);

    fs.writeFileSync(existing.path, JSON.stringify(existing.data, null, 2) + '\n');
    stats.updatedReviews++;
    return 'updated';
  }

  // Create new review file with excerpt
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  const criticSlug = 'unknown';
  const filename = `${outletId}--${criticSlug}.json`;
  const filepath = path.join(showDir, filename);

  if (fs.existsSync(filepath)) {
    const data = JSON.parse(fs.readFileSync(filepath, 'utf8'));
    if (!data.nycTheatreExcerpt) {
      data.nycTheatreExcerpt = reviewInfo.excerpt;
      fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n');
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
    criticName: 'Unknown',
    url: reviewInfo.url || '',
    nycTheatreExcerpt: reviewInfo.excerpt,
    source: 'nyc-theatre',
    sources: ['nyc-theatre'],
  };

  fs.writeFileSync(filepath, JSON.stringify(reviewData, null, 2) + '\n');
  stats.newReviews++;
  return 'new';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function scrapeNYCTheatreRoundups() {
  console.log('=== NYC Theatre Review Roundups Scraper ===\n');

  if (!SCRAPINGBEE_KEY) {
    console.error('SCRAPINGBEE_API_KEY is required for Google searches.');
    console.error('Set it in .env or pass as environment variable.');
    process.exit(1);
  }

  // Ensure archive directory exists
  if (!fs.existsSync(archiveDir)) {
    fs.mkdirSync(archiveDir, { recursive: true });
  }

  const shows = loadShows();
  console.log(`Loaded ${shows.length} shows from shows.json`);

  // Filter to shows from 2023+ (NYC Theatre only covers recent shows)
  const recentShows = shows.filter(s => {
    const opening = new Date(s.openingDate);
    return opening >= new Date('2023-01-01');
  });
  console.log(`Filtering to ${recentShows.length} shows from 2023+\n`);

  for (const show of recentShows) {
    const showId = show.slug || show.id;
    const archivePath = path.join(archiveDir, `${showId}.html`);

    // Skip if already archived
    if (fs.existsSync(archivePath)) {
      const html = fs.readFileSync(archivePath, 'utf8');
      console.log(`[CACHE] ${showId}: Using archived HTML`);

      const reviews = extractReviewsFromRoundup(html, showId);
      stats.excerptsFounds += reviews.length;

      for (const review of reviews) {
        const result = saveNycTheatreExcerpt(showId, review);
        if (result === 'new') {
          console.log(`  [NEW] ${review.outlet}`);
        } else if (result === 'updated') {
          console.log(`  [UPD] ${review.outlet}: added excerpt`);
        }
      }

      stats.skippedArchived++;
      continue;
    }

    // Google search for this show
    stats.showsSearched++;
    console.log(`[SEARCH] ${showId}: "${show.title}"...`);

    try {
      const url = await googleSearchForShow(show.title);

      if (!url) {
        console.log(`  No NYC Theatre page found.`);
        await sleep(2000);
        continue;
      }

      stats.showsFound++;
      console.log(`  Found: ${url}`);

      // Fetch the page
      await sleep(1000);
      const html = await fetchHtml(url);

      if (!html || html.length < 500) {
        console.log(`  Empty or too short page.`);
        continue;
      }

      // Verify page is actually about this show (prevent cross-show contamination)
      // NYC Theatre pages have the site name in h1/title, so check the full page text instead
      const $page = cheerio.load(html);
      const pageText = $page('body').text().toLowerCase();
      const showTitleLower = show.title.toLowerCase()
        .replace(/^the\s+/, '').replace(/\s*\(.*?\)\s*$/, '').replace(/:\s+.*$/, '').trim();
      if (showTitleLower.length > 3 && !pageText.includes(showTitleLower)) {
        console.log(`  [SKIP] Page doesn't mention "${show.title}" — likely wrong show`);
        continue;
      }

      // Archive
      fs.writeFileSync(archivePath, html);
      stats.pagesFetched++;

      // Extract reviews
      const reviews = extractReviewsFromRoundup(html, showId);
      stats.excerptsFounds += reviews.length;
      console.log(`  Found ${reviews.length} review excerpts`);

      for (const review of reviews) {
        const result = saveNycTheatreExcerpt(showId, review);
        if (result === 'new') {
          console.log(`    [NEW] ${review.outlet}`);
        } else if (result === 'updated') {
          console.log(`    [UPD] ${review.outlet}: added excerpt`);
        }
      }

      await sleep(2000); // Rate limit between Google searches
    } catch (err) {
      console.error(`  [ERROR] ${showId}: ${err.message}`);
      stats.errors.push(`${showId}: ${err.message}`);
      await sleep(2000);
    }
  }

  // Print summary
  console.log('\n=== NYC Theatre Roundups Summary ===');
  console.log(`Shows searched (Google): ${stats.showsSearched}`);
  console.log(`Shows found: ${stats.showsFound}`);
  console.log(`Pages fetched: ${stats.pagesFetched}`);
  console.log(`Used cached archives: ${stats.skippedArchived}`);
  console.log(`Total excerpts found: ${stats.excerptsFounds}`);
  console.log(`New reviews created: ${stats.newReviews}`);
  console.log(`Existing reviews updated: ${stats.updatedReviews}`);
  console.log(`Skipped (already have excerpt): ${stats.skippedExisting}`);
  if (stats.errors.length > 0) {
    console.log(`Errors: ${stats.errors.length}`);
    stats.errors.forEach(e => console.log(`  - ${e}`));
  }

  return stats;
}

// Run
scrapeNYCTheatreRoundups().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
