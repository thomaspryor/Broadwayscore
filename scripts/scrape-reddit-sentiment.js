#!/usr/bin/env node

/**
 * Reddit Buzz Scraper for Broadway Scorecard
 *
 * Measures actual Reddit "buzz" - not just post-viewing reviews, but:
 * - How often people recommend the show
 * - How enthusiastically people discuss it
 * - Volume of positive mentions
 * - Engagement (upvotes) on show discussions
 *
 * Uses ScrapingBee to fetch Reddit JSON endpoints.
 *
 * Environment variables:
 *   SCRAPINGBEE_API_KEY - ScrapingBee API key for fetching Reddit
 *   ANTHROPIC_API_KEY - Claude API key for sentiment analysis
 *
 * Usage:
 *   node scripts/scrape-reddit-sentiment.js [--show=hamilton-2015] [--dry-run] [--limit=5] [--verbose]
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// Parse command line args
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const showsArg = args.find(a => a.startsWith('--shows='))?.split('=')[1]; // Comma-separated show IDs/slugs
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const limitArg = args.find(a => a.startsWith('--limit='));
const showLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;

// Config
const SCRAPINGBEE_KEY = process.env.SCRAPINGBEE_API_KEY;
const SUBREDDIT = 'broadway';

// Load shows data
const showsPath = path.join(__dirname, '../data/shows.json');
const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');

const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));

/**
 * Sanitize text to remove problematic Unicode characters
 * Removes unpaired surrogates and other characters that break JSON encoding
 */
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return text;

  // Remove unpaired surrogates (characters in 0xD800-0xDFFF range that aren't properly paired)
  // This regex matches lone high surrogates not followed by low surrogates,
  // and lone low surrogates not preceded by high surrogates
  let sanitized = text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');

  // Also remove other problematic control characters (except newlines and tabs)
  sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  return sanitized;
}

/**
 * Fetch URL through ScrapingBee proxy
 */
function fetchViaScrapingBee(url) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_KEY) {
      reject(new Error('SCRAPINGBEE_API_KEY must be set'));
      return;
    }

    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=false&premium_proxy=true`;

    https.get(apiUrl, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Search for all posts mentioning the show
 * Uses multiple search strategies to capture different types of buzz
 */
async function searchShowPosts(showTitle) {
  // Clean title for search
  const cleanTitle = showTitle.replace(/[()]/g, '').trim();

  // For generic titles that could be confused with movies/books, ONLY search with "Broadway" qualifier
  const genericTitles = ['The Outsiders', 'Chicago', 'Cabaret', 'The Wiz', 'Oliver!', 'Annie', 'Gypsy', 'Grease'];
  const needsQualifier = genericTitles.some(t => cleanTitle.toLowerCase().includes(t.toLowerCase()));

  // Multiple search strategies to capture different types of buzz
  let searches;

  if (needsQualifier) {
    // For generic titles, ONLY use Broadway-qualified searches to avoid movie/book noise
    searches = [
      { query: `"${cleanTitle}" Broadway`, sort: 'relevance' },
      { query: `"${cleanTitle}" Broadway`, sort: 'top' },
      { query: `"${cleanTitle}" musical Broadway`, sort: 'relevance' },
      { query: `flair:Review "${cleanTitle}"`, sort: 'relevance' },
      { query: `"${cleanTitle}" Broadway recommend`, sort: 'relevance' },
      { query: `"${cleanTitle}" Broadway favorite`, sort: 'relevance' },
    ];
  } else {
    // For unique titles, use standard searches
    searches = [
      { query: cleanTitle, sort: 'relevance' },
      { query: cleanTitle, sort: 'top' },
      { query: `flair:Review ${cleanTitle}`, sort: 'relevance' },
      { query: `${cleanTitle} recommend`, sort: 'relevance' },
      { query: `${cleanTitle} "must see"`, sort: 'relevance' },
      { query: `${cleanTitle} favorite`, sort: 'relevance' },
    ];
  }

  const allPosts = [];
  const seenIds = new Set();

  for (const search of searches) {
    const encoded = encodeURIComponent(search.query);
    const url = `https://old.reddit.com/r/${SUBREDDIT}/search.json?q=${encoded}&restrict_sr=on&sort=${search.sort}&t=all&limit=50`;

    try {
      const response = await fetchViaScrapingBee(url);
      if (response.data?.children) {
        for (const child of response.data.children) {
          const post = child.data;
          if (!seenIds.has(post.id)) {
            seenIds.add(post.id);
            allPosts.push({
              id: post.id,
              title: post.title,
              selftext: post.selftext || '',
              score: post.score || 0,
              num_comments: post.num_comments || 0,
              created_utc: post.created_utc,
              link_flair_text: post.link_flair_text || null,
              permalink: post.permalink,
              subreddit: post.subreddit,
            });
          }
        }
      }
    } catch (e) {
      if (verbose) console.error(`  Search failed for "${search.query}":`, e.message);
    }

    await sleep(2000);
  }

  // Sort by score (engagement) descending
  allPosts.sort((a, b) => b.score - a.score);

  return allPosts;
}

