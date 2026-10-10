#!/usr/bin/env node

/**
 * Test script for new Reddit buzz collection
 *
 * Tests the new reddit-api.js and buzz-classifier.js modules
 * on specific shows to verify they're working correctly.
 *
 * Usage:
 *   node scripts/test-reddit-buzz.js [--show="Good Night and Good Luck"]
 *
 * Environment:
 *   GEMINI_API_KEY - Primary classifier
 *   OPENAI_API_KEY - Fallback classifier
 *   SCRAPINGBEE_API_KEY - Fallback for Reddit API
 */

const path = require('path');
const { searchAllPosts, collectCommentsFromPosts } = require('./lib/reddit-api');
const { classifyAllComments } = require('./lib/buzz-classifier');

// Parse args
const args = process.argv.slice(2);
const showArg = args.find(a => a.startsWith('--show='));
const showTitle = showArg ? showArg.split('=')[1] : null;
const verbose = args.includes('--verbose');

// Default test shows
// Note: expectedMin is 15, matching MIN_ITEMS_FOR_SCORE in the scraper
// This tests that the scraper is working, not that a show has tons of buzz
const TEST_SHOWS = [
  { title: 'Good Night and Good Luck', expectedMin: 15 },
  { title: 'Wicked', expectedMin: 15 }
];

/**
 * Calculate buzz score from classifications
 */
function calculateBuzzScore(classifications) {
  const relevant = classifications.filter(c => c.is_relevant);
  if (relevant.length === 0) return null;

  const sentimentScores = {
    enthusiastic: 95,
    positive: 80,
    mixed: 55,
    negative: 25,
    neutral: 50
  };

  const sentimentCounts = {
    enthusiastic: 0,
    positive: 0,
    mixed: 0,
    negative: 0,
    neutral: 0
  };

  for (const item of relevant) {
    const sentiment = item.sentiment || 'neutral';
    sentimentCounts[sentiment]++;
  }

  // Weighted average
  let weightedSum = 0;
  let totalWeight = 0;
  for (const [sentiment, count] of Object.entries(sentimentCounts)) {
    if (count > 0) {
      weightedSum += sentimentScores[sentiment] * count;
      totalWeight += count;
    }
  }

  const baseScore = totalWeight > 0 ? weightedSum / totalWeight : 50;

  // Enthusiasm bonus
  const enthusiasmRate = sentimentCounts.enthusiastic / relevant.length;
  const enthusiasmBonus = Math.min(5, enthusiasmRate * 15);

  return {
    score: Math.min(99, Math.round(baseScore + enthusiasmBonus)),
    reviewCount: relevant.length,
    sentiment: {
      enthusiastic: Math.round(sentimentCounts.enthusiastic / relevant.length * 100),
      positive: Math.round(sentimentCounts.positive / relevant.length * 100),
      mixed: Math.round(sentimentCounts.mixed / relevant.length * 100),
      negative: Math.round(sentimentCounts.negative / relevant.length * 100),
      neutral: Math.round(sentimentCounts.neutral / relevant.length * 100)
    },
    positiveRate: Math.round((sentimentCounts.enthusiastic + sentimentCounts.positive) / relevant.length * 100)
  };
}

/**
 * Process a single show
 */
