#!/usr/bin/env node

/**
 * Reddit Buzz Scraper for Broadway Scorecard (v2 - Refactored)
 *
 * Captures audience "buzz" from r/Broadway - opinions, reactions, and recommendations.
 *
 * Uses:
 * - Free Reddit API (with ScrapingBee fallback if blocked)
 * - Gemini Flash for classification (cheap, with GPT/Claude fallback)
 * - Per-show checkpointing for reliability
 *
 * Environment variables:
 *   GEMINI_API_KEY - Primary classifier (cheap)
 *   OPENAI_API_KEY - Fallback classifier
 *   ANTHROPIC_API_KEY - Final fallback classifier
 *   SCRAPINGBEE_API_KEY - Fallback for Reddit API if blocked
 *
 * Usage:
 *   node scripts/scrape-reddit-sentiment.js [options]
 *
 * Flags:
 *   --show=ID       Process a single show by ID or slug
 *   --shows=X,Y     Process comma-separated show IDs, or "missing" for shows without Reddit data
 *   --all           Include closed shows (default: open shows only)
 *   --dry-run       Don't write results
 *   --limit=N       Process at most N shows
 *   --skip=N        Skip first N shows (for continuation after timeout)
 *   --verbose       Extra logging
 *   --shard=N --total-shards=M   Parallel shard mode
 */

const fs = require('fs');
const path = require('path');
const { searchAllPosts, collectCommentsFromPosts } = require('./lib/reddit-api');
const { classifyAllComments } = require('./lib/buzz-classifier');

// Parse command line args
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const showsArg = args.find(a => a.startsWith('--shows='))?.split('=')[1];
const dryRun = args.includes('--dry-run');
const verbose = args.includes('--verbose');
const includeAll = args.includes('--all');
const limitArg = args.find(a => a.startsWith('--limit='));
const showLimit = limitArg ? parseInt(limitArg.split('=')[1]) : null;
const skipArg = args.find(a => a.startsWith('--skip='));
const skipCount = skipArg ? parseInt(skipArg.split('=')[1]) : 0;
const shardArg = args.find(a => a.startsWith('--shard='));
const totalShardsArg = args.find(a => a.startsWith('--total-shards='));
const shard = shardArg ? parseInt(shardArg.split('=')[1]) : null;
const totalShards = totalShardsArg ? parseInt(totalShardsArg.split('=')[1]) : null;
const shardMode = shard !== null && totalShards !== null;

// Config
const SUBREDDIT = 'broadway';
const MIN_ITEMS_FOR_SCORE = 15; // Minimum buzz items to include in combined score

// Load data
const showsPath = path.join(__dirname, '../data/shows.json');
const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');

const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
let audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));

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
    if (sentimentCounts[sentiment] !== undefined) {
      sentimentCounts[sentiment]++;
    }
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

  // Enthusiasm bonus (up to +5 points)
  const enthusiasmRate = sentimentCounts.enthusiastic / relevant.length;
  const enthusiasmBonus = Math.min(5, enthusiasmRate * 15);

  // Calculate final score
  const finalScore = Math.min(99, Math.round(baseScore + enthusiasmBonus));

  return {
    score: finalScore,
    reviewCount: relevant.length,
    sentiment: {
      enthusiastic: Math.round(sentimentCounts.enthusiastic / relevant.length * 100) / 100,
      positive: Math.round(sentimentCounts.positive / relevant.length * 100) / 100,
      mixed: Math.round(sentimentCounts.mixed / relevant.length * 100) / 100,
      negative: Math.round(sentimentCounts.negative / relevant.length * 100) / 100,
    },
    positiveRate: (sentimentCounts.enthusiastic + sentimentCounts.positive) / relevant.length,
    lastUpdated: new Date().toISOString().split('T')[0]
  };
}

/**
 * Search with multiple strategies to capture audience reactions
 * Prioritizes posts about seeing/experiencing the show over industry discussion
 */