/**
 * Get comments from a post
 */
async function getPostComments(postId, subreddit = SUBREDDIT) {
  const url = `https://old.reddit.com/r/${subreddit}/comments/${postId}.json?limit=200&depth=3`;

  try {
    const response = await fetchViaScrapingBee(url);
    if (Array.isArray(response) && response[1]?.data?.children) {
      return response[1].data.children
        .filter(c => c.kind === 't1')
        .map(c => ({
          body: c.data.body,
          score: c.data.score || 0,
          id: c.data.id,
        }))
        .filter(c => c.body && c.body.length >= 30 && c.body !== '[deleted]' && c.body !== '[removed]');
    }
  } catch (e) {
    if (verbose) console.error(`  Failed to get comments for ${postId}:`, e.message);
  }

  return [];
}

/**
 * Analyze a batch of content (posts and comments) for show sentiment
 * Uses Claude to classify sentiment and enthusiasm level
 */
async function analyzeContent(showTitle, posts, comments) {
  const Anthropic = require('@anthropic-ai/sdk').default;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY must be set');
  }

  const client = new Anthropic({ apiKey });

  // Prepare content for analysis
  // Include post titles, post bodies, and comments
  const contentItems = [];

  // Prioritize Review-tagged posts (most likely to be actual reviews)
  const reviewPosts = posts.filter(p => p.link_flair_text?.toLowerCase().includes('review'));
  const otherPosts = posts.filter(p => !p.link_flair_text?.toLowerCase().includes('review'));

  // Add all review posts first (up to 20)
  for (const post of reviewPosts.slice(0, 20)) {
    const text = sanitizeText(post.title + (post.selftext ? '\n' + post.selftext.slice(0, 500) : ''));
    contentItems.push({
      type: 'post',
      text: text.slice(0, 600),
      score: post.score,
      isReview: true,
    });
  }

  // Then add other top posts (up to 30 total)
  const remainingSlots = 30 - contentItems.length;
  for (const post of otherPosts.slice(0, remainingSlots)) {
    const text = sanitizeText(post.title + (post.selftext ? '\n' + post.selftext.slice(0, 500) : ''));
    contentItems.push({
      type: 'post',
      text: text.slice(0, 600),
      score: post.score,
      isReview: false,
    });
  }

  // Add top comments (sorted by upvotes) - increase to 70
  const topComments = comments
    .sort((a, b) => b.score - a.score)
    .slice(0, 70);

  for (const comment of topComments) {
    contentItems.push({
      type: 'comment',
      text: sanitizeText(comment.body.slice(0, 400)),
      score: comment.score,
    });
  }

  if (contentItems.length === 0) {
    return null;
  }

  // Batch analyze with Claude
  const ANALYSIS_PROMPT = `You are analyzing Reddit r/Broadway discussions to measure how much people LOVE the Broadway show "${showTitle}".

For each item, determine if it contains a personal opinion SPECIFICALLY about "${showTitle}".

1. **is_about_target_show**: Does this content express an opinion specifically about "${showTitle}"?

   Answer "yes" if they are expressing any opinion about "${showTitle}" specifically:
   - "I saw ${showTitle} and loved it" = yes
   - "You should see ${showTitle}" = yes
   - "${showTitle} is my favorite" = yes
   - "${showTitle} was disappointing" = yes
   - "The music in ${showTitle} is incredible" = yes

   Answer "no" if:
   - It's primarily about a DIFFERENT show (even if "${showTitle}" is mentioned)
   - It's news/logistics (medical emergencies, injuries, tickets, cast changes)
   - It's meta-commentary about reviews, not their own opinion
   - "${showTitle}" is only briefly mentioned in a multi-show list

2. **sentiment** (ONLY if is_about_target_show is "yes"):
   - "enthusiastic" = LOVES it: amazing, incredible, must-see, obsessed, sobbing, favorite, life-changing, can't stop thinking about it
   - "positive" = Enjoyed it, liked it, good experience, would recommend
   - "mixed" = Some good, some bad
   - "negative" = Didn't enjoy, disappointed, wouldn't recommend
   - "neutral" = Mentioned seeing it but no clear opinion

3. **is_recommendation**: Are they telling others to see "${showTitle}"? (yes/no)

IMPORTANT: Be generous! If someone expresses ANY personal opinion about "${showTitle}" specifically (positive OR negative), answer "yes" to is_about_target_show. We want all opinions - good and bad - as long as they're about THIS show.

Content to analyze:
`;

  const results = {
    totalItems: 0,
    relevantItems: 0,
    sentimentCounts: { enthusiastic: 0, positive: 0, mixed: 0, negative: 0, neutral: 0 },
    recommendations: 0,
    totalUpvotes: 0,
    reviewPosts: 0,
    sampleComments: [],
  };

  // Process in batches
  const batchSize = 15;
  for (let i = 0; i < contentItems.length; i += batchSize) {
    const batch = contentItems.slice(i, i + batchSize);
    const batchText = batch.map((item, idx) => {
      const prefix = item.type === 'post' ? (item.isReview ? '[REVIEW POST]' : '[POST]') : '[COMMENT]';
      return `[${idx + 1}] ${prefix} (${item.score} upvotes)\n${item.text}`;
    }).join('\n\n---\n\n');

    try {
      const response = await client.messages.create({
        model: 'claude-opus-4-20250514',
        max_tokens: 1000,
        messages: [
          {
            role: 'user',
            content: ANALYSIS_PROMPT + batchText + `

Respond with a JSON array, one object per item:
[{"id": 1, "is_about_target_show": "yes|no", "sentiment": "enthusiastic|positive|mixed|negative|neutral", "is_recommendation": "yes|no"}, ...]

If is_about_target_show is "no", sentiment can be "neutral" (we'll skip it anyway).
Be generous with "enthusiastic" - raving, must-see, can't stop talking about it.
Be generous with "positive" - enjoyed it overall, would recommend.`
          }
        ]
      });

      const text = response.content[0].text.trim();
      // Extract JSON array - be more flexible with regex to handle extra text around it
      const match = text.match(/\[\s*\{[\s\S]*?\}\s*\]/);
      if (match) {
        let parsed;
        try {
          parsed = JSON.parse(match[0]);
        } catch (parseErr) {
          // Try to clean up the JSON and parse again
          const cleaned = match[0]
            .replace(/,\s*]/g, ']')  // Remove trailing commas
            .replace(/}\s*{/g, '},{'); // Fix missing commas between objects
          try {
            parsed = JSON.parse(cleaned);
          } catch (e) {
            console.error('  JSON parse failed even after cleanup, skipping batch');
            continue;
          }
        }
        if (!Array.isArray(parsed)) continue;
        for (let j = 0; j < parsed.length && j < batch.length; j++) {
          const analysis = parsed[j];
          const item = batch[j];

          results.totalItems++;

          // Only count items that are actually about show quality
          if (analysis.is_about_target_show === 'yes') {
            results.relevantItems++;
            results.sentimentCounts[analysis.sentiment]++;
            results.totalUpvotes += item.score;

            if (analysis.is_recommendation === 'yes') {
              results.recommendations++;
            }

            if (item.type === 'post' && item.isReview) {
              results.reviewPosts++;
            }

            // Save sample comments for debugging - include ALL sentiments
            if (results.sampleComments.length < 10) {
              results.sampleComments.push({
                text: item.text.slice(0, 200),
                sentiment: analysis.sentiment,
                score: item.score,
              });
            }
          }
        }
      }
    } catch (e) {
      console.error('  Claude analysis failed:', e.message);
    }

    await sleep(500);
  }

  return results;
}

