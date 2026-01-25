#!/usr/bin/env node

/**
 * Scrape Reddit r/broadway for show discussions and analyze sentiment
 *
 * Uses ScrapingBee to fetch Reddit JSON endpoints (bypasses datacenter IP blocks)
 *
 * This script:
 * 1. Searches r/broadway for discussions about each show
 * 2. Filters to find genuine audience reviews (people who saw the show)
 * 3. Uses Claude to analyze sentiment of each comment
 * 4. Aggregates to a show-level score
 * 5. Updates data/audience-buzz.json with Reddit data
 *
 * Environment variables:
 *   SCRAPINGBEE_API_KEY - ScrapingBee API key for fetching Reddit
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

// Config
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const SUBREDDIT = 'broadway';
const COMMENTS_PER_SHOW = 50;

// Load shows data
const showsPath = path.join(__dirname, '../data/shows.json');
const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');

const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));

/**
 * Fetch URL through ScrapingBee proxy
 */
function fetchViaScrapingBee(url) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_KEY) {
      reject(new Error('SCRAPINGBEE_API_KEY must be set'));
      return;
    }

    // ScrapingBee with premium proxy for Reddit (residential IPs)
    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=false&premium_proxy=true`;

    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            // Try to parse as JSON
            resolve(JSON.parse(data));
          } catch (e) {
            // If it's not JSON, check if it's an error page
            if (data.includes('<html') || data.includes('<!DOCTYPE')) {
              reject(new Error('Got HTML instead of JSON - Reddit may be blocking'));
            } else {
              reject(new Error(`Failed to parse: ${data.slice(0, 100)}`));
            }
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
        }
      });
    }).on('error', reject);
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
  // Clean show title for search
  const cleanTitle = showTitle.replace(/[()]/g, '').trim();

  // Build search queries
  const queries = [
    `${cleanTitle} saw`,
    `${cleanTitle} review`,
  ];

  const allPosts = [];

  for (const query of queries) {
    const encoded = encodeURIComponent(query);
    const url = `https://old.reddit.com/r/${SUBREDDIT}/search.json?q=${encoded}&restrict_sr=on&sort=relevance&t=all&limit=25`;

    try {
      const response = await fetchViaScrapingBee(url);
      if (response.data?.children) {
        allPosts.push(...response.data.children.map(c => c.data));
      }
    } catch (e) {
      console.error(`  Search failed for "${query}":`, e.message);
    }

    // Rate limiting
    await sleep(2000);
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
  const url = `https://old.reddit.com/r/${subreddit}/comments/${postId}.json?limit=100&depth=2`;

  try {
    const response = await fetchViaScrapingBee(url);
    // Response is array: [post, comments]
    if (Array.isArray(response) && response[1]?.data?.children) {
      return response[1].data.children
        .filter(c => c.kind === 't1')
        .map(c => c.data)
        .filter(c => c.body && c.body.length >= 50);
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
    /\b(tour|touring|national tour)\b/i,
    /\b(anyone know|does anyone|when does|how much|where can)\b/i,
  ];

  return comments.filter(comment => {
    const text = comment.body;

    if (exclusionPatterns.some(p => p.test(text))) {
      return false;
    }

    if (audienceIndicators.some(p => p.test(text))) {
      return true;
    }

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

    await sleep(500);
  }

  return results;
}

/**
 * Calculate aggregate score from sentiment results
 */
function calculateScore(sentimentResults) {
  if (sentimentResults.length === 0) return null;

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

  const posts = await searchShowDiscussions(show.title);
  console.log(`  Found ${posts.length} posts`);

  if (posts.length === 0) {
    return null;
  }

  let allComments = [];
  for (const post of posts.slice(0, 5)) { // Reduced to 5 posts to save API calls
    const comments = await getPostComments(post.id, post.subreddit || SUBREDDIT);
    allComments.push(...comments);

    if (allComments.length >= COMMENTS_PER_SHOW * 2) break;

    await sleep(2000);
  }

  console.log(`  Collected ${allComments.length} comments`);

  const audienceComments = filterAudienceComments(allComments, show.title);
  console.log(`  Filtered to ${audienceComments.length} audience comments`);

  if (audienceComments.length < 5) {
    console.log(`  Not enough comments, skipping`);
    return null;
  }

  const topComments = audienceComments
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, COMMENTS_PER_SHOW);

  console.log(`  Analyzing sentiment of ${topComments.length} comments...`);
  const sentimentResults = await analyzeSentiment(topComments);
  console.log(`  Got ${sentimentResults.length} sentiment results`);

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
  console.log('Reddit Sentiment Scraper for Broadway Scorecard');
  console.log('Using ScrapingBee with premium proxy for Reddit access\n');

  if (!SCRAPINGBEE_KEY) {
    console.error('Error: SCRAPINGBEE_API_KEY environment variable must be set');
    process.exit(1);
  }

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

    await sleep(3000);
  }

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
