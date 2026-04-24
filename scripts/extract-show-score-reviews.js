#!/usr/bin/env node
/**
 * Extract critic reviews and audience data from archived Show Score HTML pages
 *
 * Usage: node scripts/extract-show-score-reviews.js
 */

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { resolveOutletFromCritic, resolveOutletFromUrl } = require('./lib/review-normalization');
const { isLondonMarket } = require('./lib/venue-classification');

const archivePath = path.join(__dirname, '../data/aggregator-archive/show-score');
const urlsPath = path.join(__dirname, '../data/show-score-urls.json');
const outputPath = path.join(__dirname, '../data/show-score.json');

// Load URL mapping and shows data for category detection
const urlData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
const showUrls = urlData.shows;
const showsPath = path.join(__dirname, '../data/shows.json');
const showsRaw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const showsList = showsRaw.shows || showsRaw;
const showsArray = Array.isArray(showsList) ? showsList : Object.values(showsList);
const showsById = {};
for (const s of showsArray) if (s.id) showsById[s.id] = s;

function detectCategory(html, showId) {
  // Use shows.json category if available
  const show = showsById[showId];
  if (show?.category === 'off-broadway') return 'off-broadway';
  if (isLondonMarket(show?.category)) return show.category;
  if (showId && showId.includes('off-west-end')) return 'off-west-end';
  if (showId && showId.includes('west-end')) return 'west-end';

  // Fall back to page content detection
  const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)"/);
  const canonicalUrl = canonicalMatch ? canonicalMatch[1] : '';
  if (canonicalUrl.includes('/off-broadway-shows/')) return 'off-broadway';
  if (canonicalUrl.includes('/uk/') || canonicalUrl.includes('west-end-shows')) return 'west-end';
  return 'broadway';
}

function extractShowData(html, showId, sourceUrl) {
  const $ = cheerio.load(html);

  const category = detectCategory(html, showId);
  const result = {
    showScoreUrl: sourceUrl,
    category,
    audienceScore: null,
    audienceReviewCount: null,
    criticReviewCount: 0,
    criticReviews: [],
    lastFetched: new Date().toISOString().split('T')[0]
  };

  // Check page title to confirm we have the right page
  const title = $('title').text() || '';

  if (!title.includes('Show Score') || title.includes('NYC Theatre Reviews and Tickets')) {
    // Louder than console.log so misconfigured slugs in data/show-score-urls.json
    // are visible in CI output. Common case: URL silently redirects to the generic
    // /shows/all listing page (title "Show Score | NYC Theatre Reviews and Tickets").
    // scripts/audit-show-score-urls.js will flag these on cron so the URL gets fixed.
    console.warn(`  ⚠️  SS-REDIRECT ${showId} — page title "${title.slice(0, 80)}" suggests the stored URL redirected to the generic listing. Fix data/show-score-urls.json.`);
    return null;
  }

  // Extract audience score from JSON-LD
  $('script[type="application/ld+json"]').each(function () {
    try {
      const data = JSON.parse($(this).html());
      if (data.aggregateRating) {
        result.audienceScore = data.aggregateRating.ratingValue;
        result.audienceReviewCount = data.aggregateRating.reviewCount;
        return false; // break
      }
    } catch (e) {
      // Skip invalid JSON-LD
    }
  });

  // Extract critic review count from heading
  const criticHeadingMatch = html.match(/Critic Reviews\s*\((\d+)\)/);
  if (criticHeadingMatch) {
    result.criticReviewCount = parseInt(criticHeadingMatch[1], 10);
  }

  // Extract individual critic reviews
  $('.review-tile-v2.-critic').each(function () {
    const tile = $(this);
    const review = {};

    // Get outlet name from image alt text
    const outletImg = tile.find('.user-avatar-v2 img');
    if (outletImg.length) {
      review.outlet = outletImg.attr('alt') || null;
    }

    // Get date
    const dateEl = tile.find('.review-tile-v2__date');
    if (dateEl.length) {
      review.date = dateEl.text().trim();
    }

    // Get author
    const authorEl = tile.find('.review-tile-v2__authors a');
    if (authorEl.length) {
      review.author = authorEl.text().trim();
    }

    // Get star rating from CSS variable --rating on .review-tile-v2__stars
    // --rating is the star count (1-5 scale) or percentage (>5 = 0-100 scale)
    // --gaps is a CSS rendering variable that matches --rating, NOT the max
    const starsEl = tile.find('.review-tile-v2__stars');
    if (starsEl.length) {
      const style = starsEl.attr('style') || '';
      const ratingMatch = style.match(/--rating:\s*([\d.]+)/);
      if (ratingMatch) {
        review.starRating = parseFloat(ratingMatch[1]);
        review.starMax = review.starRating > 5 ? 100 : 5;
      }
    }

    // Get excerpt
    const excerptEl = tile.find('.review-tile-v2__review p');
    if (excerptEl.length) {
      let excerpt = excerptEl.text().trim();
      excerpt = excerpt.replace(/Read more\s*$/i, '').trim();
      review.excerpt = excerpt || null;
    }

    // Get review URL
    const reviewLink = tile.find('.review-tile-v2__review a[href*="http"]');
    if (reviewLink.length) {
      review.url = reviewLink.attr('href');
    }

    // Resolve null outlet from critic registry or review URL
    if (!review.outlet && review.author) {
      const resolved = resolveOutletFromCritic(review.author);
      if (resolved) {
        review.outlet = resolved.displayName;
        review._outletResolvedFrom = 'critic-registry';
      }
    }
    if (!review.outlet && review.url) {
      const urlResolved = resolveOutletFromUrl(review.url);
      if (urlResolved) {
        review.outlet = urlResolved.displayName;
        review._outletResolvedFrom = 'url-domain';
      }
    }
    if (!review.outlet && review.author) {
      console.warn(`    WARNING: Could not resolve outlet for critic "${review.author}" — will be "unknown"`);
    }

    // Only add if we have meaningful data
    if (review.outlet || review.author) {
      result.criticReviews.push(review);
    }
  });

  return result;
}