/**
 * Calculate buzz score from analysis results
 *
 * Scoring methodology:
 * - Base score from sentiment distribution (enthusiastic=95, positive=80, mixed=55, negative=25)
 * - Bonus for high recommendation rate
 * - Bonus for high engagement (upvotes)
 * - Weighted by volume of discussion
 */
function calculateBuzzScore(analysis) {
  if (!analysis || analysis.relevantItems === 0) {
    return null;
  }

  const { sentimentCounts, relevantItems, recommendations, totalUpvotes } = analysis;

  // Sentiment scores (more generous than before)
  const sentimentScores = {
    enthusiastic: 95,
    positive: 80,
    mixed: 55,
    negative: 25,
    neutral: 50,
  };

  // Calculate weighted sentiment score
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [sentiment, count] of Object.entries(sentimentCounts)) {
    if (count > 0) {
      weightedSum += sentimentScores[sentiment] * count;
      totalWeight += count;
    }
  }

  let baseScore = totalWeight > 0 ? weightedSum / totalWeight : 50;

  // Recommendation bonus (up to +5 points)
  const recommendationRate = recommendations / relevantItems;
  const recommendationBonus = Math.min(5, recommendationRate * 10);

  // Enthusiasm bonus (up to +5 points for high enthusiasm rate)
  const enthusiasmRate = sentimentCounts.enthusiastic / relevantItems;
  const enthusiasmBonus = Math.min(5, enthusiasmRate * 15);

  // Calculate final score (capped at 99)
  const finalScore = Math.min(99, Math.round(baseScore + recommendationBonus + enthusiasmBonus));

  // Calculate sentiment percentages
  const total = relevantItems;
  const positiveRate = (sentimentCounts.enthusiastic + sentimentCounts.positive) / total;
  const mixedRate = sentimentCounts.mixed / total;
  const negativeRate = sentimentCounts.negative / total;

  return {
    score: finalScore,
    sampleSize: relevantItems,
    recommendations,
    totalUpvotes,
    sentiment: {
      enthusiastic: sentimentCounts.enthusiastic / total,
      positive: sentimentCounts.positive / total,
      mixed: mixedRate,
      negative: negativeRate,
    },
    positiveRate, // enthusiastic + positive combined
  };
}

