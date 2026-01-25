#!/usr/bin/env node

/**
 * Scrape Reddit r/broadway for show discussions and analyze sentiment
 *
 * Uses Reddit's public JSON endpoints - NO API CREDENTIALS NEEDED!
 *
 * This script:
 * 1. Searches r/broadway for discussions about each show
 * 2. Filters to find genuine audience reviews (people who saw the show)
 * 3. Uses Claude to analyze sentiment of each comment
 * 4. Aggregates to a show-level score
 * 5. Updates data/audience-buzz.json with Reddit data
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY - Claude API key for sentiment analysis
 *
 * Usage:
 *   node scripts/scrape-reddit-sentiment.js [--show=hamilton-2015] [--dry-run] [--limit=5]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Parse command line args
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const dryRun = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit='));
const showLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

// Reddit config (public endpoints, no auth needed)
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const SUBREDDIT = 'broadway';
const COMMENTS_PER_SHOW = 50; // Target number of comments to analyze per show

// Load shows data
const showsPath = path.join(__dirname, '../data/shows.json');
const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');

const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));

/**
 * Make a request to Reddit's public JSON endpoint
 */
function redditFetch(url) {
  return new Promise((resolve, reject) => {
    // Add .json to URL if not present
    if (!url.includes('.json')) {
      url = url.replace(/\/?$/, '.json');
    }

    const urlObj = new URL(url);

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 429) {
          reject(new Error('Rate limited by Reddit - please wait a few minutes'));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${data.slice(0, 100)}`));
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

/**
 * Sleep helper
 */
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Search Reddit for show discussions
 */
async function searchShowDiscussions(showTitle) {
  // Build search queries - look for people who "saw" or "watched" the show
  const queries = [
    `${showTitle} saw`,
    `${showTitle} review`,
    `${showTitle} thoughts`,
  ];

  const allPosts = [];

  for (const query of queries) {
    const encoded = encodeURIComponent(query);
    const url = `https://www.reddit.com/r/${SUBREDDIT}/search.json?q=${encoded}&restrict_sr=on&sort=relevance&t=all&limit=25`;

    try {
      const response = await redditFetch(url);
      if (response.data?.children) {
        allPosts.push(...response.data.children.map(c => c.data));
      }
    } catch (e) {
      console.error(`  Search failed for "${query}":`, e.message);
    }

    // Rate limiting - Reddit limits to ~60 requests per minute for unauthenticated
    await sleep(1500);
  }

  // Deduplicate by post ID
  const seen = new Set();
  return allPosts.filter(p => {
    if (seen.has(p.id)) return false;
    seen.add(p.id);
    return true;
  });
}

/**
 * Get comments from a post
 */
async function getPostComments(postId, subreddit = SUBREDDIT) {
  const url = `https://www.reddit.com/r/${subreddit}/comments/${postId}.json?limit=100&depth=2`;

  try {
    const response = await redditFetch(url);
    // Response is array: [post, comments]
    if (Array.isArray(response) && response[1]?.data?.children) {
      return response[1].data.children
        .filter(c => c.kind === 't1') // Only comments
        .map(c => c.data)
        .filter(c => c.body && c.body.length >= 50); // Min length
    }
  } catch (e) {
    console.error(`  Failed to get comments for ${postId}:`, e.message);
  }

  return [];
}

/**
 * Filter comments to those likely from people who saw the show
 */
function filterAudienceComments(comments, showTitle) {
  const audienceIndicators = [
    /i (saw|watched|went to|attended|caught|just saw)/i,
    /we (saw|watched|went to|attended)/i,
    /when i (saw|watched) it/i,
    /i've seen (it|this|the show)/i,
    /saw it (last|this|yesterday|today|on)/i,
    /my (favorite|least favorite) part/i,
    /the (cast|actors|leads|ensemble) (was|were)/i,
    /the (music|songs|score|choreography|dancing|staging|set|costumes)/i,
    /standing ovation/i,
    /\d+ out of (5|10)/i,
    /\d\/10/i,
    /★+/,
  ];

  const exclusionPatterns = [
    /\b(cast recording|soundtrack|album|spotify|apple music)\b/i,
    /\b(movie|film|streaming|netflix|disney\+)\b/i,
    /\b(tour|touring|national tour)\b/i, // Focus on Broadway
    /\b(anyone know|does anyone|when does|how much|where can)\b/i, // Questions, not reviews
  ];

  return comments.filter(comment => {
    const text = comment.body;

    // Exclude if matches exclusion patterns
    if (exclusionPatterns.some(p => p.test(text))) {
      return false;
    }

    // Include if matches audience indicators
    if (audienceIndicators.some(p => p.test(text))) {
      return true;
    }

    // Include if mentions show title and has opinion words
    const opinionWords = /\b(loved|hated|amazing|incredible|terrible|boring|mediocre|overrated|underrated|favorite|worst|best|fantastic|awful|disappointed|blown away|meh)\b/i;
    const mentionsShow = text.toLowerCase().includes(showTitle.toLowerCase().replace(/[^\w\s]/g, ''));

    return mentionsShow && opinionWords.test(text);
  });
}

/**
 * Analyze sentiment of comments using Claude
 */
async function analyzeSentiment(comments) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY must be set');
  }

  const client = new Anthropic({ apiKey });

  const SENTIMENT_PROMPT = `You are analyzing Reddit comments about Broadway shows to determine audience sentiment.

For each comment, classify the sentiment as:
- "positive" (enjoyed the show, recommends it)
- "negative" (didn't enjoy, criticizes the show)
- "mixed" (some positive and negative points)
- "neutral" (factual statement, no clear opinion)

Also assign a confidence score: "high", "medium", or "low".

Comments to analyze:
`;

  // Batch comments (max 10 per request to stay under token limits)
  const batchSize = 10;
  const results = [];

  for (let i = 0; i < comments.length; i += batchSize) {
    const batch = comments.slice(i, i + batchSize);
    const commentTexts = batch.map((c, idx) => `[${idx + 1}] ${c.body.slice(0, 500)}`).join('\n\n');

    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 500,
        messages: [
          {
            role: 'user',
            content: SENTIMENT_PROMPT + commentTexts + `

Respond with a JSON array, one object per comment:
[{"id": 1, "sentiment": "positive|negative|mixed|neutral", "confidence": "high|medium|low"}, ...]`
          }
        ]
      });

      const text = response.content[0].text.trim();
      const match = text.match(/\[[\s\S]*\]/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        results.push(...parsed.map((r, idx) => ({
          ...r,
          comment: batch[idx],
          upvotes: batch[idx].score || 0,
        })));
      }
    } catch (e) {
      console.error('  Claude analysis failed:', e.message);
    }

    // Rate limiting for Claude
    await sleep(500);
  }

  return results;
}

