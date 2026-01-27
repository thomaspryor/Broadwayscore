#!/usr/bin/env node
/**
 * Dedicated BroadwayWorld Review Roundup Scraper
 *
 * Extracts reviews from BWW Review Roundup articles.
 * BWW compiles all reviews into a single article per show.
 * Archives pages for future reference.
 *
 * Usage:
 *   node scripts/scrape-bww-roundups.js --show=merrily-we-roll-along-2023
 *   node scripts/scrape-bww-roundups.js --shows=show1,show2,show3
 *   node scripts/scrape-bww-roundups.js --all-historical
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Paths
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'aggregator-archive', 'bww-roundups');

// Ensure archive directory exists
if (!fs.existsSync(ARCHIVE_DIR)) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

// Known Review Roundup URL patterns
// BWW uses various URL formats, we try multiple patterns
const BWW_URL_PATTERNS = [
  'https://www.broadwayworld.com/article/Review-Roundup-{TITLE}-Opens-on-Broadway',
  'https://www.broadwayworld.com/article/Read-All-the-Reviews-for-{TITLE}-on-Broadway',
  'https://www.broadwayworld.com/article/What-Do-Critics-Think-of-{TITLE}',
  'https://www.broadwayworld.com/article/{TITLE}-Reviews',
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function slugify(text) {
  return text.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Load shows data
 */
function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return data.shows || data;
}

/**
 * HTTP GET with redirect handling
 */
function httpGet(url, maxRedirects = 5) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ found: true, html: data, finalUrl: url, status: 200 }));
      } else if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location;
        if (maxRedirects > 0) {
          const nextUrl = redirectUrl.startsWith('http') ? redirectUrl : `https://www.broadwayworld.com${redirectUrl}`;
          httpGet(nextUrl, maxRedirects - 1).then(resolve);
        } else {
          resolve({ found: false, tooManyRedirects: true, status: res.statusCode });
        }
      } else {
        resolve({ found: false, status: res.statusCode });
      }
    });
    req.on('error', (err) => resolve({ found: false, error: err.message }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ found: false, error: 'timeout' });
    });
  });
}

/**
 * Search BWW for review roundup article
 */