/**
 * Process a single show
 */
async function processShow(show) {
  console.log(`\nProcessing: ${show.title}`);

  // Search for posts about this show
  const posts = await searchShowPosts(show.title);
  console.log(`  Found ${posts.length} posts`);

  if (posts.length === 0) {
    return null;
  }

  // Count review-tagged posts
  const reviewPosts = posts.filter(p => p.link_flair_text?.toLowerCase().includes('review'));
  console.log(`  ${reviewPosts.length} tagged as 'Review'`);

  // Get comments from top posts (by engagement)
  let allComments = [];
  const postsToScrape = posts.slice(0, 10); // Top 10 posts by score

  for (const post of postsToScrape) {
    const comments = await getPostComments(post.id, post.subreddit || SUBREDDIT);
    allComments.push(...comments);

    if (allComments.length >= 150) break;
    await sleep(2000);
  }

  console.log(`  Collected ${allComments.length} comments from top ${postsToScrape.length} posts`);

  // Analyze content with Claude
  console.log(`  Analyzing sentiment...`);
  const analysis = await analyzeContent(show.title, posts, allComments);

  if (!analysis || analysis.relevantItems < 5) {
    console.log(`  Not enough relevant content (${analysis?.relevantItems || 0} items), skipping`);
    return null;
  }

  console.log(`  Analyzed ${analysis.relevantItems} relevant items out of ${analysis.totalItems} total`);

  // Calculate buzz score
  const scoreData = calculateBuzzScore(analysis);
  if (!scoreData) {
    return null;
  }

  // Log results
  const enthusiasticPct = Math.round(scoreData.sentiment.enthusiastic * 100);
  const positivePct = Math.round(scoreData.sentiment.positive * 100);
  const mixedPct = Math.round(scoreData.sentiment.mixed * 100);
  const negativePct = Math.round(scoreData.sentiment.negative * 100);

  console.log(`  Reddit Buzz Score: ${scoreData.score}`);
  console.log(`  Sentiment: ${enthusiasticPct}% enthusiastic, ${positivePct}% positive, ${mixedPct}% mixed, ${negativePct}% negative`);
  console.log(`  Recommendations: ${scoreData.recommendations} (${Math.round(scoreData.recommendations / scoreData.sampleSize * 100)}%)`);
  console.log(`  Total upvotes on analyzed content: ${scoreData.totalUpvotes}`);

  // Always show sample content so we can debug sentiment classification
  if (analysis.sampleComments.length > 0) {
    console.log(`  Sample content analyzed:`);
    for (const sample of analysis.sampleComments.slice(0, 6)) {
      const truncated = sample.text.replace(/\n/g, ' ').slice(0, 80);
      console.log(`    [${sample.sentiment}] "${truncated}..."`);
    }
  }

  return {
    score: scoreData.score,
    reviewCount: scoreData.sampleSize,
    lastUpdated: new Date().toISOString().split('T')[0],
    sentiment: {
      enthusiastic: scoreData.sentiment.enthusiastic,
      positive: scoreData.sentiment.positive,
      mixed: scoreData.sentiment.mixed,
      negative: scoreData.sentiment.negative,
    },
    recommendations: scoreData.recommendations,
    positiveRate: scoreData.positiveRate,
  };
}

