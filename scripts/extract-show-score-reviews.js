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

  // Extract audience score - look for the large percentage in the header area
  // The score is typically in a format like "92%"
  const allText = doc.body?.textContent || '';

  // Find the main show title to confirm we have the right page
  const titleElement = doc.querySelector('title');
  const title = titleElement?.textContent || '';

  if (!title.includes('Show Score') || title.includes('NYC Theatre Reviews and Tickets')) {
    console.log(`  Warning: ${showId} - appears to be wrong page (title: ${title.slice(0, 60)}...)`);
    return null;
  }

  // Look for audience score in the page
  // It's usually displayed as a large number like "92" or "92%"
  // The structure shows it in an element that precedes "reviews" text

  // Search for percentage patterns in specific contexts
  const scorePatterns = html.match(/>\s*(\d{1,2})%?\s*<\/[^>]+>\s*<[^>]+>\s*[\d,K+]+\s*reviews?/gi);
  if (scorePatterns && scorePatterns.length > 0) {
    const match = scorePatterns[0].match(/>(\d{1,2})/);
    if (match) {
      result.audienceScore = parseInt(match[1], 10);
    }
  }

  // Alternative: Look for the main score element - usually in the hero area
  const heroScoreMatch = html.match(/<div[^>]*>\s*(\d{1,3})%?\s*<\/div>\s*<div[^>]*>\s*([\d,K+]+)\s*reviews?/i);
  if (heroScoreMatch) {
    result.audienceScore = parseInt(heroScoreMatch[1], 10);
    result.audienceReviewCount = heroScoreMatch[2];
  }

  // Look for review count in "X reviews" format
  const reviewCountMatch = html.match(/([\d,]+K?\+?)\s*reviews?\s*<\/div>/i);
  if (reviewCountMatch) {
    result.audienceReviewCount = reviewCountMatch[1].replace(',', '');
  }

  // Extract critic reviews section
  // The section starts with "Critic Reviews (N)" heading
  const criticHeadingMatch = html.match(/Critic Reviews\s*\((\d+)\)/);
  if (criticHeadingMatch) {
    result.criticReviewCount = parseInt(criticHeadingMatch[1], 10);
  }

  // Find all critic review entries
  // Each review has: outlet image, date, author link, excerpt
  // The structure is inside a container after "Critic Reviews" heading

  // Look for outlet images with alt text (outlet names)
  const outletImages = doc.querySelectorAll('img[alt]');
  const outlets = [];

  outletImages.forEach(img => {
    const alt = img.getAttribute('alt') || '';
    // Filter to known outlet patterns
    if (alt.includes('New York Times') ||
        alt.includes('Vulture') ||
        alt.includes('Variety') ||
        alt.includes('Theatre Guide') ||
        alt.includes('Time Out') ||
        alt.includes('Daily News') ||
        alt.includes('Post') ||
        alt.includes('Hollywood Reporter') ||
        alt.includes('Observer') ||
        alt.includes('Washington Post') ||
        alt.includes('Wall Street') ||
        alt.includes('Entertainment') ||
        alt.includes('Theatermania') ||
        alt.includes('Lighting & Sound') ||
        alt.includes('Associated Press')) {

      // Get the parent container to find related elements
      let container = img.closest('div');
      if (container) {
        // Look for date and author in nearby elements
        const dateText = container.textContent?.match(/(\w+\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4})/);

        // Look for author link
        const authorLink = container.querySelector('a[href*="/member/"]');
        const author = authorLink?.textContent?.trim();

        // Look for excerpt paragraph
        let excerpt = '';
        const nextPara = container.nextElementSibling;
        if (nextPara && nextPara.tagName === 'P') {
          excerpt = nextPara.textContent?.trim() || '';
        }

        // Also check parent's next sibling
        if (!excerpt && container.parentElement) {
          const parentNext = container.parentElement.nextElementSibling;
          if (parentNext) {
            const para = parentNext.querySelector('p');
            if (para) {
              excerpt = para.textContent?.trim() || '';
            }
          }
        }

        if (author || excerpt) {
          outlets.push({
            outlet: alt,
            author: author || null,
            date: dateText ? dateText[1] : null,
            excerpt: excerpt.replace(/Read more\s*$/, '').trim() || null
          });
        }
      }
    }
  });

  result.criticReviews = outlets;

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

      if (data) {
        showScoreData.shows[showId] = data;
        console.log(`  OK: Score ${data.audienceScore}%, ${data.criticReviewCount} critic reviews`);
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
  console.log(`Output written to: ${outputPath}`);
}

main();
