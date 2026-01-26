#!/usr/bin/env node
/**
 * Scrape Show Score audience data and update audience-buzz.json
 *
 * Uses ScrapingBee to fetch Show Score pages and extract audience scores.
 * Designed to run in GitHub Actions.
 *
 * Usage:
 *   node scripts/scrape-show-score-audience.js [--show=hamilton-2015] [--limit=10] [--dry-run]
 *
 * Environment variables:
 *   SCRAPINGBEE_API_KEY - Required for fetching pages
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Parse command line args
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const showsArg = args.find(a => a.startsWith('--shows='))?.split('=')[1];
const limitArg = args.find(a => a.startsWith('--limit='));
const showLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');

// Config
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;

// Paths
const showsPath = path.join(__dirname, '../data/shows.json');
const urlsPath = path.join(__dirname, '../data/show-score-urls.json');
const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');
const showScorePath = path.join(__dirname, '../data/show-score.json');

// Load data
const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const urlData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
const audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));
const showScoreData = JSON.parse(fs.readFileSync(showScorePath, 'utf8'));

// Show Score URL mapping (our ID -> Show Score slug)
const SLUG_MAP = {
  'mj-2022': 'mj',
  'operation-mincemeat-2025': 'operation-mincemeat-broadway',
  'two-strangers-bway-2025': 'two-strangers-carry-a-cake-across-new-york-broadway',
  'bug-2026': 'bug',
  'marjorie-prime-2025': 'marjorie-prime',
  'hells-kitchen-2024': 'hells-kitchen',
  'the-outsiders-2024': 'the-outsiders',
  'maybe-happy-ending-2024': 'maybe-happy-ending-broadway',
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
  'death-becomes-her-2024': 'death-becomes-her',
  'cabaret-2024': 'cabaret-at-the-kit-kat-club',
  'water-for-elephants-2024': 'water-for-elephants',
  'the-notebook-2024': 'the-notebook',
  'stereophonic-2024': 'stereophonic',
  'suffs-2024': 'suffs',
  'back-to-the-future-2023': 'back-to-the-future-the-musical',
  'our-town-2024': 'our-town',
  'the-roommate-2024': 'the-roommate',
  'ragtime-2025': 'ragtime',
  'boop-2025': 'boop-the-musical',
  'buena-vista-social-club-2025': 'buena-vista-social-club',
  'just-in-time-2025': 'just-in-time',
  'liberation-2025': 'liberation',
  'oedipus-2025': 'oedipus',
  'chess-2025': 'chess',
  'mamma-mia-2025': 'mamma-mia',
  'queen-versailles-2025': 'the-queen-of-versailles',
};

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch URL through ScrapingBee
 */
function fetchViaScrapingBee(url) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_KEY) {
      reject(new Error('SCRAPINGBEE_API_KEY must be set'));
      return;
    }

    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=true&premium_proxy=true&wait=3000`;

    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * Extract audience data from Show Score HTML
 */
function extractAudienceData(html, showId) {
  const result = {
    score: null,
    reviewCount: null,
  };

  // Method 1: Extract from JSON-LD (most reliable)
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const match of jsonLdMatch) {
      try {
        const jsonContent = match.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
        const data = JSON.parse(jsonContent);
        if (data.aggregateRating) {
          result.score = data.aggregateRating.ratingValue;
          result.reviewCount = data.aggregateRating.reviewCount;
          break;
        }
      } catch (e) {
        // Skip invalid JSON-LD
      }
    }
  }

  // Method 2: Fallback - look for score in page content
  if (!result.score) {
    // Show Score displays the score prominently, try to find it
    const scoreMatch = html.match(/class="[^"]*score[^"]*"[^>]*>(\d+)%?</i) ||
                       html.match(/>(\d{2,3})%?\s*<[^>]*class="[^"]*score/i);
    if (scoreMatch) {
      result.score = parseInt(scoreMatch[1]);
    }
  }

  // Method 3: Look for review count
  if (!result.reviewCount) {
    const countMatch = html.match(/(\d{1,3}(?:,\d{3})*)\s*(?:member\s*)?reviews?/i) ||
                       html.match(/reviewCount['"]\s*:\s*(\d+)/i);
    if (countMatch) {
      result.reviewCount = parseInt(countMatch[1].replace(/,/g, ''));
    }
  }

  return result;
}

/**
 * Get Show Score URL for a show
 */
function getShowScoreUrl(showId) {
  // Check URL mapping first
  if (urlData.shows && urlData.shows[showId]) {
    return urlData.shows[showId];
  }

  // Use slug mapping
  const slug = SLUG_MAP[showId];
  if (slug) {
    return `https://www.show-score.com/broadway-shows/${slug}`;
  }

  // Try to derive from show ID
  const derivedSlug = showId.replace(/-\d{4}$/, '').replace(/-/g, '-');
  return `https://www.show-score.com/broadway-shows/${derivedSlug}`;
}

