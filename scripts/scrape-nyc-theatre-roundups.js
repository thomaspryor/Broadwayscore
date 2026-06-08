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
const { matchTitleToShow, loadShows, titleWordsMatch } = require('./lib/show-matching');
const { validatePageMatchesShow } = require('./lib/page-validator');

const { isUrlYearOutsideWindow } = require('./lib/content-filters');
const { isLondonMarket } = require('./lib/venue-classification');
const { createOrMergeReviewFile } = require('./lib/review-file-writer');

// Paths
const reviewTextsDir = path.join(__dirname, '../data/review-texts');
const archiveDir = path.join(__dirname, '../data/aggregator-archive/nyc-theatre');

const { serpQuery } = require('./lib/url-discovery');
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

// ---------------------------------------------------------------------------
// HTTP helper — fetch page via ScrapingBee
// ---------------------------------------------------------------------------

async function fetchHtmlSingle(url, renderJs = true) {
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

async function fetchHtml(url, renderJs = true, maxRetries = 2) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fetchHtmlSingle(url, renderJs);
    } catch (e) {
      lastError = e;
      if (attempt < maxRetries) {
        const delay = 3000 * (attempt + 1);
        await sleep(delay);
      }
    }
  }
  throw lastError;
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

async function googleSearchForShow(showTitle, category, year) {
  // Use category-appropriate search term (don't search "broadway" for WE/OB shows)
  const categoryLabel = isLondonMarket(category) ? 'west end'
    : category === 'off-broadway' ? 'off-broadway'
    : 'broadway';
  const yearSuffix = year ? ` ${year}` : '';
  const query = `site:newyorkcitytheatre.com/news/reviews/ "${showTitle}" ${categoryLabel}${yearSuffix}`;

  try {
    const results = await serpQuery(query, { nbResults: 5 });
    if (!results) return null;

    const urls = results.map(r => r.url).filter(url => url && url.includes('newyorkcitytheatre.com'));
    // Only accept /news/reviews/ URLs (critic roundups)
    return urls.find(u => /\/news\/reviews\/\d+/.test(u)) || null;
  } catch (e) {
    console.log(`  Google search error: ${e.message}`);
    return null;
  }
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

  // Final-pass helper: after every pattern exits, walk <a> tags and add outlets the
  // pattern-based walk missed. Must be invoked from every return path.
  function finalize() {
    try {
      const { supplementOutletsFromAnchors } = require('./lib/outlet-domain-supplement');
      const { resolveOutletFromUrl } = require('./lib/review-normalization');
      // Translate reviews[] shape so the helper's "already represented" check works
      const shaped = reviews.map(r => {
        const resolved = r.url ? resolveOutletFromUrl(r.url) : null;
        return { outletId: resolved ? resolved.outletId : (r.outlet || '').toLowerCase() };
      });
      const { added, newReviews } = supplementOutletsFromAnchors({
        html,
        reviews: shaped,
        showId,
        sourceName: 'nyc-theatre-domain-supplement',
        excludeDomains: ['nyctheatre.com', 'nyc-theatre.com'],
        urlTitleCheck: () => true, // NYC Theatre roundups are show-specific, no title check needed
        makeStub: (oid, url) => ({
          outlet: oid,
          excerpt: '',
          url,
          showId,
        }),
      });
      for (const nr of newReviews) reviews.push(nr);
      if (added > 0) {
        console.log(`    [NYC Theatre supplement] added ${added} outlet(s) missed by pattern walk`);
      }
    } catch (e) {
      // Non-fatal
    }
    return reviews;
  }

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

  if (reviews.length > 0) return finalize();

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
      // Strip the trailing " - Outlet" from the excerpt. Require whitespace
      // before the dash so hyphenated compounds (Night-Time, Toni-Leslie) at the
      // tail aren't cut \u2014 attribution always has a leading space.
      const excerpt = text.replace(/\s+(?:[\u2013\u2014]\s*|-\s+)[A-Z][A-Za-z\s.&']{2,50}\s*$/, '').trim();
      // Clean leading/trailing quotes
      const cleanExcerpt = excerpt.replace(/^["\u201c\u201d]+/, '').replace(/["\u201c\u201d]+$/, '').trim();
      if (cleanExcerpt.length > 30) {
        addReview(outlet, cleanExcerpt, $(el).find('a').first().attr('href') || '');
      }
    }
  });

  if (reviews.length > 0) return finalize();

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

  return finalize();
}

// ---------------------------------------------------------------------------
// Save review excerpt
// ---------------------------------------------------------------------------