/**
 * Calculate aggregate score from sentiment results
 */
function calculateScore(sentimentResults) {
  if (sentimentResults.length === 0) return null;

  // Weight by upvotes and confidence
  const weights = {
    high: 1.0,
    medium: 0.7,
    low: 0.4,
  };

  const sentimentScores = {
    positive: 85,
    mixed: 60,
    neutral: 50,
    negative: 25,
  };

  let totalWeight = 0;
  let weightedSum = 0;
  let positiveCount = 0;
  let negativeCount = 0;
  let mixedCount = 0;

  for (const result of sentimentResults) {
    const weight = weights[result.confidence] * (1 + Math.log10(Math.max(1, result.upvotes)));
    const score = sentimentScores[result.sentiment];

    totalWeight += weight;
    weightedSum += score * weight;

    if (result.sentiment === 'positive') positiveCount++;
    else if (result.sentiment === 'negative') negativeCount++;
    else if (result.sentiment === 'mixed') mixedCount++;
  }

  const score = Math.round(weightedSum / totalWeight);
  const total = sentimentResults.length;

  return {
    score,
    sampleSize: total,
    sentiment: {
      positive: positiveCount / total,
      mixed: mixedCount / total,
      negative: negativeCount / total,
    },
  };
}

/**
 * Process a single show
 */
