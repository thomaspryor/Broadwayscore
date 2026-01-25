#!/usr/bin/env node
/**
 * Comprehensive Review Collector - Dual Approach
 *
 * Combines:
 * 1. Aggregator scraping (DTLI, Show-Score, BWW)
 * 2. Master outlet searching
 *
 * Usage:
 *   node scripts/collect-reviews-comprehensive.js <show-slug>
 *   node scripts/collect-reviews-comprehensive.js mj-2022
 *   node scripts/collect-reviews-comprehensive.js --all
 *
 * Requirements:
 *   npm install puppeteer
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// ============================================================================
// CONFIGURATION
// ============================================================================

const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');
const OUTLETS_PATH = path.join(__dirname, 'config', 'critic-outlets.json');
const OUTPUT_DIR = path.join(__dirname, '..', 'data', 'collected-reviews');

// Aggregator URL patterns
const AGGREGATORS = {
  dtli: {
    name: 'Did They Like It',
    urlPattern: (slug) => `https://didtheylikeit.com/shows/${slug}/`,
    slugMap: {
      'mj-2022': 'mj-the-musical',
      'operation-mincemeat-2025': 'operation-mincemeat',
      'two-strangers-bway-2025': 'two-strangers-carry-a-cake-across-new-york',
    }
  },
  showScore: {
    name: 'Show-Score',
    urlPattern: (slug) => `https://www.show-score.com/broadway-shows/${slug}`,
    slugMap: {
      'mj-2022': 'mj',
      'operation-mincemeat-2025': 'operation-mincemeat-broadway',
    }
  },
  bww: {
    name: 'BroadwayWorld',
    urlPattern: (slug, title) => `https://www.broadwayworld.com/article/Review-Roundup-${encodeURIComponent(title.replace(/ /g, '-'))}`
  }
};

// ============================================================================
// AGGREGATOR SCRAPERS
// ============================================================================

async function scrapeDTLI(page, showSlug, showTitle) {
  const slug = AGGREGATORS.dtli.slugMap[showSlug] || showSlug.replace(/-\d{4}$/, '');
  const url = AGGREGATORS.dtli.urlPattern(slug);

  console.log(`  DTLI: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await autoScroll(page);

    const data = await page.evaluate(() => {
      const reviews = [];
      const pageText = document.body.innerText;

      // Extract review count from summary (e.g., "5 UP | 3 MEH | 2 DOWN")
      const countMatch = pageText.match(/(\d+)\s*UP.*?(\d+)\s*MEH.*?(\d+)\s*DOWN/i);
      const counts = countMatch ? {
        up: parseInt(countMatch[1]),
        meh: parseInt(countMatch[2]),
        down: parseInt(countMatch[3]),
        total: parseInt(countMatch[1]) + parseInt(countMatch[2]) + parseInt(countMatch[3])
      } : null;

      // Find all review entries - DTLI shows outlet name, critic, and thumb
      const reviewCards = document.querySelectorAll('[class*="review"], [class*="critic"], article');
      reviewCards.forEach(card => {
        const text = card.innerText;
        // Try to extract outlet and critic info
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);
        if (lines.length >= 2) {
          reviews.push({
            outlet: lines[0],
            critic: lines[1],
            raw: text.substring(0, 200)
          });
        }
      });

      return { counts, reviews, url: window.location.href };
    });

    return { source: 'dtli', ...data };
  } catch (error) {
    console.log(`    Error: ${error.message}`);
    return { source: 'dtli', error: error.message };
  }
}

async function scrapeShowScore(page, showSlug) {
  const slug = AGGREGATORS.showScore.slugMap[showSlug] || showSlug.replace(/-\d{4}$/, '');
  const url = AGGREGATORS.showScore.urlPattern(slug);

  console.log(`  Show-Score: ${url}`);

  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await autoScroll(page);

    const data = await page.evaluate(() => {
      const reviews = [];
      const pageText = document.body.innerText;

      // Extract critic review count
      const countMatch = pageText.match(/Critic Reviews \((\d+)\)/);
      const criticCount = countMatch ? parseInt(countMatch[1]) : null;

      // Extract audience score
      const scoreMatch = pageText.match(/(\d+)%/);
      const audienceScore = scoreMatch ? parseInt(scoreMatch[1]) : null;

      // Find critic entries - look for date patterns followed by names
      const lines = pageText.split('\n').map(l => l.trim()).filter(l => l);
      for (let i = 0; i < lines.length; i++) {
        // Match date patterns like "February 1st, 2022" or "March 20, 2025"
        if (/^(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d+/.test(lines[i])) {
          const date = lines[i];
          // Next non-empty line is likely the critic name
          let j = i + 1;
          while (j < lines.length && !lines[j]) j++;
          if (j < lines.length) {
            const criticName = lines[j];
            // Skip if it looks like a quote
            if (criticName && !criticName.startsWith('"') && !criticName.startsWith('"') && criticName.length < 50) {
              reviews.push({
                date,
                critic: criticName
              });
            }
          }
        }
      }

      return { criticCount, audienceScore, reviews, url: window.location.href };
    });

    return { source: 'showScore', ...data };
  } catch (error) {
    console.log(`    Error: ${error.message}`);
    return { source: 'showScore', error: error.message };
  }
}

async function scrapeBWW(page, showSlug, showTitle, year) {
  // BWW review roundups have various URL patterns, so we'll search for it
  const searchUrl = `https://www.google.com/search?q=site:broadwayworld.com+"Review+Roundup"+"${encodeURIComponent(showTitle)}"+${year}`;

  console.log(`  BWW: Searching...`);

  try {
    // First, try to find the review roundup page
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Get first result URL
    const bwwUrl = await page.evaluate(() => {
      const link = document.querySelector('a[href*="broadwayworld.com/article/Review-Roundup"]');
      return link ? link.href : null;
    });

    if (!bwwUrl) {
      return { source: 'bww', error: 'Review roundup not found' };
    }

    console.log(`    Found: ${bwwUrl}`);
    await page.goto(bwwUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await autoScroll(page);

    const data = await page.evaluate(() => {
      const reviews = [];
      const pageText = document.body.innerText;

      // BWW review roundups list outlets with quotes
      // Pattern: "Outlet Name (Critic Name): Quote..."
      const reviewPattern = /([A-Z][A-Za-z\s]+)\s*(?:\(([^)]+)\))?:\s*"([^"]+)"/g;
      let match;
      while ((match = reviewPattern.exec(pageText)) !== null) {
        reviews.push({
          outlet: match[1].trim(),
          critic: match[2] ? match[2].trim() : null,
          quote: match[3].substring(0, 200)
        });
      }

      return { reviews, url: window.location.href };
    });

    return { source: 'bww', ...data };
  } catch (error) {
    console.log(`    Error: ${error.message}`);
    return { source: 'bww', error: error.message };
  }
}

// ============================================================================
// OUTLET-BASED SEARCH
// ============================================================================

async function searchOutlet(page, showTitle, year, outlet) {
  const searchQuery = `"${showTitle}" Broadway review ${year} site:${outlet.domain}`;
  const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;

  try {
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 15000 });

    const result = await page.evaluate((outletName) => {
      // Check if there are any results
      const noResults = document.body.innerText.includes('did not match any documents');
      if (noResults) return { found: false };

      // Get first result
      const firstResult = document.querySelector('div.g a');
      if (!firstResult) return { found: false };

      const url = firstResult.href;
      const title = firstResult.innerText;

      // Try to find a snippet
      const snippet = document.querySelector('div.g span.st, div.g div[data-content-feature]');
      const quote = snippet ? snippet.innerText.substring(0, 200) : null;

      return { found: true, url, title, quote };
    }, outlet.name);

    return { outlet: outlet.name, outletId: outlet.id, tier: outlet.tier, ...result };
  } catch (error) {
    return { outlet: outlet.name, outletId: outlet.id, found: false, error: error.message };
  }
}

async function searchAllOutlets(page, showTitle, year, outlets) {
  console.log(`\n  Searching ${outlets.length} outlets...`);
  const results = [];

  for (const outlet of outlets) {
    process.stdout.write(`    ${outlet.name}... `);
    const result = await searchOutlet(page, showTitle, year, outlet);

    if (result.found) {
      console.log('✓');
      results.push(result);
    } else {
      console.log('✗');
    }

    // Rate limiting to avoid being blocked
    await sleep(1000 + Math.random() * 500);
  }

  return results;
}

// ============================================================================
// UTILITIES
// ============================================================================

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 300;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        totalHeight += distance;
        if (totalHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
      setTimeout(() => { clearInterval(timer); resolve(); }, 8000);
    });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function mergeResults(aggregatorResults, outletResults) {
  const reviewMap = new Map();

  // Add aggregator results
  for (const agg of aggregatorResults) {
    if (agg.reviews) {
      for (const review of agg.reviews) {
        const key = (review.outlet || '').toLowerCase().replace(/[^a-z]/g, '');
        if (key && !reviewMap.has(key)) {
          reviewMap.set(key, {
            ...review,
            source: agg.source
          });
        }
      }
    }
  }

  // Add outlet search results
  for (const result of outletResults) {
    if (result.found) {
      const key = result.outlet.toLowerCase().replace(/[^a-z]/g, '');
      if (!reviewMap.has(key)) {
        reviewMap.set(key, {
          outlet: result.outlet,
          outletId: result.outletId,
          tier: result.tier,
          url: result.url,
          quote: result.quote,
          source: 'outletSearch'
        });
      }
    }
  }

  return Array.from(reviewMap.values());
}

// ============================================================================
// MAIN
// ============================================================================

async function collectReviewsForShow(showSlug) {
  // Load show data
  const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  const shows = showsData.shows || showsData;
  const show = shows.find(s => s.id === showSlug);

  if (!show) {
    console.error(`Show not found: ${showSlug}`);
    return null;
  }

  const year = new Date(show.openingDate).getFullYear();
  console.log(`\n${'='.repeat(70)}`);
  console.log(`COLLECTING REVIEWS: ${show.title} (${year})`);
  console.log('='.repeat(70));

  // Load outlets
  const outletsConfig = JSON.parse(fs.readFileSync(OUTLETS_PATH, 'utf8'));
  const allOutlets = [
    ...outletsConfig.tier1.map(o => ({ ...o, tier: 1 })),
    ...outletsConfig.tier2.map(o => ({ ...o, tier: 2 })),
    ...outletsConfig.tier3.map(o => ({ ...o, tier: 3 }))
  ];

  // Launch browser
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36');

  try {
    // APPROACH 1: Scrape aggregators
    console.log('\n[APPROACH 1] Scraping aggregators...');
    const aggregatorResults = [];

    aggregatorResults.push(await scrapeDTLI(page, showSlug, show.title));
    await sleep(2000);

    aggregatorResults.push(await scrapeShowScore(page, showSlug));
    await sleep(2000);

    aggregatorResults.push(await scrapeBWW(page, showSlug, show.title, year));
    await sleep(2000);

    // APPROACH 2: Search all outlets
    console.log('\n[APPROACH 2] Searching master outlet list...');
    const outletResults = await searchAllOutlets(page, show.title, year, allOutlets);

    // Merge results
    console.log('\n[MERGING] Combining results...');
    const allReviews = mergeResults(aggregatorResults, outletResults);

    // Summary
    console.log(`\n${'='.repeat(70)}`);
    console.log('SUMMARY');
    console.log('='.repeat(70));
    console.log(`Aggregator counts:`);
    for (const agg of aggregatorResults) {
      if (agg.criticCount) {
        console.log(`  ${agg.source}: ${agg.criticCount} critic reviews`);
      } else if (agg.counts) {
        console.log(`  ${agg.source}: ${agg.counts.total} reviews (${agg.counts.up} up, ${agg.counts.meh} meh, ${agg.counts.down} down)`);
      } else if (agg.reviews) {
        console.log(`  ${agg.source}: ${agg.reviews.length} reviews found`);
      }
    }
    console.log(`Outlet search: ${outletResults.filter(r => r.found).length} reviews found`);
    console.log(`\nTOTAL UNIQUE REVIEWS: ${allReviews.length}`);

    const result = {
      showId: showSlug,
      showTitle: show.title,
      year,
      collectedAt: new Date().toISOString(),
      aggregatorResults,
      outletSearchResults: outletResults,
      mergedReviews: allReviews,
      summary: {
        total: allReviews.length,
        byTier: {
          tier1: allReviews.filter(r => r.tier === 1).length,
          tier2: allReviews.filter(r => r.tier === 2).length,
          tier3: allReviews.filter(r => r.tier === 3).length,
          unknown: allReviews.filter(r => !r.tier).length
        }
      }
    };

    return result;

  } finally {
    await browser.close();
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Comprehensive Review Collector - Dual Approach');
    console.log('');
    console.log('Usage:');
    console.log('  node scripts/collect-reviews-comprehensive.js <show-slug>');
    console.log('  node scripts/collect-reviews-comprehensive.js --all');
    console.log('');
    console.log('Examples:');
    console.log('  node scripts/collect-reviews-comprehensive.js mj-2022');
    console.log('  node scripts/collect-reviews-comprehensive.js operation-mincemeat-2025');
    process.exit(1);
  }

  // Ensure output directory exists
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  if (args[0] === '--all') {
    const showsData = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const shows = showsData.shows || showsData;
    const openShows = shows.filter(s => s.status === 'open');

    console.log(`Processing ${openShows.length} open shows...`);

    for (const show of openShows) {
      const result = await collectReviewsForShow(show.id);
      if (result) {
        const outputPath = path.join(OUTPUT_DIR, `${show.id}.json`);
        fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
        console.log(`Saved: ${outputPath}`);
      }
      // Longer delay between shows
      await sleep(5000);
    }
  } else {
    const showSlug = args[0];
    const result = await collectReviewsForShow(showSlug);

    if (result) {
      const outputPath = path.join(OUTPUT_DIR, `${showSlug}.json`);
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
      console.log(`\nSaved: ${outputPath}`);
    }
  }
}

main().catch(console.error);
