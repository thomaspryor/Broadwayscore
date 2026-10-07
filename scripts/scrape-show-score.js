#!/usr/bin/env node
/**
 * Scrape Show-Score critic reviews for a show
 *
 * Usage: node scripts/scrape-show-score.js <show-slug>
 * Example: node scripts/scrape-show-score.js mj
 *
 * Or for all shows: node scripts/scrape-show-score.js --all
 *
 * Outputs JSON with all critic reviews found on Show-Score
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Show-Score URL patterns
const SHOW_SCORE_BASE = 'https://www.show-score.com/broadway-shows/';

// Map our show slugs to Show-Score slugs (they may differ)
const SLUG_MAP = {
  'mj-2022': 'mj',
  'operation-mincemeat-2025': 'operation-mincemeat-broadway',
  'two-strangers-bway-2025': 'two-strangers-carry-a-cake-across-new-york',
  'bug-2025': 'bug',
  'marjorie-prime-2025': 'marjorie-prime',
  'hells-kitchen-2024': 'hells-kitchen',
  'the-outsiders-2024': 'the-outsiders',
  'maybe-happy-ending-2024': 'maybe-happy-ending',
  'oh-mary-2024': 'oh-mary',
  'the-great-gatsby-2024': 'the-great-gatsby',
  'wicked-2003': 'wicked',
  'hamilton-2015': 'hamilton',
  'the-lion-king-1997': 'the-lion-king',
  'chicago-1996': 'chicago',
  'moulin-rouge-2019': 'moulin-rouge-the-musical',
  'aladdin-2014': 'aladdin',
  'hadestown-2019': 'hadestown',
  'six-2021': 'six',
  'book-of-mormon-2011': 'the-book-of-mormon',
  'and-juliet-2022': 'juliet',
  'harry-potter-2021': 'harry-potter-and-the-cursed-child',
  'stranger-things-2024': 'stranger-things-the-first-shadow',
};

async function scrapeShowScore(showSlug) {
  const browser = await puppeteer.launch({ headless: 'new' });
  const page = await browser.newPage();

  // Set a reasonable viewport
  await page.setViewport({ width: 1280, height: 800 });

  const showScoreSlug = SLUG_MAP[showSlug] || showSlug;
  const url = `${SHOW_SCORE_BASE}${showScoreSlug}`;

  console.log(`Fetching: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // Wait for critic reviews section to load
    await page.waitForSelector('text/Critic Reviews', { timeout: 10000 }).catch(() => {
      console.log('Warning: Could not find Critic Reviews section');
    });

    // Scroll to load all critic reviews (they may be lazy-loaded)
    await autoScroll(page);

    // Extract critic review count from header
    const criticCount = await page.evaluate(() => {
      const header = document.body.innerText.match(/Critic Reviews \((\d+)\)/);
      return header ? parseInt(header[1]) : null;
    });

    console.log(`Found ${criticCount} critic reviews listed`);

    // Extract all critic reviews
    const reviews = await page.evaluate(() => {
      const results = [];

      // Find all critic review cards - adjust selector based on actual page structure
      // Show-Score uses various card layouts, so we try multiple approaches
      const reviewElements = document.querySelectorAll('[class*="critic"], [class*="review-card"], [data-testid*="critic"]');

      // Alternative: look for review content patterns
      const pageText = document.body.innerHTML;

      // Extract by finding outlet logos/names and associated critic names
      // This regex pattern matches the Show-Score critic review format
      const criticPattern = /<img[^>]*alt="([^"]+)"[^>]*>[\s\S]*?<[^>]*>([A-Z][a-z]+ [A-Z][a-z]+)<\/[^>]*>/g;

      // Also try to find all visible critic info
      const allText = document.body.innerText;
      const lines = allText.split('\n').filter(l => l.trim());

      // Look for date patterns followed by names (Show-Score format)
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // Match date patterns like "February 1st, 2022"
        if (/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d+/.test(line)) {
          // Next line is likely the critic name
          if (i + 1 < lines.length) {
            const criticName = lines[i + 1].trim();
            // Skip if it looks like a quote (starts with " or is very long)
            if (criticName && !criticName.startsWith('"') && criticName.length < 50) {
              results.push({
                date: line,
                critic: criticName,
                // Try to find the outlet from nearby text
                outlet: null
              });
            }
          }
        }
      }

      return results;
    });

    // Also get the full HTML of the critic reviews section for manual parsing if needed
    const criticSectionHtml = await page.evaluate(() => {
      // Try to find the critic reviews section
      const sections = document.querySelectorAll('section, div');
      for (const section of sections) {
        if (section.innerText.includes('Critic Reviews')) {
          return section.innerHTML;
        }
      }
      return null;
    });

    await browser.close();

    return {
      showSlug,
      showScoreSlug,
      url,
      criticCount,
      reviews,
      rawHtml: criticSectionHtml
    };

  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 100;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);

      // Safety timeout after 10 seconds
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, 10000);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node scripts/scrape-show-score.js <show-slug>');
    console.log('       node scripts/scrape-show-score.js --all');
    console.log('\nExamples:');
    console.log('  node scripts/scrape-show-score.js mj');
    console.log('  node scripts/scrape-show-score.js operation-mincemeat-broadway');
    process.exit(1);
  }

  const outputDir = path.join(__dirname, '..', 'data', 'show-score-data');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  if (args[0] === '--all') {
    // Load shows from shows.json
    const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
    const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8'));

    const results = {};
    for (const show of shows) {
      if (show.status === 'open') {
        console.log(`\nProcessing: ${show.title}`);
        try {
          results[show.id] = await scrapeShowScore(show.id);
        } catch (error) {
          console.error(`Error processing ${show.title}: ${error.message}`);
          results[show.id] = { error: error.message };
        }
        // Be nice to the server
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    const outputPath = path.join(outputDir, 'all-shows.json');
    fs.writeFileSync(outputPath, JSON.stringify(results, null, 2));
    console.log(`\nResults saved to: ${outputPath}`);

  } else {
    const showSlug = args[0];
    const result = await scrapeShowScore(showSlug);

    const outputPath = path.join(outputDir, `${showSlug}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`\nResults saved to: ${outputPath}`);
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch(console.error);