async function searchAudiencePosts(subreddit, showTitle, maxPosts = 100) {
  const cleanTitle = showTitle.replace(/[()]/g, '').trim();

  // Audience-focused search strategies (ordered by relevance)
  const searches = [
    `flair:Review "${cleanTitle}"`,  // Review-tagged posts (highest signal)
    `"${cleanTitle}" saw`,           // "I saw Wicked"
    `"${cleanTitle}" loved`,         // Positive reactions
    `"${cleanTitle}" amazing`,       // Enthusiasm
    `"${cleanTitle}" recommend`,     // Recommendations
    `"${cleanTitle}" review`,        // Reviews
    `"${cleanTitle}" favorite`,      // Favorites
    `"${cleanTitle}" disappointed`,  // Negative reactions (still audience)
    `"${cleanTitle}"`,               // Fallback: basic search
  ];

  const allPosts = [];
  const seenIds = new Set();

  for (const query of searches) {
    if (allPosts.length >= maxPosts) break;

    try {
      const posts = await searchAllPosts(subreddit, query, 50);
      for (const post of posts) {
        if (!seenIds.has(post.id)) {
          seenIds.add(post.id);
          allPosts.push(post);
        }
      }
      if (verbose) console.log(`    "${query}": +${posts.length} posts (total: ${allPosts.length})`);
    } catch (e) {
      if (verbose) console.log(`    "${query}" failed: ${e.message}`);
    }
  }

  return allPosts.slice(0, maxPosts);
}

/**
 * Process a single show
 */
async function processShow(show) {
  console.log(`\nProcessing: ${show.title}`);

  // 1. Search for posts with audience-focused queries
  console.log(`  Searching r/${SUBREDDIT} for audience reactions...`);

  let posts;
  try {
    posts = await searchAudiencePosts(SUBREDDIT, show.title, 100);
  } catch (e) {
    console.error(`  Search failed: ${e.message}`);
    return null;
  }

  console.log(`  Found ${posts.length} posts from audience-focused searches`);

  if (posts.length === 0) {
    return null;
  }

  // 2. Collect comments from top posts (by engagement)
  const topPosts = posts
    .sort((a, b) => (b.score + b.num_comments) - (a.score + a.num_comments))
    .slice(0, 30);

  console.log(`  Collecting comments from top ${topPosts.length} posts...`);

  let comments;
  try {
    comments = await collectCommentsFromPosts(SUBREDDIT, topPosts, 500);
  } catch (e) {
    console.error(`  Comment collection failed: ${e.message}`);
    return null;
  }

  console.log(`  Collected ${comments.length} comments`);

  // 3. Filter comments (remove deleted, short, and bot messages)
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
  console.log(`  After filtering: ${filtered.length} comments`);

  if (filtered.length === 0) {
    return null;
  }

  // 4. Classify comments
  console.log(`  Classifying with LLM...`);

  let classifications;
  try {
    classifications = await classifyAllComments(show.title, filtered, 50);
  } catch (e) {
    console.error(`  Classification failed: ${e.message}`);
    return null;
  }

  // 5. Calculate score
  const relevant = classifications.filter(c => c.is_relevant);
  console.log(`  ${relevant.length} relevant buzz items (of ${classifications.length} classified)`);

  if (relevant.length === 0) {
    return null;
  }

  const scoreData = calculateBuzzScore(classifications);
  if (!scoreData) {
    return null;
  }

  // Log results
  const enthusiasticPct = Math.round(scoreData.sentiment.enthusiastic * 100);
  const positivePct = Math.round(scoreData.sentiment.positive * 100);
  const mixedPct = Math.round(scoreData.sentiment.mixed * 100);
  const negativePct = Math.round(scoreData.sentiment.negative * 100);

  console.log(`  Buzz Score: ${scoreData.score}`);
  console.log(`  Sentiment: ${enthusiasticPct}% enthusiastic, ${positivePct}% positive, ${mixedPct}% mixed, ${negativePct}% negative`);
  console.log(`  Positive Rate: ${Math.round(scoreData.positiveRate * 100)}%`);

  // Show samples if verbose
  if (verbose && relevant.length > 0) {
    console.log(`  Sample buzz:`);
    for (const sample of relevant.slice(0, 5)) {
      const preview = sample.comment.body.replace(/\n/g, ' ').slice(0, 60);
      console.log(`    [${sample.sentiment}] "${preview}..."`);
    }
  }

  return scoreData;
}

