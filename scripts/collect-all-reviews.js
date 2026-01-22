#!/usr/bin/env node
/**
 * Comprehensive Review Collector
 *
 * Systematically searches ALL known Broadway critic outlets for reviews.
 * No need to reverse-engineer aggregator lists - we check every outlet.
 *
 * Usage:
 *   node scripts/collect-all-reviews.js <show-title> <year>
 *   node scripts/collect-all-reviews.js "MJ The Musical" 2022
 *   node scripts/collect-all-reviews.js "Operation Mincemeat" 2025
 *   node scripts/collect-all-reviews.js --all
 *
 * Requires: ANTHROPIC_API_KEY environment variable for Claude API
 */

const fs = require('fs');
const path = require('path');

// Load outlet configuration
const outletsPath = path.join(__dirname, 'config', 'critic-outlets.json');
const outletsConfig = JSON.parse(fs.readFileSync(outletsPath, 'utf8'));
const ALL_OUTLETS = [
  ...outletsConfig.tier1.map(o => ({ ...o, tier: 1 })),
  ...outletsConfig.tier2.map(o => ({ ...o, tier: 2 })),
  ...outletsConfig.tier3.map(o => ({ ...o, tier: 3 }))
];

// Rate limiting
const DELAY_MS = 1500; // Delay between API calls

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Use Claude API with web search to find a review
 */
async function searchForReview(showTitle, year, outlet) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable required');
  }

  const prompt = `Search for: "${showTitle}" Broadway review ${year} site:${outlet.domain}

If you find a review, extract:
1. URL of the review
2. Critic name
3. Original rating (if any - stars, letter grade, etc.)
4. A key quote (1-2 sentences)
5. Publish date

If no review exists, say "NO_REVIEW_FOUND".

Respond in JSON format:
{
  "found": true/false,
  "url": "...",
  "critic": "...",
  "originalRating": "..." or null,
  "quote": "...",
  "publishDate": "YYYY-MM-DD"
}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${error}`);
  }

  const data = await response.json();
  const content = data.content[0].text;

  // Parse JSON from response
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch (e) {
    console.error(`Failed to parse response for ${outlet.name}: ${content}`);
  }

  return { found: false };
}

/**
 * Collect reviews for a single show
 */
async function collectReviewsForShow(showTitle, year, showId) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Collecting reviews for: ${showTitle} (${year})`);
  console.log('='.repeat(60));

  const reviews = [];
  const notFound = [];

  for (const outlet of ALL_OUTLETS) {
    process.stdout.write(`  Checking ${outlet.name}... `);

    try {
      const result = await searchForReview(showTitle, year, outlet);

      if (result.found) {
        console.log(`✓ Found (${result.originalRating || 'no rating'})`);
        reviews.push({
          showId,
          outletId: outlet.id,
          outlet: outlet.name,
          tier: outlet.tier,
          criticName: result.critic,
          url: result.url,
          publishDate: result.publishDate,
          originalRating: result.originalRating,
          pullQuote: result.quote,
          // Score will be calculated later based on originalRating
          assignedScore: null,
          bucket: null,
          thumb: null
        });
      } else {
        console.log('✗ Not found');
        notFound.push(outlet.name);
      }

      await sleep(DELAY_MS);

    } catch (error) {
      console.log(`✗ Error: ${error.message}`);
      notFound.push(outlet.name);
    }
  }

  console.log(`\nFound ${reviews.length} reviews for ${showTitle}`);
  console.log(`No reviews from: ${notFound.join(', ')}`);

  return { reviews, notFound };
}

/**
 * Convert original ratings to 0-100 scores
 */
function calculateScore(originalRating, designation) {
  if (!originalRating) return null;

  const rating = originalRating.toLowerCase().trim();

  // Star ratings (X/5)
  if (rating.includes('/5') || rating.includes('out of 5')) {
    const match = rating.match(/([\d.]+)\s*\/?\s*(?:out of\s*)?5/);
    if (match) {
      const stars = parseFloat(match[1]);
      return Math.round((stars / 5) * 100);
    }
  }

  // Star ratings (X/4)
  if (rating.includes('/4') || rating.includes('out of 4')) {
    const match = rating.match(/([\d.]+)\s*\/?\s*(?:out of\s*)?4/);
    if (match) {
      const stars = parseFloat(match[1]);
      return Math.round((stars / 4) * 100);
    }
  }

  // Letter grades
  const letterGrades = {
    'a+': 100, 'a': 95, 'a-': 92,
    'b+': 88, 'b': 83, 'b-': 78,
    'c+': 73, 'c': 68, 'c-': 63,
    'd+': 58, 'd': 53, 'd-': 48,
    'f': 35
  };
  if (letterGrades[rating]) return letterGrades[rating];

  // Sentiment keywords
  if (rating.includes('rave') || rating.includes('excellent')) return 90;
  if (rating.includes('positive') || rating.includes('recommend')) return 80;
  if (rating.includes('mixed') || rating.includes('middling')) return 60;
  if (rating.includes('negative') || rating.includes('pan')) return 40;

  // Critic's Pick / designations
  if (rating.includes("critic's pick") || rating.includes('critics pick')) return 90;

  return null;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2 && args[0] !== '--all') {
    console.log('Usage: node scripts/collect-all-reviews.js <show-title> <year>');
    console.log('       node scripts/collect-all-reviews.js --all');
    console.log('\nExamples:');
    console.log('  node scripts/collect-all-reviews.js "MJ The Musical" 2022');
    console.log('  node scripts/collect-all-reviews.js "Operation Mincemeat" 2025');
    process.exit(1);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable required');
    console.log('\nSet it with: export ANTHROPIC_API_KEY=your-key-here');
    process.exit(1);
  }

  const outputDir = path.join(__dirname, '..', 'data', 'collected-reviews');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  if (args[0] === '--all') {
    // Process all shows from shows.json
    const showsPath = path.join(__dirname, '..', 'data', 'shows.json');
    const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8'));

    for (const show of shows) {
      if (show.status === 'open') {
        const year = new Date(show.openingDate).getFullYear();
        const result = await collectReviewsForShow(show.title, year, show.id);

        const outputPath = path.join(outputDir, `${show.id}.json`);
        fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
        console.log(`Saved: ${outputPath}`);
      }
    }
  } else {
    const showTitle = args[0];
    const year = args[1];
    const showId = showTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-' + year;

    const result = await collectReviewsForShow(showTitle, year, showId);

    const outputPath = path.join(outputDir, `${showId}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
    console.log(`\nSaved: ${outputPath}`);
  }
}

main().catch(console.error);