async function processShow(show) {
  console.log(`\nProcessing: ${show.title}`);

  // Search for discussions
  const posts = await searchShowDiscussions(show.title);
  console.log(`  Found ${posts.length} posts`);

  if (posts.length === 0) {
    return null;
  }

  // Get comments from top posts
  let allComments = [];
  for (const post of posts.slice(0, 8)) { // Top 8 posts (reduced to respect rate limits)
    const comments = await getPostComments(post.id, post.subreddit || SUBREDDIT);
    allComments.push(...comments);

    if (allComments.length >= COMMENTS_PER_SHOW * 2) break;

    // Rate limiting
    await sleep(1500);
  }

  console.log(`  Collected ${allComments.length} comments`);

  // Filter to audience reviews
  const audienceComments = filterAudienceComments(allComments, show.title);
  console.log(`  Filtered to ${audienceComments.length} audience comments`);

  if (audienceComments.length < 5) {
    console.log(`  Not enough comments, skipping`);
    return null;
  }

  // Take top comments by upvotes
  const topComments = audienceComments
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, COMMENTS_PER_SHOW);

  // Analyze sentiment
  console.log(`  Analyzing sentiment of ${topComments.length} comments...`);
  const sentimentResults = await analyzeSentiment(topComments);
  console.log(`  Got ${sentimentResults.length} sentiment results`);

  // Calculate aggregate score
  const scoreData = calculateScore(sentimentResults);
  if (!scoreData) {
    return null;
  }

  console.log(`  Reddit score: ${scoreData.score} (${scoreData.sampleSize} reviews)`);
  console.log(`  Sentiment: ${Math.round(scoreData.sentiment.positive * 100)}% pos, ${Math.round(scoreData.sentiment.mixed * 100)}% mixed, ${Math.round(scoreData.sentiment.negative * 100)}% neg`);

  return {
    score: scoreData.score,
    reviewCount: scoreData.sampleSize,
    lastUpdated: new Date().toISOString().split('T')[0],
    sentiment: scoreData.sentiment,
  };
}

/**
 * Update audience-buzz.json with Reddit data
 */
function updateAudienceBuzz(showId, redditData) {
  if (!audienceBuzz.shows[showId]) {
    console.log(`  Show ${showId} not in audience-buzz.json, skipping`);
    return;
  }

  audienceBuzz.shows[showId].sources.reddit = redditData;

  // Recalculate combined score
  const sources = audienceBuzz.shows[showId].sources;
  const scores = [];
  const weights = [];

  if (sources.showScore?.score) {
    scores.push(sources.showScore.score);
    weights.push(0.4); // 40% weight
  }
  if (sources.mezzanine?.score) {
    scores.push(sources.mezzanine.score);
    weights.push(0.4); // 40% weight
  }
  if (sources.reddit?.score) {
    scores.push(sources.reddit.score);
    weights.push(0.2); // 20% weight for Reddit (more volatile)
  }

  if (scores.length > 0) {
    // Normalize weights
    const totalWeight = weights.reduce((a, b) => a + b, 0);
    const normalizedWeights = weights.map(w => w / totalWeight);

    const combined = Math.round(
      scores.reduce((sum, score, i) => sum + score * normalizedWeights[i], 0)
    );

    audienceBuzz.shows[showId].combinedScore = combined;

    // Update designation
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
  console.log('Reddit Sentiment Scraper for Broadway Scorecard');
  console.log('Using public JSON endpoints (no API credentials needed)\n');

  // Get shows to process
  let shows = showsData.shows.filter(s => s.status === 'open' || s.status === 'closed');

  if (showFilter) {
    shows = shows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (shows.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
  }

  if (showLimit) {
    shows = shows.slice(0, showLimit);
  }

  console.log(`Processing ${shows.length} shows...\n`);

  let processed = 0;
  let successful = 0;

  for (const show of shows) {
    try {
      const redditData = await processShow(show);
      processed++;

      if (redditData && !dryRun) {
        updateAudienceBuzz(show.id, redditData);
        successful++;
      }
    } catch (e) {
      console.error(`Error processing ${show.title}:`, e.message);
    }

    // Rate limiting between shows (3 seconds to be safe with public endpoints)
    await sleep(3000);
  }

  // Save updated audience-buzz.json
  if (!dryRun && successful > 0) {
    audienceBuzz._meta.lastUpdated = new Date().toISOString().split('T')[0];
    audienceBuzz._meta.sources = ['Show Score', 'Mezzanine', 'Reddit'];
    audienceBuzz._meta.notes = 'Combined score: Show Score 40%, Mezzanine 40%, Reddit 20% (when all available)';

    fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));
    console.log(`\nSaved updates to audience-buzz.json`);
  }

  console.log(`\nDone! Processed ${processed} shows, ${successful} with Reddit data.`);
}

main().catch(console.error);