/**
 * Process a single show
 */
async function processShow(show) {
  console.log(`\nProcessing: ${show.title}`);

  const url = getShowScoreUrl(show.id);
  console.log(`  URL: ${url}`);

  try {
    const html = await fetchViaScrapingBee(url);

    // Check if we got a valid page
    if (!html.includes('show-score.com') && !html.includes('Show Score')) {
      console.log(`  SKIP: Page doesn't appear to be Show Score`);
      return null;
    }

    // Check for 404 or "not found" pages
    if (html.includes('Page not found') || html.includes('404')) {
      console.log(`  SKIP: Show not found on Show Score`);
      return null;
    }

    const data = extractAudienceData(html, show.id);

    if (!data.score) {
      console.log(`  SKIP: Could not extract audience score`);
      return null;
    }

    console.log(`  Score: ${data.score}%, Reviews: ${data.reviewCount || 'unknown'}`);

    return {
      score: data.score,
      reviewCount: data.reviewCount || 0,
    };

  } catch (error) {
    console.error(`  ERROR: ${error.message}`);
    return null;
  }
}

/**
 * Update audience-buzz.json with Show Score data
 */
function updateAudienceBuzz(showId, showTitle, showScoreData) {
  // Initialize show entry if it doesn't exist
  if (!audienceBuzz.shows[showId]) {
    audienceBuzz.shows[showId] = {
      title: showTitle,
      designation: null,
      combinedScore: null,
      sources: {
        showScore: null,
        mezzanine: null,
        reddit: null,
      }
    };
  }

  // Update Show Score data
  audienceBuzz.shows[showId].sources.showScore = {
    score: showScoreData.score,
    reviewCount: showScoreData.reviewCount,
  };

  // Recalculate combined score
  const sources = audienceBuzz.shows[showId].sources;
  const scores = [];
  const weights = [];

  if (sources.showScore?.score) {
    scores.push(sources.showScore.score);
    weights.push(0.4);
  }
  if (sources.mezzanine?.score) {
    scores.push(sources.mezzanine.score);
    weights.push(0.4);
  }
  if (sources.reddit?.score) {
    scores.push(sources.reddit.score);
    weights.push(0.2);
  }

  if (scores.length > 0) {
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const normalizedWeights = weights.map(w => w / totalWeight);

    const combined = Math.round(
      scores.reduce((sum, score, i) => sum + score * normalizedWeights[i], 0)
    );

    audienceBuzz.shows[showId].combinedScore = combined;

    if (combined >= 90) audienceBuzz.shows[showId].designation = 'Loving It';
    else if (combined >= 75) audienceBuzz.shows[showId].designation = 'Liking It';
    else if (combined >= 60) audienceBuzz.shows[showId].designation = 'Take-it-or-Leave-it';
    else audienceBuzz.shows[showId].designation = 'Loathing It';
  }
}

/**
 * Main function
 */
async function main() {
  console.log('Show Score Audience Data Scraper');
  console.log('================================\n');

  if (!SCRAPINGBEE_KEY) {
    console.error('Error: SCRAPINGBEE_API_KEY environment variable must be set');
    process.exit(1);
  }

  // Get shows to process
  let shows = showsData.shows.filter(s => s.status === 'open' || s.status === 'closed');

  // Handle single show filter
  if (showFilter) {
    shows = shows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (shows.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
  }

  // Handle multiple shows (comma-separated)
  if (showsArg) {
    const showIds = showsArg.split(',').map(s => s.trim()).filter(Boolean);
    shows = showsData.shows.filter(s => showIds.includes(s.id) || showIds.includes(s.slug));
    if (shows.length === 0) {
      console.error(`No shows found matching: ${showsArg}`);
      process.exit(1);
    }
    console.log(`Processing specific shows: ${shows.map(s => s.title).join(', ')}`);
  }

  if (showLimit) {
    shows = shows.slice(0, showLimit);
  }

  console.log(`Processing ${shows.length} shows...\n`);

  let processed = 0;
  let successful = 0;

  for (const show of shows) {
    try {
      const data = await processShow(show);
      processed++;

      if (data && !dryRun) {
        updateAudienceBuzz(show.id, show.title, data);
        successful++;

        // Save incrementally after each successful show
        audienceBuzz._meta.lastUpdated = new Date().toISOString().split('T')[0];
        fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));
        console.log(`  ✓ Saved to audience-buzz.json (${successful}/${shows.length} complete)`);
      }
    } catch (e) {
      console.error(`Error processing ${show.title}:`, e.message);
    }

    // Rate limiting - Show Score may rate limit aggressive scraping
    await sleep(3000);
  }

  console.log(`\nDone! Processed ${processed} shows, ${successful} with Show Score data.`);
}

main().catch(console.error);