/**
 * Calculate combined Audience Buzz score with dynamic weighting
 */
function calculateCombinedScore(sources) {
  const hasShowScore = sources.showScore?.score != null;
  const hasMezzanine = sources.mezzanine?.score != null;
  const hasReddit = sources.reddit?.score != null &&
                   sources.reddit?.reviewCount >= MIN_ITEMS_FOR_SCORE;

  // If no sources, return null
  if (!hasShowScore && !hasMezzanine && !hasReddit) {
    return { score: null, weights: null };
  }

  // When only Reddit exists and has enough data, give it 100% weight
  if (!hasShowScore && !hasMezzanine && hasReddit) {
    return {
      score: Math.round(sources.reddit.score),
      weights: { showScore: 0, mezzanine: 0, reddit: 100 }
    };
  }

  // Reddit gets fixed 20% if available AND has enough items
  const redditWeight = hasReddit ? 0.20 : 0;
  const remainingWeight = 1 - redditWeight;

  // Calculate Show Score and Mezzanine weights based on sample size
  let showScoreWeight = 0;
  let mezzanineWeight = 0;

  if (hasShowScore && hasMezzanine) {
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

  return {
    score: Math.round(weightedSum),
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
    console.log(`  Creating entry for ${showId} in audience-buzz.json`);
    audienceBuzz.shows[showId] = {
      sources: {}
    };
  }

  audienceBuzz.shows[showId].sources.reddit = redditData;

  // Recalculate combined score
  const sources = audienceBuzz.shows[showId].sources;
  const { score, weights } = calculateCombinedScore(sources);

  if (score !== null) {
    audienceBuzz.shows[showId].combinedScore = score;

    // Set designation based on score
    if (score >= 88) audienceBuzz.shows[showId].designation = 'Loving';
    else if (score >= 78) audienceBuzz.shows[showId].designation = 'Liking';
    else if (score >= 68) audienceBuzz.shows[showId].designation = 'Shrugging';
    else audienceBuzz.shows[showId].designation = 'Loathing';

    if (verbose) {
      console.log(`  Weights: SS ${weights.showScore}%, Mezz ${weights.mezzanine}%, Reddit ${weights.reddit}%`);
    }
  }
}

/**
 * Save audience-buzz.json (with validation)
 */
function saveAudienceBuzz() {
  // Validate before saving
  let errors = 0;
  for (const [id, show] of Object.entries(audienceBuzz.shows)) {
    if (show.combinedScore !== null && show.combinedScore !== undefined) {
      if (isNaN(show.combinedScore) || show.combinedScore < 0 || show.combinedScore > 100) {
        console.error(`  Invalid score for ${id}: ${show.combinedScore}`);
        errors++;
      }
    }
  }

  if (errors > 0) {
    console.error(`  VALIDATION FAILED: ${errors} invalid scores. Not saving.`);
    return false;
  }

  audienceBuzz._meta.lastUpdated = new Date().toISOString().split('T')[0];
  audienceBuzz._meta.sources = ['Show Score', 'Mezzanine', 'Reddit'];
  audienceBuzz._meta.notes = 'Dynamic weighting: Reddit fixed 20% (when >=15 items), Show Score & Mezzanine split remaining by sample size';

  fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));
  return true;
}

/**
 * Main function
 */
