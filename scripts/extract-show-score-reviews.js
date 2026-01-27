#!/usr/bin/env node
/**
 * Extract critic reviews and audience data from archived Show Score HTML pages
 *
 * Usage: node scripts/extract-show-score-reviews.js
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const archivePath = path.join(__dirname, '../data/aggregator-archive/show-score');
const urlsPath = path.join(__dirname, '../data/show-score-urls.json');
const outputPath = path.join(__dirname, '../data/show-score.json');

// Load URL mapping
const urlData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
const showUrls = urlData.shows;

function extractShowData(html, showId, sourceUrl) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const result = {
    showScoreUrl: sourceUrl,
    audienceScore: null,
    audienceReviewCount: null,
    criticReviewCount: 0,
    criticReviews: [],
    lastFetched: new Date().toISOString().split('T')[0]
  };

  // Check page title to confirm we have the right page
  const titleElement = doc.querySelector('title');
  const title = titleElement?.textContent || '';

  if (!title.includes('Show Score') || title.includes('NYC Theatre Reviews and Tickets</title>')) {
    console.log(`  Warning: ${showId} - appears to be wrong page (title: ${title.slice(0, 60)}...)`);
    return null;
  }

  // Detect West End / London pages - these are NOT Broadway
  // Check title for London/West End WITHOUT "(Broadway)" marker
  const titleHasBroadway = title.includes('(Broadway)');
  const titleHasLondon = title.includes('London') || title.includes('West End');

  // Check canonical URL for West End path
  const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)"/);
  const canonicalUrl = canonicalMatch ? canonicalMatch[1] : '';
  const canonicalIsWestEnd = canonicalUrl.includes('/uk/') ||
                              canonicalUrl.includes('/london/') ||
                              canonicalUrl.includes('west-end-shows');

  const isWestEnd = (titleHasLondon && !titleHasBroadway) || canonicalIsWestEnd;

  if (isWestEnd) {
    console.log(`  SKIP: ${showId} - West End page detected (not Broadway)`);
    console.log(`         Title: ${title.slice(0, 80)}...`);
    console.log(`         Canonical: ${canonicalUrl}`);
    return { isWestEnd: true };
  }

  // Extract audience score from JSON-LD
  const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
  for (const script of jsonLdScripts) {
    try {
      const data = JSON.parse(script.textContent);
      if (data.aggregateRating) {
        result.audienceScore = data.aggregateRating.ratingValue;
        result.audienceReviewCount = data.aggregateRating.reviewCount;
        break;
      }
    } catch (e) {
      // Skip invalid JSON-LD
    }
  }

  // Extract critic review count from heading
  const criticHeadingMatch = html.match(/Critic Reviews\s*\((\d+)\)/);
  if (criticHeadingMatch) {
    result.criticReviewCount = parseInt(criticHeadingMatch[1], 10);
  }

  // Extract individual critic reviews
  const reviewTiles = doc.querySelectorAll('.review-tile-v2.-critic');

  for (const tile of reviewTiles) {
    const review = {};

    // Get outlet name from image alt text
    const outletImg = tile.querySelector('.user-avatar-v2 img');
    if (outletImg) {
      review.outlet = outletImg.getAttribute('alt') || null;
    }

    // Get date
    const dateEl = tile.querySelector('.review-tile-v2__date');
    if (dateEl) {
      review.date = dateEl.textContent.trim();
    }

    // Get author
    const authorEl = tile.querySelector('.review-tile-v2__authors a');
    if (authorEl) {
      review.author = authorEl.textContent.trim();
    }

    // Get excerpt
    const excerptEl = tile.querySelector('.review-tile-v2__review p');
    if (excerptEl) {
      // Remove "Read more" link text
      let excerpt = excerptEl.textContent.trim();
      excerpt = excerpt.replace(/Read more\s*$/i, '').trim();
      review.excerpt = excerpt || null;
    }

    // Get review URL
    const reviewLink = tile.querySelector('.review-tile-v2__review a[href*="http"]');
    if (reviewLink) {
      review.url = reviewLink.getAttribute('href');
    }

    // Only add if we have meaningful data
    if (review.outlet || review.author) {
      result.criticReviews.push(review);
    }
  }

  return result;
}

function main() {
  console.log('Extracting Show Score data from archived HTML pages...\n');

  const showScoreData = {
    _meta: {
      lastUpdated: new Date().toISOString().split('T')[0],
      source: 'show-score.com'
    },
    shows: {}
  };

  const showIds = Object.keys(showUrls);
  let successCount = 0;
  let failCount = 0;

  for (const showId of showIds) {
    const archiveFile = path.join(archivePath, `${showId}.html`);
    const sourceUrl = showUrls[showId];

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

      if (data && data.isWestEnd) {
        // Track West End pages separately
        if (!showScoreData.westEndPages) showScoreData.westEndPages = [];
        showScoreData.westEndPages.push(showId);
        failCount++;
      } else if (data) {
        showScoreData.shows[showId] = data;
        console.log(`  OK: Score ${data.audienceScore}%, ${data.audienceReviewCount} audience reviews, ${data.criticReviews.length}/${data.criticReviewCount} critic reviews extracted`);
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
  console.log(`Successful: ${successCount}`);
  console.log(`Failed/Skipped: ${failCount}`);
  if (showScoreData.westEndPages && showScoreData.westEndPages.length > 0) {
    console.log(`West End pages (need correct Broadway URLs): ${showScoreData.westEndPages.join(', ')}`);
  }
  console.log(`Output written to: ${outputPath}`);
}

main();
