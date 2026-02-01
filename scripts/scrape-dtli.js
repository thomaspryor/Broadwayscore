#!/usr/bin/env node
/**
 * Dedicated Did They Like It (DTLI) Scraper
 *
 * Extracts reviews with individual thumb ratings from DTLI pages.
 * Handles revival shows with -bway suffix patterns.
 * Archives pages for future reference.
 *
 * Usage:
 *   node scripts/scrape-dtli.js --show=merrily-we-roll-along-2023
 *   node scripts/scrape-dtli.js --shows=show1,show2,show3
 *   node scripts/scrape-dtli.js --all-historical
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Paths
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const ARCHIVE_DIR = path.join(__dirname, '..', 'data', 'aggregator-archive', 'dtli');
const AGGREGATOR_SUMMARY_PATH = path.join(__dirname, '..', 'data', 'aggregator-summary.json');

// Ensure archive directory exists
if (!fs.existsSync(ARCHIVE_DIR)) {
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Load aggregator summary data
 */
function loadAggregatorSummary() {
  if (fs.existsSync(AGGREGATOR_SUMMARY_PATH)) {
    return JSON.parse(fs.readFileSync(AGGREGATOR_SUMMARY_PATH, 'utf8'));
  }
  return {
    _meta: {
      lastUpdated: null,
      description: 'Show-level summary data from all aggregators (DTLI, BWW, Show Score)'
    },
    dtli: {},
    bww: {},
    showScore: {}
  };
}

/**
 * Save aggregator summary data
 */
function saveAggregatorSummary(data) {
  data._meta.lastUpdated = new Date().toISOString();
  fs.writeFileSync(AGGREGATOR_SUMMARY_PATH, JSON.stringify(data, null, 2));
}

/**
 * Save DTLI summary for a show
 */