async function main() {
  console.log('Reddit Buzz Scraper v2 for Broadway Scorecard');
  console.log('Using: Reddit API (free) + Gemini Flash (cheap)\n');

  // Check for API keys
  if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error('Error: At least one of GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY must be set');
    process.exit(1);
  }

  // All active shows (open + closed, excludes previews)
  const allActiveShows = showsData.shows.filter(s => s.status === 'open' || s.status === 'closed');
  let shows;

  // Explicit show selection
  if (showFilter) {
    shows = allActiveShows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (shows.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
  } else if (showsArg && showsArg !== 'missing') {
    const showIds = showsArg.split(',').map(s => s.trim()).filter(Boolean);
    shows = allActiveShows.filter(s => showIds.includes(s.id) || showIds.includes(s.slug));
    if (shows.length === 0) {
      console.error(`No shows found matching: ${showsArg}`);
      process.exit(1);
    }
    console.log(`Processing specific shows: ${shows.map(s => s.title).join(', ')}`);
  } else if (showsArg === 'missing') {
    const base = includeAll ? allActiveShows : showsData.shows.filter(s => s.status === 'open');
    shows = base.filter(s => {
      const b = (audienceBuzz.shows || {})[s.id];
      return !(b && b.sources && b.sources.reddit);
    });
    console.log(`Found ${shows.length} shows missing Reddit sentiment data${includeAll ? ' (all statuses)' : ' (open only)'}`);
  } else {
    // Default: open shows only. Use --all to include closed shows.
    shows = includeAll ? allActiveShows : showsData.shows.filter(s => s.status === 'open');
    if (!includeAll) {
      console.log(`Processing open shows only (${shows.length}). Use --all for all shows.`);
    }
  }

  // Sort: open first, then by opening date (recent first)
  shows.sort((a, b) => {
    if (a.status === 'open' && b.status !== 'open') return -1;
    if (b.status === 'open' && a.status !== 'open') return 1;
    return new Date(b.openingDate || 0) - new Date(a.openingDate || 0);
  });

  // Apply skip (for continuation after timeout)
  if (skipCount > 0) {
    shows = shows.slice(skipCount);
    console.log(`Skipping first ${skipCount} shows, ${shows.length} remaining`);
  }

  // Apply limit
  if (showLimit) {
    shows = shows.slice(0, showLimit);
  }

  // Shard partitioning
  if (shardMode) {
    shows.sort((a, b) => a.id.localeCompare(b.id));
    const totalBefore = shows.length;
    shows = shows.filter((_, i) => i % totalShards === shard);
    console.log(`Shard ${shard}/${totalShards}: ${shows.length} shows (of ${totalBefore} total)`);
  }

  console.log(`Processing ${shows.length} shows...\n`);

  // In shard mode, write to separate shard file
  const shardResults = {};
  const shardDir = path.join(__dirname, '../data/reddit-shards');
  const shardOutputPath = shardMode ? path.join(shardDir, `shard-${shard}.json`) : null;
  if (shardMode) {
    fs.mkdirSync(shardDir, { recursive: true });
  }

  let processed = 0;
  let successful = 0;

  for (const show of shows) {
    try {
      const redditData = await processShow(show);
      processed++;

      if (redditData && !dryRun) {
        successful++;

        if (shardMode) {
          // Shard mode: write to separate file
          shardResults[show.id] = redditData;
          fs.writeFileSync(shardOutputPath, JSON.stringify(shardResults, null, 2));
          console.log(`  Saved to shard-${shard}.json (${successful}/${shows.length} complete)`);
        } else {
          // Direct mode: update and save after EACH show (checkpoint)
          updateAudienceBuzz(show.id, redditData);
          if (saveAudienceBuzz()) {
            console.log(`  Saved to audience-buzz.json (${successful}/${shows.length} complete)`);
          }
        }
      }
    } catch (e) {
      console.error(`Error processing ${show.title}:`, e.message);
      if (verbose) console.error(e.stack);
    }
  }

  // Validation guard for full runs
  if (!showFilter && !showsArg && !shardMode && shows.length > 5) {
    const successRate = processed > 0 ? successful / processed : 0;
    if (successRate < 0.3) {
      console.error(`\nWARN: Only ${Math.round(successRate * 100)}% success rate (${successful}/${processed}). Possible scraper issue.`);
      if (successful === 0) {
        console.error('ABORT: Zero shows scored. Not writing results to avoid data loss.');
        process.exit(1);
      }
    }
  }

  console.log(`\nDone! Processed ${processed} shows, ${successful} with Reddit data.`);
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