function main() {
  console.log('Extracting Show Score data from archived HTML pages...\n');

  const showScoreData = {
    _meta: {
      lastUpdated: new Date().toISOString(),
      source: 'show-score.com'
    },
    shows: {}
  };

  // Collect all show IDs to process: URL entries + any archive files without URL entries
  const showIdsFromUrls = new Set(Object.keys(showUrls));
  const archiveFiles = fs.existsSync(archivePath)
    ? fs.readdirSync(archivePath).filter(f => f.endsWith('.html')).map(f => f.replace('.html', ''))
    : [];
  const showIdsFromArchives = new Set(archiveFiles);

  // Merge: process everything that has either a URL or an archive
  const allShowIds = new Set([...showIdsFromUrls, ...showIdsFromArchives]);
  console.log(`Show IDs from URLs: ${showIdsFromUrls.size}, from archives: ${showIdsFromArchives.size}, total unique: ${allShowIds.size}\n`);

  let successCount = 0;
  let failCount = 0;
  const categoryCounts = { broadway: 0, 'off-broadway': 0, 'west-end': 0, 'off-west-end': 0 };

  for (const showId of [...allShowIds].sort()) {
    const archiveFile = path.join(archivePath, `${showId}.html`);
    const sourceUrl = showUrls[showId] || null;

    console.log(`Processing: ${showId}`);

    if (!fs.existsSync(archiveFile)) {
      console.log(`  SKIP: Archive file not found`);
      failCount++;
      continue;
    }

    try {
      const html = fs.readFileSync(archiveFile, 'utf8');

      // Check if the HTML looks like the correct page
      if (html.includes('NYC Theatre Reviews and Tickets</title>') &&
          !html.includes('(Broadway)')) {
        console.log(`  SKIP: Wrong page content (general listing)`);
        failCount++;
        continue;
      }

      const data = extractShowData(html, showId, sourceUrl);

      if (data) {
        showScoreData.shows[showId] = data;
        categoryCounts[data.category] = (categoryCounts[data.category] || 0) + 1;
        console.log(`  OK: [${data.category}] Score ${data.audienceScore}%, ${data.audienceReviewCount} audience reviews, ${data.criticReviews.length}/${data.criticReviewCount} critic reviews extracted`);
        successCount++;
      } else {
        console.log(`  SKIP: Could not extract data`);
        failCount++;
      }
    } catch (error) {
      console.log(`  ERROR: ${error.message}`);
      failCount++;
    }
  }

  // Write output
  fs.writeFileSync(outputPath, JSON.stringify(showScoreData, null, 2));

  console.log(`\n=== Summary ===`);
  console.log(`Successful: ${successCount} (Broadway: ${categoryCounts.broadway}, Off-Broadway: ${categoryCounts['off-broadway']}, West End: ${categoryCounts['west-end']}, Off-West End: ${categoryCounts['off-west-end']})`);
  console.log(`Failed/Skipped: ${failCount}`);
  console.log(`Output written to: ${outputPath}`);
}

try {
  main();
} catch (err) {
  console.error('Fatal error:', err);
  process.exit(1);
}