/**
 * Calculate combined Audience Buzz score with dynamic weighting
 *
 * Weighting strategy:
 * - Reddit: fixed 20% (when available)
 * - Show Score & Mezzanine: split remaining weight (80% or 100%) by sample size
 *
 * This gives more weight to sources with larger sample sizes.
 */
function calculateCombinedScore(sources) {
  const hasShowScore = sources.showScore?.score != null;
  const hasMezzanine = sources.mezzanine?.score != null;
  const hasReddit = sources.reddit?.score != null;

  // If no sources, return null
  if (!hasShowScore && !hasMezzanine && !hasReddit) {
    return { score: null, weights: null };
  }

  // Reddit gets fixed 20% if available
  const redditWeight = hasReddit ? 0.20 : 0;
  const remainingWeight = 1 - redditWeight;

  // Calculate Show Score and Mezzanine weights based on sample size
  let showScoreWeight = 0;
  let mezzanineWeight = 0;

  if (hasShowScore && hasMezzanine) {
    // Split remaining weight by sample size
    const ssCount = sources.showScore.reviewCount || 1;
    const mezzCount = sources.mezzanine.reviewCount || 1;
    const totalCount = ssCount + mezzCount;

    showScoreWeight = (ssCount / totalCount) * remainingWeight;
    mezzanineWeight = (mezzCount / totalCount) * remainingWeight;
  } else if (hasShowScore) {
    showScoreWeight = remainingWeight;
  } else if (hasMezzanine) {
    mezzanineWeight = remainingWeight;
  }

  // Calculate weighted average
  let weightedSum = 0;

  if (hasShowScore) {
    weightedSum += sources.showScore.score * showScoreWeight;
  }
  if (hasMezzanine) {
    weightedSum += sources.mezzanine.score * mezzanineWeight;
  }
  if (hasReddit) {
    weightedSum += sources.reddit.score * redditWeight;
  }

  const combined = Math.round(weightedSum);

  return {
    score: combined,
    weights: {
      showScore: Math.round(showScoreWeight * 100),
      mezzanine: Math.round(mezzanineWeight * 100),
      reddit: Math.round(redditWeight * 100),
    }
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

  // Recalculate combined score with dynamic weighting
  const sources = audienceBuzz.shows[showId].sources;
  const { score, weights } = calculateCombinedScore(sources);

  if (score !== null) {
    audienceBuzz.shows[showId].combinedScore = score;

    if (score >= 88) audienceBuzz.shows[showId].designation = 'Loving';
    else if (score >= 78) audienceBuzz.shows[showId].designation = 'Liking';
    else if (score >= 68) audienceBuzz.shows[showId].designation = 'Shrugging';
    else audienceBuzz.shows[showId].designation = 'Loathing';

    // Log the weights used
    if (verbose) {
      console.log(`  Weights: SS ${weights.showScore}%, Mezz ${weights.mezzanine}%, Reddit ${weights.reddit}%`);
    }
  }
}

/**
 * Main function
 */
async function main() {
  console.log('Reddit Buzz Scraper for Broadway Scorecard');
  console.log('Measuring audience buzz from r/Broadway discussions\n');

  if (!SCRAPINGBEE_KEY) {
    console.error('Error: SCRAPINGBEE_API_KEY environment variable must be set');
    process.exit(1);
  }

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
      const redditData = await processShow(show);
      processed++;

      if (redditData && !dryRun) {
        updateAudienceBuzz(show.id, redditData);
        successful++;

        // Save incrementally after each successful show to prevent data loss on timeout
        audienceBuzz._meta.lastUpdated = new Date().toISOString().split('T')[0];
        audienceBuzz._meta.sources = ['Show Score', 'Mezzanine', 'Reddit'];
        audienceBuzz._meta.notes = 'Dynamic weighting: Reddit fixed 20%, Show Score & Mezzanine split remaining 80% by sample size';
        fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));
        console.log(`  ✓ Saved to audience-buzz.json (${successful}/${shows.length} complete)`);
      }
    } catch (e) {
      console.error(`Error processing ${show.title}:`, e.message);
    }

    await sleep(3000);
  }

  console.log(`\nDone! Processed ${processed} shows, ${successful} with Reddit data.`);
}

main().catch(console.error);