function saveDTLISummary(showId, summary, dtliUrl) {
  const aggregatorData = loadAggregatorSummary();

  aggregatorData.dtli[showId] = {
    up: summary.up,
    meh: summary.meh,
    down: summary.down,
    totalReviews: summary.up + summary.meh + summary.down,
    dtliUrl: dtliUrl,
    lastUpdated: new Date().toISOString()
  };

  saveAggregatorSummary(aggregatorData);
  console.log(`    Saved DTLI summary to aggregator-summary.json`);
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
function httpGet(url, maxRedirects = 3) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode === 200) {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ found: true, html: data, finalUrl: url, status: 200 }));
      } else if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location;
        // Check if redirect goes to homepage (not found)
        if (redirectUrl.includes('/shows/all') || redirectUrl.endsWith('/shows') || redirectUrl.endsWith('/shows/')) {
          resolve({ found: false, redirectedToHomepage: true, status: res.statusCode });
        } else if (maxRedirects > 0) {
          // Ensure absolute URL
          const nextUrl = redirectUrl.startsWith('http') ? redirectUrl : `https://didtheylikeit.com${redirectUrl}`;
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
 * Generate URL variations to try for DTLI
 * Revival shows often use -bway or -broadway suffixes
 * IMPORTANT: For Broadway shows, try -bway FIRST to avoid hitting off-Broadway/prior productions
 */
function getDTLIUrlVariations(show) {
  const titleSlug = slugify(show.title);
  const titleNoArticle = slugify(show.title.replace(/^(the|a|an)\s+/i, ''));

  // Base variations (without suffix)
  const baseVariations = [
    show.slug.replace(/-\d{4}$/, ''),  // Remove year suffix
    titleSlug,
    titleNoArticle,
    show.title.toLowerCase().replace(/:/g, '').replace(/[^a-z0-9]+/g, '-'),
    show.title.toLowerCase().replace(/-the-/g, '-').replace(/[^a-z0-9]+/g, '-'),
  ];

  // PRIORITY: Try -bway suffix FIRST for Broadway shows
  // This avoids hitting Off-Broadway or prior production pages
  const allVariations = [];

  // First, try all variations WITH -bway suffix (highest priority for Broadway)
  for (const base of baseVariations) {
    allVariations.push(base + '-bway');
  }

  // Then try -broadway suffix
  for (const base of baseVariations) {
    allVariations.push(base + '-broadway');
  }

  // Then try -revival suffix
  for (const base of baseVariations) {
    allVariations.push(base + '-revival');
  }

  // Then try without suffix (may hit prior production)
  for (const base of baseVariations) {
    allVariations.push(base);
  }

  // Special cases for known patterns (revivals, subtitles, common variations)
  const specialCases = {
    'merrily-we-roll-along': ['merrily-we-roll-along-bway'],
    'appropriate': ['appropriate-bway'],
    'an-enemy-of-the-people': ['an-enemy-of-the-people-bway', 'enemy-of-the-people'],
    'the-outsiders': ['the-outsiders-bway', 'outsiders'],
    'the-notebook': ['the-notebook-bway', 'notebook'],
    'water-for-elephants': ['water-for-elephants-bway'],
    'mother-play': ['mother-play-bway'],
    'stereophonic': ['stereophonic-bway'],
    'suffs': ['suffs-bway'],
    'the-great-gatsby': ['the-great-gatsby-bway', 'great-gatsby'],
    'the-roommate': ['the-roommate-bway', 'roommate'],
    'cabaret': ['cabaret-bway', 'cabaret-revival'],
    'uncle-vanya': ['uncle-vanya-bway'],
    'prayer-for-the-french-republic': ['prayer-for-the-french-republic-bway'],
    'illinoise': ['illinoise-bway'],
    'the-wiz': ['the-wiz-bway', 'wiz'],
    'lempicka': ['lempicka-bway'],
    'the-who-s-tommy': ['the-whos-tommy-bway', 'whos-tommy'],
    'days-of-wine-and-roses': ['days-of-wine-and-roses-bway'],
    // Shows with subtitles - full title needed
    'doubt': ['doubt-a-parable', 'doubt-a-parable-bway'],
    'doubt-a-parable': ['doubt-a-parable'],
    'just-for-us': ['just-for-us-bway', 'just-for-us-a-very-important-show'],
    'harmony': ['harmony-bway', 'harmony-a-new-musical'],
    'purlie-victorious': ['purlie-victorious-bway', 'purlie-victorious-a-non-confederate-romp'],
    'gutenberg-the-musical': ['gutenberg-the-musical-bway'],
    'the-thanksgiving-play': ['the-thanksgiving-play-bway'],
    'titanique': ['titanique-bway'],
  };

  const baseSlug = show.slug.replace(/-\d{4}$/, '');

  // Check special cases for baseSlug
  if (specialCases[baseSlug]) {
    // Insert special cases at the BEGINNING (highest priority)
    allVariations.unshift(...specialCases[baseSlug]);
  }

  // Also check special cases for titleSlug (handles subtitles like "Doubt: A Parable")
  if (specialCases[titleSlug] && titleSlug !== baseSlug) {
    allVariations.unshift(...specialCases[titleSlug]);
  }

  // Remove duplicates and empty strings
  return [...new Set(allVariations)].filter(v => v && v.length > 0);
}

/**
 * Find DTLI page for a show
 */
async function findDTLIPage(show) {
  const variations = getDTLIUrlVariations(show);

  console.log(`  Trying ${variations.length} URL variations...`);

  for (const slug of variations) {
    const url = `https://didtheylikeit.com/shows/${slug}/`;
    const result = await httpGet(url);

    if (result.found && result.html) {
      // Verify this is a show page, not the homepage or listing
      if (result.html.includes('review-item') && result.html.includes('READ THE REVIEW')) {
        console.log(`  ✓ Found at: ${url}`);
        return { url, html: result.html, slug };
      }
    }
    await sleep(300);
  }

  console.log(`  ✗ Not found on DTLI`);
  return null;
}

/**
 * Extract reviews from DTLI HTML
 */
function extractDTLIReviews(html, showId, dtliUrl) {
  const reviews = [];

  // Extract summary thumb counts from the numbered hand images
  // Format: thumbs-up/thumb-N.png, thumbs-meh/thumb-N.png, thumbs-down/thumb-N.png
  const thumbUpMatch = html.match(/thumbs-up\/thumb-(\d+)\.png/);
  const thumbMehMatch = html.match(/thumbs-meh\/thumb-(\d+)\.png/);
  const thumbDownMatch = html.match(/thumbs-down\/thumb-(\d+)\.png/);

  const summary = {
    up: thumbUpMatch ? parseInt(thumbUpMatch[1]) : 0,
    meh: thumbMehMatch ? parseInt(thumbMehMatch[1]) : 0,
    down: thumbDownMatch ? parseInt(thumbDownMatch[1]) : 0,
  };
  console.log(`    Summary: ${summary.up} UP, ${summary.meh} MEH, ${summary.down} DOWN`);

  // Extract individual reviews
  // Each review is in a <div class="review-item"> block
  const reviewItemRegex = /<div class="review-item">([\s\S]*?)<\/div>\s*(?=<div class="review-item">|<\/section>|<div class="" id="modal-breakdown")/gi;

  let match;
  while ((match = reviewItemRegex.exec(html)) !== null) {
    const reviewHtml = match[1];

    // Extract outlet from img alt text OR div text
    // Format 1: <img class="review-item-attribution" alt="OUTLET NAME">
    // Format 2: <div class="review_image"><div>Outlet Name</div></div>
    const outletMatch = reviewHtml.match(/class="review-item-attribution"[^>]*alt="([^"]+)"/i) ||
                        reviewHtml.match(/alt="([^"]+)"[^>]*class="review-item-attribution"/i) ||
                        reviewHtml.match(/class="review_image"[^>]*>\s*<div>([^<]+)<\/div>/i);

    // Extract thumb from BigThumbs image
    const thumbMatch = reviewHtml.match(/BigThumbs_(UP|MEH|DOWN)/i);

    // Extract critic name
    const criticMatch = reviewHtml.match(/class="review-item-critic-name"[^>]*>(?:<a[^>]*>)?([^<]+)/i);

    // Extract date
    const dateMatch = reviewHtml.match(/class="review-item-date"[^>]*>([^<]+)/i);

    // Extract excerpt
    const excerptMatch = reviewHtml.match(/<p class="paragraph">([^]*?)<\/p>/i);

    // Extract review URL
    const urlMatch = reviewHtml.match(/href="(https?:\/\/[^"]+)"[^>]*class="[^"]*button-pink[^"]*review-item-button/i) ||
                     reviewHtml.match(/class="[^"]*button-pink[^"]*review-item-button[^"]*"[^>]*href="(https?:\/\/[^"]+)"/i);

    if (outletMatch && urlMatch) {
      const outlet = outletMatch[1].trim();
      const outletId = slugify(outlet);
      const thumb = thumbMatch ? thumbMatch[1].toUpperCase() : null;
      let criticName = criticMatch ? criticMatch[1].replace(/<br\s*\/?>/gi, ' ').trim() : 'Unknown';
      // Clean up critic name (remove newlines, extra spaces)
      criticName = criticName.replace(/\s+/g, ' ').trim();
      const date = dateMatch ? dateMatch[1].trim() : null;
      let excerpt = excerptMatch ? excerptMatch[1].trim() : null;
      // Clean up excerpt HTML
      if (excerpt) {
        excerpt = excerpt
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&#8217;/g, "'")
          .replace(/&#8220;/g, '"')
          .replace(/&#8221;/g, '"')
          .replace(/&#8212;/g, '—')
          .replace(/\s+/g, ' ')
          .trim();
      }
      const url = urlMatch[1];

      reviews.push({
        showId,
        outletId,
        outlet,
        criticName,
        url,
        publishDate: date,
        dtliExcerpt: excerpt,
        dtliThumb: thumb,
        source: 'dtli',
        dtliUrl,
      });
    }
  }

  console.log(`    Extracted ${reviews.length} individual reviews`);
  return { reviews, summary };
}

/**
 * Archive DTLI page
 */
function archiveDTLIPage(showId, url, html) {
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
    // Read existing and merge DTLI data
    const existing = JSON.parse(fs.readFileSync(filepath, 'utf8'));

    // Only update DTLI-specific fields if they're missing or null
    let updated = false;
    if (!existing.dtliThumb && review.dtliThumb) {
      existing.dtliThumb = review.dtliThumb;
      updated = true;
    }
    if (!existing.dtliExcerpt && review.dtliExcerpt) {
      existing.dtliExcerpt = review.dtliExcerpt;
      updated = true;
    }
    if (!existing.dtliUrl && review.dtliUrl) {
      existing.dtliUrl = review.dtliUrl;
      updated = true;
    }

    if (updated) {
      fs.writeFileSync(filepath, JSON.stringify(existing, null, 2));
      console.log(`      Updated ${filename} with DTLI data`);
      return { created: false, updated: true };
    } else {
      console.log(`      Skipped ${filename} (already has DTLI data)`);
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
    publishDate: review.publishDate,
    fullText: null,
    isFullReview: false,
    dtliExcerpt: review.dtliExcerpt,
    originalScore: null,
    assignedScore: null,
    source: 'dtli',
    dtliThumb: review.dtliThumb,
    dtliUrl: review.dtliUrl,
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
  let dtliUrl = null;

  if (fs.existsSync(archivePath)) {
    console.log(`  Using archived page...`);
    const archiveContent = fs.readFileSync(archivePath, 'utf8');
    // Extract URL from archive header
    const urlMatch = archiveContent.match(/Source:\s*(https?:\/\/[^\n]+)/);
    if (urlMatch) {
      dtliUrl = urlMatch[1].trim();
    }
    html = archiveContent;
  } else {
    // Find and fetch page
    const result = await findDTLIPage(show);
    if (!result) {
      return { success: false, error: 'Not found on DTLI' };
    }
    html = result.html;
    dtliUrl = result.url;

    // Archive the page
    archiveDTLIPage(show.id, dtliUrl, html);
  }

  // Extract reviews
  const { reviews, summary } = extractDTLIReviews(html, show.id, dtliUrl);

  // Save DTLI summary to aggregator-summary.json
  if (summary.up > 0 || summary.meh > 0 || summary.down > 0) {
    saveDTLISummary(show.id, summary, dtliUrl);
  }

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
    summary,
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
    console.log('  node scripts/scrape-dtli.js --show=show-id');
    console.log('  node scripts/scrape-dtli.js --shows=show1,show2,show3');
    console.log('  node scripts/scrape-dtli.js --all-historical');
    process.exit(1);
  }

  console.log('========================================');
  console.log('DTLI Scraper');
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
  console.log(`Shows not found on DTLI: ${notFound}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