async function searchBWWRoundup(show) {
  const year = new Date(show.openingDate).getFullYear();

  // Generate title variations for URL
  const titleVariations = [
    show.title.toUpperCase().replace(/[^A-Z0-9\s]+/g, '').replace(/\s+/g, '-'),
    show.title.replace(/[^a-zA-Z0-9\s]+/g, '').replace(/\s+/g, '-'),
    show.title.replace(/'/g, '').replace(/[^a-zA-Z0-9\s]+/g, '').replace(/\s+/g, '-'),
    slugify(show.title).toUpperCase().replace(/-/g, '-'),
  ];

  // Try Google-style search via web search API if available
  // For now, try known URL patterns

  // Also try searching BWW's search API
  const searchUrls = [];

  for (const title of titleVariations) {
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-on-Broadway-Updating-LIVE-${year}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-Opens-on-Broadway-${year}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Review-Roundup-${title}-${year}`);
    searchUrls.push(`https://www.broadwayworld.com/article/Reviews-${title}-on-Broadway-${year}`);
  }

  console.log(`  Trying ${searchUrls.length} BWW URL patterns...`);

  for (const url of searchUrls) {
    const result = await httpGet(url);
    if (result.found && result.html && result.html.includes('Review Roundup')) {
      console.log(`  ✓ Found at: ${url}`);
      return { url, html: result.html };
    }
    await sleep(200);
  }

  console.log(`  ✗ Not found via URL patterns`);
  return null;
}

/**
 * Extract reviews from BWW Review Roundup HTML
 * BWW stores all reviews in JSON-LD articleBody as plain text
 */
function extractBWWReviews(html, showId, bwwUrl) {
  const reviews = [];

  // Extract from JSON-LD articleBody
  const jsonLdMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  if (!jsonLdMatch) {
    console.log('    No JSON-LD found');
    return reviews;
  }

  try {
    const jsonLd = JSON.parse(jsonLdMatch[1]);
    const articleBody = jsonLd.articleBody || '';

    // Parse individual reviews from article body
    // Format is typically: "Critic Name, Outlet: <review excerpt>"
    // Or: "Outlet (Critic Name): <review excerpt>"

    // Known outlets and their patterns
    const outletPatterns = [
      { pattern: /Ben Brantley,?\s*(?:The\s*)?New York Times:?\s*([\s\S]*?)(?=\n[A-Z]|\n\n|$)/gi, outlet: 'The New York Times', outletId: 'nytimes' },
      { pattern: /Jesse Green,?\s*(?:The\s*)?(?:New York Times|Vulture):?\s*([\s\S]*?)(?=\n[A-Z]|\n\n|$)/gi, outlet: 'Vulture', outletId: 'vulture' },
      { pattern: /(?:The\s*)?New York Times\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'The New York Times', outletId: 'nytimes' },
      { pattern: /(?:The\s*)?Hollywood Reporter\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'The Hollywood Reporter', outletId: 'THR' },
      { pattern: /Variety\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'Variety', outletId: 'variety' },
      { pattern: /Vulture\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'Vulture', outletId: 'vulture' },
      { pattern: /Time Out(?:\s*(?:New York|NY))?\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'Time Out New York', outletId: 'TIMEOUT' },
      { pattern: /(?:The\s*)?Guardian\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'The Guardian', outletId: 'GUARDIAN' },
      { pattern: /Associated Press\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'Associated Press', outletId: 'AP' },
      { pattern: /TheaterMania\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'TheaterMania', outletId: 'TMAN' },
      { pattern: /BroadwayWorld\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'BroadwayWorld', outletId: 'BWW' },
      { pattern: /(?:New York\s*)?Daily News\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'New York Daily News', outletId: 'NYDN' },
      { pattern: /(?:New York\s*)?Post\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'New York Post', outletId: 'NYP' },
      { pattern: /Deadline\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'Deadline', outletId: 'DEADLINE' },
      { pattern: /(?:The\s*)?Wrap\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'The Wrap', outletId: 'WRAP' },
      { pattern: /Entertainment Weekly\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'Entertainment Weekly', outletId: 'EW' },
      { pattern: /USA Today\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'USA Today', outletId: 'USAT' },
      { pattern: /Newsday\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'Newsday', outletId: 'NEWSDAY' },
      { pattern: /(?:The\s*)?Wall Street Journal\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'Wall Street Journal', outletId: 'WSJ' },
      { pattern: /Chicago Tribune\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'Chicago Tribune', outletId: 'CHITRIB' },
      { pattern: /NBC (?:New York|NY)\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'NBC New York', outletId: 'NBCNY' },
      { pattern: /AM New York\s*(?:\([^)]+\))?:?\s*["']?([\s\S]*?)["']?(?=\n[A-Z]|\n\n|$)/gi, outlet: 'AM New York', outletId: 'AMNY' },
    ];

    // Better approach: Parse the HTML body for structured review blocks
    // BWW typically has reviews in the article with critic name in bold
    const articleHtml = html;

    // Pattern: <strong>Critic Name, Outlet:</strong> excerpt
    // Or: <p><b>Critic Name</b>, <i>Outlet</i>: excerpt</p>
    const reviewBlockPattern = /(?:<strong>|<b>)([^<,]+)(?:,?\s*(?:<\/strong>|<\/b>)\s*(?:<i>)?([^<:]+)(?:<\/i>)?)?:?\s*(?:<\/strong>|<\/b>)?\s*([\s\S]*?)(?=<(?:strong|b)>|<\/p>|$)/gi;

    let match;
    const foundCritics = new Set();

    // First try to extract from HTML structure
    const reviewSections = articleHtml.match(/<p[^>]*>.*?(?:<strong>|<b>).*?(?:<\/strong>|<\/b>).*?<\/p>/gi) || [];

    for (const section of reviewSections) {
      // Extract critic and outlet
      const criticOutletMatch = section.match(/(?:<strong>|<b>)([^<]+)(?:<\/strong>|<\/b>)[\s,]*(?:(?:<i>)?([^<:]+)(?:<\/i>)?)?/i);
      if (criticOutletMatch) {
        let [, criticPart, outletPart] = criticOutletMatch;

        // Clean up
        criticPart = (criticPart || '').replace(/<[^>]+>/g, '').trim();
        outletPart = (outletPart || '').replace(/<[^>]+>/g, '').trim();

        // Sometimes format is "Outlet (Critic)" or "Critic, Outlet"
        let criticName = criticPart;
        let outlet = outletPart;

        // Check if critic part contains outlet info
        const commaMatch = criticPart.match(/([^,]+),\s*(.+)/);
        if (commaMatch) {
          criticName = commaMatch[1].trim();
          outlet = commaMatch[2].trim();
        }

        // Skip if we've already found this critic
        if (foundCritics.has(criticName.toLowerCase())) continue;
        foundCritics.add(criticName.toLowerCase());

        // Map outlet to known outlets
        const outletInfo = mapOutlet(outlet || criticName);
        if (outletInfo) {
          // Extract excerpt (text after the bold/strong)
          const excerptMatch = section.match(/(?:<\/strong>|<\/b>)[^<]*:?\s*["']?([\s\S]*?)["']?(?:<\/p>|$)/i);
          const excerpt = excerptMatch ? excerptMatch[1].replace(/<[^>]+>/g, '').trim() : null;

          if (excerpt && excerpt.length > 50) {
            reviews.push({
              showId,
              outletId: outletInfo.outletId,
              outlet: outletInfo.outlet,
              criticName: criticName || 'Unknown',
              url: null, // BWW roundups don't always have individual URLs
              bwwExcerpt: excerpt.substring(0, 500), // Truncate long excerpts
              bwwRoundupUrl: bwwUrl,
              source: 'bww-roundup',
            });
          }
        }
      }
    }

    console.log(`    Extracted ${reviews.length} reviews from BWW roundup`);

  } catch (e) {
    console.log(`    Error parsing BWW JSON-LD: ${e.message}`);
  }

  return reviews;
}

/**
 * Map outlet name to standardized outlet info
 */
function mapOutlet(outletName) {
  const normalized = outletName.toLowerCase().trim();

  const outletMap = {
    'new york times': { outlet: 'The New York Times', outletId: 'nytimes' },
    'the new york times': { outlet: 'The New York Times', outletId: 'nytimes' },
    'nytimes': { outlet: 'The New York Times', outletId: 'nytimes' },
    'vulture': { outlet: 'Vulture', outletId: 'vulture' },
    'variety': { outlet: 'Variety', outletId: 'variety' },
    'hollywood reporter': { outlet: 'The Hollywood Reporter', outletId: 'THR' },
    'the hollywood reporter': { outlet: 'The Hollywood Reporter', outletId: 'THR' },
    'time out': { outlet: 'Time Out New York', outletId: 'TIMEOUT' },
    'time out new york': { outlet: 'Time Out New York', outletId: 'TIMEOUT' },
    'timeout': { outlet: 'Time Out New York', outletId: 'TIMEOUT' },
    'guardian': { outlet: 'The Guardian', outletId: 'GUARDIAN' },
    'the guardian': { outlet: 'The Guardian', outletId: 'GUARDIAN' },
    'associated press': { outlet: 'Associated Press', outletId: 'AP' },
    'ap': { outlet: 'Associated Press', outletId: 'AP' },
    'theatermania': { outlet: 'TheaterMania', outletId: 'TMAN' },
    'broadwayworld': { outlet: 'BroadwayWorld', outletId: 'BWW' },
    'broadway world': { outlet: 'BroadwayWorld', outletId: 'BWW' },
    'daily news': { outlet: 'New York Daily News', outletId: 'NYDN' },
    'new york daily news': { outlet: 'New York Daily News', outletId: 'NYDN' },
    'new york post': { outlet: 'New York Post', outletId: 'NYP' },
    'ny post': { outlet: 'New York Post', outletId: 'NYP' },
    'post': { outlet: 'New York Post', outletId: 'NYP' },
    'deadline': { outlet: 'Deadline', outletId: 'DEADLINE' },
    'the wrap': { outlet: 'The Wrap', outletId: 'WRAP' },
    'wrap': { outlet: 'The Wrap', outletId: 'WRAP' },
    'entertainment weekly': { outlet: 'Entertainment Weekly', outletId: 'EW' },
    'ew': { outlet: 'Entertainment Weekly', outletId: 'EW' },
    'usa today': { outlet: 'USA Today', outletId: 'USAT' },
    'newsday': { outlet: 'Newsday', outletId: 'NEWSDAY' },
    'wall street journal': { outlet: 'Wall Street Journal', outletId: 'WSJ' },
    'wsj': { outlet: 'Wall Street Journal', outletId: 'WSJ' },
    'chicago tribune': { outlet: 'Chicago Tribune', outletId: 'CHITRIB' },
    'nbc new york': { outlet: 'NBC New York', outletId: 'NBCNY' },
    'am new york': { outlet: 'AM New York', outletId: 'AMNY' },
    'new yorker': { outlet: 'The New Yorker', outletId: 'NYER' },
    'the new yorker': { outlet: 'The New Yorker', outletId: 'NYER' },
    'huffington post': { outlet: 'Huffington Post', outletId: 'HUFFPO' },
    'dc theatre scene': { outlet: 'DC Theatre Scene', outletId: 'DCTHSCN' },
  };

  for (const [key, value] of Object.entries(outletMap)) {
    if (normalized.includes(key)) {
      return value;
    }
  }

  return null;
}

/**
 * Archive BWW page
 */
function archiveBWWPage(showId, url, html) {
  const archivePath = path.join(ARCHIVE_DIR, `${showId}.html`);
  const header = `<!--
  Archived: ${new Date().toISOString()}
  Source: ${url}
  Status: 200
-->\n`;

  fs.writeFileSync(archivePath, header + html);
  console.log(`    Archived to ${archivePath}`);
}

/**
 * Save review to review-texts directory
 */
function saveReview(review) {
  const showDir = path.join(REVIEW_TEXTS_DIR, review.showId);
  if (!fs.existsSync(showDir)) {
    fs.mkdirSync(showDir, { recursive: true });
  }

  const criticSlug = slugify(review.criticName || 'unknown');
  const outletSlug = review.outletId.toLowerCase();
  const filename = `${outletSlug}--${criticSlug}.json`;
  const filepath = path.join(showDir, filename);

  // Check if file exists
  if (fs.existsSync(filepath)) {
    // Read existing and merge BWW data
    const existing = JSON.parse(fs.readFileSync(filepath, 'utf8'));

    let updated = false;
    if (!existing.bwwExcerpt && review.bwwExcerpt) {
      existing.bwwExcerpt = review.bwwExcerpt;
      updated = true;
    }
    if (!existing.bwwRoundupUrl && review.bwwRoundupUrl) {
      existing.bwwRoundupUrl = review.bwwRoundupUrl;
      updated = true;
    }

    if (updated) {
      fs.writeFileSync(filepath, JSON.stringify(existing, null, 2));
      console.log(`      Updated ${filename} with BWW data`);
      return { created: false, updated: true };
    } else {
      console.log(`      Skipped ${filename} (already has BWW data)`);
      return { created: false, updated: false };
    }
  }

  // Create new file
  const reviewData = {
    showId: review.showId,
    outletId: review.outletId,
    outlet: review.outlet,
    criticName: review.criticName,
    url: review.url,
    publishDate: null,
    fullText: null,
    isFullReview: false,
    bwwExcerpt: review.bwwExcerpt,
    bwwRoundupUrl: review.bwwRoundupUrl,
    originalScore: null,
    assignedScore: null,
    source: 'bww-roundup',
    dtliThumb: null,
    needsScoring: true,
  };

  fs.writeFileSync(filepath, JSON.stringify(reviewData, null, 2));
  console.log(`      Created ${filename}`);
  return { created: true, updated: false };
}

/**
 * Process a single show
 */
async function processShow(show) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing: ${show.title} (${show.id})`);
  console.log('='.repeat(60));

  // Check if we have an archive
  const archivePath = path.join(ARCHIVE_DIR, `${show.id}.html`);
  let html = null;
  let bwwUrl = null;

  if (fs.existsSync(archivePath)) {
    console.log(`  Using archived page...`);
    const archiveContent = fs.readFileSync(archivePath, 'utf8');
    // Extract URL from archive header
    const urlMatch = archiveContent.match(/Source:\s*(https?:\/\/[^\n]+)/);
    if (urlMatch) {
      bwwUrl = urlMatch[1].trim();
    }
    html = archiveContent;
  } else {
    // Search for roundup article
    const result = await searchBWWRoundup(show);
    if (!result) {
      return { success: false, error: 'Not found on BWW' };
    }
    html = result.html;
    bwwUrl = result.url;

    // Archive the page
    archiveBWWPage(show.id, bwwUrl, html);
  }

  // Extract reviews
  const reviews = extractBWWReviews(html, show.id, bwwUrl);

  // Save reviews
  let created = 0;
  let updated = 0;

  for (const review of reviews) {
    const result = saveReview(review);
    if (result.created) created++;
    if (result.updated) updated++;
  }

  console.log(`\n  Summary: ${reviews.length} reviews found, ${created} created, ${updated} updated`);

  return {
    success: true,
    showId: show.id,
    reviewsFound: reviews.length,
    created,
    updated,
  };
}

/**
 * Main entry point
 */
async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  const showArg = args.find(a => a.startsWith('--show='));
  const showsArg = args.find(a => a.startsWith('--shows='));
  const allHistorical = args.includes('--all-historical');

  const shows = loadShows();
  let showsToProcess = [];

  if (showArg) {
    const showId = showArg.replace('--show=', '');
    const show = shows.find(s => s.id === showId);
    if (!show) {
      console.error(`Show not found: ${showId}`);
      process.exit(1);
    }
    showsToProcess = [show];
  } else if (showsArg) {
    const showIds = showsArg.replace('--shows=', '').split(',').map(s => s.trim());
    for (const showId of showIds) {
      const show = shows.find(s => s.id === showId);
      if (show) {
        showsToProcess.push(show);
      } else {
        console.warn(`Warning: Show not found: ${showId}`);
      }
    }
  } else if (allHistorical) {
    showsToProcess = shows.filter(s => s.tags?.includes('historical') || s.status === 'closed');
  } else {
    console.log('Usage:');
    console.log('  node scripts/scrape-bww-roundups.js --show=show-id');
    console.log('  node scripts/scrape-bww-roundups.js --shows=show1,show2,show3');
    console.log('  node scripts/scrape-bww-roundups.js --all-historical');
    process.exit(1);
  }

  console.log('========================================');
  console.log('BWW Review Roundup Scraper');
  console.log('========================================');
  console.log(`Shows to process: ${showsToProcess.length}`);

  const results = [];

  for (const show of showsToProcess) {
    const result = await processShow(show);
    results.push(result);
    await sleep(1000); // Rate limiting
  }

  // Final summary
  console.log('\n========================================');
  console.log('FINAL SUMMARY');
  console.log('========================================');

  let totalFound = 0;
  let totalCreated = 0;
  let totalUpdated = 0;
  let notFound = 0;

  for (const r of results) {
    if (r.success) {
      console.log(`✓ ${r.showId}: ${r.reviewsFound} reviews (${r.created} new, ${r.updated} updated)`);
      totalFound += r.reviewsFound;
      totalCreated += r.created;
      totalUpdated += r.updated;
    } else {
      console.log(`✗ ${r.showId || 'unknown'}: ${r.error}`);
      notFound++;
    }
  }

  console.log(`\nTotal: ${totalFound} reviews found, ${totalCreated} created, ${totalUpdated} updated`);
  console.log(`Shows not found on BWW: ${notFound}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