async function processShow(title) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing: ${title}`);
  console.log('='.repeat(60));

  // 1. Search for posts with audience-focused queries
  console.log('\n1. Searching for audience reactions...');

  const cleanTitle = title.replace(/[()]/g, '').trim();
  const searches = [
    `flair:Review "${cleanTitle}"`,
    `"${cleanTitle}" saw`,
    `"${cleanTitle}" loved`,
    `"${cleanTitle}" amazing`,
    `"${cleanTitle}" recommend`,
    `"${cleanTitle}" review`,
    `"${cleanTitle}"`,
  ];

  const allPosts = [];
  const seenIds = new Set();

  for (const query of searches) {
    if (allPosts.length >= 100) break;
    try {
      const results = await searchAllPosts('broadway', query, 50);
      for (const post of results) {
        if (!seenIds.has(post.id)) {
          seenIds.add(post.id);
          allPosts.push(post);
        }
      }
    } catch (e) {
      if (verbose) console.log(`   Search "${query}" failed: ${e.message}`);
    }
  }

  const posts = allPosts.slice(0, 100);
  console.log(`   Found ${posts.length} posts from audience-focused searches`);

  if (posts.length === 0) {
    console.log('   No posts found, skipping');
    return null;
  }

  // Show top posts
  if (verbose) {
    console.log('\n   Top 5 posts by engagement:');
    posts
      .sort((a, b) => (b.score + b.num_comments) - (a.score + a.num_comments))
      .slice(0, 5)
      .forEach(p => console.log(`   - [${p.num_comments} comments] ${p.title.slice(0, 50)}...`));
  }

  // 2. Collect comments from top posts
  console.log('\n2. Collecting comments from top 30 posts...');
  const topPosts = posts
    .sort((a, b) => (b.score + b.num_comments) - (a.score + a.num_comments))
    .slice(0, 30);

  const comments = await collectCommentsFromPosts('broadway', topPosts, 500);
  console.log(`   Collected ${comments.length} comments`);

  // 3. Filter comments
  const BOT_PATTERNS = [
    /^It looks like you've shared an image/i,
    /^I'm a bot/i,
    /^I am a bot/i,
    /^This is an automated/i,
    /RemindMe!/i,
    /u\/RemindMeBot/i,
  ];

  const filtered = comments.filter(c => {
    if (!c.body || c.body.length < 15) return false;
    if (c.body === '[deleted]' || c.body === '[removed]') return false;
    // Filter out bot messages
    for (const pattern of BOT_PATTERNS) {
      if (pattern.test(c.body)) return false;
    }
    return true;
  });
  console.log(`   After filtering: ${filtered.length} comments (removed ${comments.length - filtered.length} short/deleted/bots)`);

  if (filtered.length === 0) {
    console.log('   No valid comments, skipping');
    return null;
  }

  // 4. Classify comments
  console.log('\n3. Classifying comments with LLM...');
  const classifications = await classifyAllComments(title, filtered, 50);

  // 5. Calculate results
  const relevant = classifications.filter(c => c.is_relevant);
  console.log(`   ${relevant.length} relevant buzz items (of ${classifications.length} classified)`);

  if (relevant.length === 0) {
    console.log('   No relevant buzz found');
    return null;
  }

  // 6. Calculate buzz score
  const buzzScore = calculateBuzzScore(classifications);

  // 7. Show results
  console.log('\n' + '-'.repeat(40));
  console.log('RESULTS:');
  console.log('-'.repeat(40));
  console.log(`Buzz Score: ${buzzScore.score}`);
  console.log(`Review Count: ${buzzScore.reviewCount}`);
  console.log(`Positive Rate: ${buzzScore.positiveRate}%`);
  console.log(`Sentiment Distribution:`);
  console.log(`  Enthusiastic: ${buzzScore.sentiment.enthusiastic}%`);
  console.log(`  Positive: ${buzzScore.sentiment.positive}%`);
  console.log(`  Mixed: ${buzzScore.sentiment.mixed}%`);
  console.log(`  Negative: ${buzzScore.sentiment.negative}%`);
  console.log(`  Neutral: ${buzzScore.sentiment.neutral}%`);

  // 8. Show sample classifications
  console.log('\nSample classified buzz:');
  const samples = relevant.slice(0, 8);
  for (const sample of samples) {
    const preview = sample.comment.body.replace(/\n/g, ' ').slice(0, 60);
    console.log(`  [${sample.sentiment}] "${preview}..."`);
  }

  return {
    title,
    postsFound: posts.length,
    commentsCollected: comments.length,
    relevantBuzz: relevant.length,
    buzzScore
  };
}

/**
 * Main
 */
async function main() {
  console.log('Reddit Buzz Test Script');
  console.log('Testing new reddit-api.js and buzz-classifier.js modules\n');

  // Check for API keys
  if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error('Error: At least one of GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY must be set');
    process.exit(1);
  }

  const shows = showTitle ? [{ title: showTitle, expectedMin: 20 }] : TEST_SHOWS;
  const results = [];

  for (const show of shows) {
    try {
      const result = await processShow(show.title);
      if (result) {
        results.push({ ...result, expected: show.expectedMin });
      }
    } catch (e) {
      console.error(`\nError processing ${show.title}:`, e.message);
      if (verbose) console.error(e.stack);
    }
  }

  // Summary
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY');
  console.log('='.repeat(60));

  for (const result of results) {
    const status = result.relevantBuzz >= result.expected ? '✓ PASS' : '✗ FAIL';
    console.log(`\n${result.title}:`);
    console.log(`  ${status} - ${result.relevantBuzz} buzz items (expected >= ${result.expected})`);
    console.log(`  Score: ${result.buzzScore.score}, Positive: ${result.buzzScore.positiveRate}%`);
  }

  // Check if all passed
  const allPassed = results.every(r => r.relevantBuzz >= r.expected);
  if (allPassed && results.length > 0) {
    console.log('\n✓ All tests passed! Ready to proceed with full implementation.');
  } else if (results.length === 0) {
    console.log('\n✗ No results - something went wrong.');
    process.exit(1);
  } else {
    console.log('\n✗ Some tests failed - review classifications before proceeding.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