function saveNycTheatreExcerpt(showId, reviewInfo) {
  const result = createOrMergeReviewFile(showId, {
    outlet: reviewInfo.outlet,
    url: reviewInfo.url,
    source: 'nyc-theatre',
    fields: { nycTheatreExcerpt: reviewInfo.excerpt },
  });

  if (result.action === 'new') stats.newReviews++;
  else if (result.action === 'updated') stats.updatedReviews++;
  else if (result.reason?.startsWith('domain-mismatch')) stats.skippedDomainMismatch = (stats.skippedDomainMismatch || 0) + 1;
  else stats.skippedExisting++;

  return result.action === 'skipped' ? 'skipped' : result.action;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function scrapeNYCTheatreRoundups() {
  console.log('=== NYC Theatre Review Roundups Scraper ===\n');

  // Parse CLI flags
  const args = process.argv.slice(2);
  const showsArg = args.find(a => a.startsWith('--shows='));
  const targetShowIds = showsArg ? showsArg.replace('--shows=', '').split(',').map(s => s.trim()).filter(Boolean) : null;

  if (targetShowIds) {
    console.log(`Targeted mode: ${targetShowIds.length} show(s): ${targetShowIds.join(', ')}`);
  }

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

  // Filter shows — exclude closed shows and pre-2023 unless targeted
  let recentShows;
  if (targetShowIds) {
    // Targeted mode: process any show regardless of status/date
    recentShows = shows.filter(s => targetShowIds.includes(s.id) || targetShowIds.includes(s.slug));
  } else {
    // Batch mode: skip closed shows (won't get new reviews) and pre-2023
    recentShows = shows.filter(s => {
      if (s.status === 'closed') return false;
      const opening = new Date(s.openingDate);
      return opening >= new Date('2023-01-01');
    });
  }

  console.log(`Processing ${recentShows.length} shows from 2023+\n`);

  for (const show of recentShows) {
    const showId = show.id;
    const archivePath = path.join(archiveDir, `${showId}.html`);
    // Also check slug-based archive from older runs
    const slugArchivePath = show.slug && show.slug !== show.id
      ? path.join(archiveDir, `${show.slug}.html`) : null;
    const effectiveArchivePath = fs.existsSync(archivePath) ? archivePath
      : (slugArchivePath && fs.existsSync(slugArchivePath) ? slugArchivePath : archivePath);

    // Use cached archive if fresh (<14 days), otherwise re-fetch
    const archiveFresh = fs.existsSync(effectiveArchivePath) &&
      (Date.now() - fs.statSync(effectiveArchivePath).mtimeMs) / (1000 * 60 * 60 * 24) < 14;
    if (archiveFresh) {
      const html = fs.readFileSync(effectiveArchivePath, 'utf8');

      // Validate cached page matches this show (prevents cross-contamination)
      const validation = await validatePageMatchesShow(html, show.title, { openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null });
      if (!validation.valid) {
        console.log(`[CACHE] ${showId}: Cached page is WRONG show — ${validation.reason}. Deleting cache.`);
        fs.unlinkSync(effectiveArchivePath);
        // Fall through to re-fetch via Google search below
      } else {
        console.log(`[CACHE] ${showId}: Using archived HTML`);

        const reviews = extractReviewsFromRoundup(html, showId);
        stats.excerptsFounds += reviews.length;

        const cachedOpeningYear = show.openingDate ? new Date(show.openingDate).getFullYear() : null;
        const cachedClosingYear = show.closingDate ? new Date(show.closingDate).getFullYear() : null;
        for (const review of reviews) {
          // URL year guard: skip if URL year is clearly outside production window
          if (review.url && isUrlYearOutsideWindow(review.url, cachedOpeningYear, cachedClosingYear)) {
            console.log(`  [SKIP] ${review.outlet}: URL year outside production window`);
            continue;
          }

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
    }

    // Google search for this show
    stats.showsSearched++;
    console.log(`[SEARCH] ${showId}: "${show.title}"...`);

    try {
      const year = show.openingDate ? new Date(show.openingDate).getFullYear() : '';
      const url = await googleSearchForShow(show.title, show.category, year);

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
      const validation = await validatePageMatchesShow(html, show.title, { openingYear: show.openingDate ? new Date(show.openingDate).getFullYear() : null });
      if (!validation.valid) {
        console.log(`  [SKIP] Page doesn't match "${show.title}" — ${validation.reason}`);
        continue;
      }

      // Archive
      fs.writeFileSync(archivePath, html);
      stats.pagesFetched++;

      // Extract reviews
      const reviews = extractReviewsFromRoundup(html, showId);
      stats.excerptsFounds += reviews.length;
      console.log(`  Found ${reviews.length} review excerpts`);

      const fetchOpeningYear = show.openingDate ? new Date(show.openingDate).getFullYear() : null;
      const fetchClosingYear = show.closingDate ? new Date(show.closingDate).getFullYear() : null;
      for (const review of reviews) {
        // URL year guard: skip if URL year is clearly outside production window
        if (review.url && isUrlYearOutsideWindow(review.url, fetchOpeningYear, fetchClosingYear)) {
          console.log(`    [SKIP] ${review.outlet}: URL year outside production window`);
          continue;
        }

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
