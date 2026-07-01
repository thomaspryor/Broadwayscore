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
const { searchAllPosts, collectCommentsFromPosts, getStats } = require('./lib/reddit-api');
const { isRoundupOrMegathread, buildAudienceSearchQueries, isRefreshStaleCandidate, refreshStaleSortKey } = require('./lib/reddit-post-filters');

// A single roundup/megathread can hold hundreds of comments about dozens of
// shows. Even after excluding such posts by title, cap how many comments any
// ONE post can contribute so no thread can dominate a show's sentiment sample.
const MAX_COMMENTS_PER_POST = 40;
const { classifyAllComments } = require('./lib/buzz-classifier');
const { calculateCombinedScore, getDesignation } = require('./lib/audience-weighting');
const { isLondonMarket } = require('./lib/venue-classification');

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
// --refresh-stale: re-scrape SCORE-ELIGIBLE shows (open/previews + closed within
// the 3yr audience-weighting window) whose stored Reddit is stale/missing. This
// closes the gap where the default/schedule selection only covers open+previews,
// so recently-closed shows keep pre-fix contaminated Reddit forever (they never
// self-heal). Scoped to the scoring window so it never touches the 700+ long-
// closed shows a blanket --all would (which blows the CI timeout). Default
// staleness threshold 45 days; override with --stale-days=N.
const refreshStale = args.includes('--refresh-stale');
const staleDaysArg = args.find(a => a.startsWith('--stale-days='));
const staleDays = staleDaysArg ? parseInt(staleDaysArg.split('=')[1], 10) : 45;

// Config — subreddits per market
const SUBREDDIT_BW = 'broadway';
const SUBREDDIT_WE = 'TheWestEnd';
// Opera shows draw richer organic discussion outside r/Broadway. r/opera and
// r/classicalmusic are the two active opera-adjacent communities; aggregating
// them with r/Broadway gets Met productions past the 50-item Reddit-only
// eligibility threshold in scripts/lib/audience-weighting.js.
const SUBREDDITS_OPERA = ['broadway', 'opera', 'classicalmusic'];
function getSubreddits(show) {
  if ((show.type || '') === 'opera') return SUBREDDITS_OPERA;
  if (isLondonMarket(show.category)) return [SUBREDDIT_WE];
  // OB shows search r/Broadway (r/OffBroadway doesn't exist)
  return [SUBREDDIT_BW];
}
const MAX_POST_AGE_DAYS = 730;  // 2 years — filters out decade-old noise
const TWO_YEARS_AGO = Date.now() / 1000 - (MAX_POST_AGE_DAYS * 86400); // Unix timestamp

// Load data
const showsPath = path.join(__dirname, '../data/shows.json');
const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');

const showsData = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const showMapById = {};
for (const s of showsData.shows) showMapById[s.id] = s;
let audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));

// Multi-production guard: Reddit searches by title, so results conflate all productions.
// Only assign data to the most recent production of each title.
const mostRecentByTitle = {};
for (const s of showsData.shows) {
  const titleBase = s.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\(.*?\)\s*$/, '').trim();
  const existing = mostRecentByTitle[titleBase];
  if (!existing || (s.openingDate || '') > (existing.openingDate || '')) {
    mostRecentByTitle[titleBase] = s;
  }
}

function isMostRecentProduction(show) {
  const titleBase = show.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\(.*?\)\s*$/, '').trim();
  const newest = mostRecentByTitle[titleBase];
  return !newest || newest.id === show.id;
}

/**
 * Calculate buzz score from classifications
 */
function calculateBuzzScore(classifications, totalPosts = 0, totalComments = 0) {
  const relevant = classifications.filter(c => c.is_relevant);
  if (relevant.length === 0) return null;

  const sentimentScores = {
    enthusiastic: 98,
    positive: 88,
    mixed: 68,
    negative: 40,
    neutral: 60
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
    totalPosts,
    totalComments,
    sentiment: {
      enthusiastic: Math.round(sentimentCounts.enthusiastic / relevant.length * 100) / 100,
      positive: Math.round(sentimentCounts.positive / relevant.length * 100) / 100,
      mixed: Math.round(sentimentCounts.mixed / relevant.length * 100) / 100,
      negative: Math.round(sentimentCounts.negative / relevant.length * 100) / 100,
      neutral: Math.round(sentimentCounts.neutral / relevant.length * 100) / 100,
    },
    positiveRate: (sentimentCounts.enthusiastic + sentimentCounts.positive) / relevant.length,
    lastUpdated: new Date().toISOString()
  };
}

/**
 * Check if a post title suggests audience reaction (not industry discussion)
 * Returns: true (definitely audience), false (definitely industry), or null (neutral - include but don't prioritize)
 */
function classifyPost(post, showTitle) {
  const rawTitle = post.title || '';
  const title = rawTitle.toLowerCase();
  const flair = (post.link_flair_text || '').toLowerCase();

  // ZEROTH: Roundup / awards / recurring-megathread posts discuss many shows at
  // once. Their comments must never be attributed to whichever show happened to
  // match the search (e.g. "Drama Desk Awards 2025" mentioning "Music City").
  // Exclude outright — overrides review flair.
  if (isRoundupOrMegathread(rawTitle)) return false;

  // FIRST: Check exclusion keywords - these override everything including flair
  // Industry keywords to EXCLUDE
  const industryKeywords = [
    'injury', 'injured', 'hurt', 'hospital', 'medical',
    'contract', 'leaving', 'departure', 'replacement',
    'backstage', 'stagehand', 'crew',
    'closing notice', 'last performance',
    'salary', 'wages', 'union', 'strike',
    'rake', 'raked stage',
  ];

  // Movie/film keywords to EXCLUDE (for shows with film adaptations)
  const movieKeywords = [
    'movie', 'film', 'screening', 'theater chain', 'cinema',
    'imax', 'dolby', 'amc', 'regal',
    'ariana grande', 'cynthia erivo',  // Movie cast (Wicked 2024)
    'jon m. chu', 'universal pictures',
    'trailer', 'teaser', 'poster reveal',
    'box office', 'opening weekend',
  ];

  for (const keyword of industryKeywords) {
    if (title.includes(keyword)) return false;
  }

  // Exclude movie/film discussions
  for (const keyword of movieKeywords) {
    if (title.includes(keyword)) return false;
  }

  // THEN: Review flair is a strong positive signal (after exclusions)
  if (flair.includes('review')) return true;

  // Audience keywords that strongly suggest reactions
  const audienceKeywords = [
    'saw', 'seen', 'watched', 'just saw',
    'review', 'thoughts', 'opinion',
    'loved', 'amazing', 'recommend',
    'disappointed', 'favorite',
  ];

  if (audienceKeywords.some(kw => title.includes(kw))) return true;

  // Neutral - not clearly industry or audience
  return null;
}

/**
 * Search with multiple strategies to capture audience reactions
 * Prioritizes audience posts, excludes industry posts, includes neutral as fallback
 */
async function searchAudiencePosts(subreddit, showTitle, maxPosts = 10000, { category = '', previewsStartDate = null, isOpera = false } = {}) {
  const cleanTitle = showTitle.replace(/[()]/g, '').trim();
  const isWestEnd = isLondonMarket(category);
  const isOffBroadway = category === 'off-broadway';
  const marketName = isWestEnd ? 'West End' : isOffBroadway ? 'Off-Broadway' : 'Broadway';

  // Only count posts from after previews start — pre-preview hype/debate is not audience reaction
  const earliestPostDate = previewsStartDate
    ? new Date(previewsStartDate).getTime() / 1000
    : null;

  // Opera titles ("Innocence", "La Traviata", "Tristan") are common words/works
  // across centuries of recordings/productions. Without anchoring to the Met,
  // r/opera and r/classicalmusic return decades of unrelated discussion (Met
  // 1985 Tristan, La Scala Traviata, etc.). Anchor every query to "Met" or
  // "Metropolitan Opera" so we get audience reactions to THIS production.
  // The bare `"<title>"` query (the contamination vector for generic /
  // collision-prone titles like "Music City"/"Mercury") is replaced by a
  // market-anchored query for every show. See reddit-post-filters.js.
  const searches = buildAudienceSearchQueries({ cleanTitle, marketName, isWestEnd, isOpera });

  const audiencePosts = [];  // Definitely audience
  const neutralPosts = [];   // Not clearly industry or audience
  const seenIds = new Set();
  let totalSearched = 0;
  let filteredByDate = 0;
  // Volume tracking: count ALL posts/comments before dedup/slicing (for display)
  let rawTotalPosts = 0;
  let rawTotalComments = 0;

  for (const query of searches) {
    if (audiencePosts.length >= maxPosts) break;

    try {
      // Fetch up to 300 per query (3 pages) to compensate for date filtering
      const posts = await searchAllPosts(subreddit, query, 300);
      totalSearched += posts.length;

      // Track raw volume before dedup (for display: "Based on ~X Reddit discussions")
      for (const post of posts) {
        rawTotalPosts++;
        rawTotalComments += (post.num_comments || 0);
      }

      for (const post of posts) {
        if (seenIds.has(post.id)) continue;
        seenIds.add(post.id);

        // Filter to last 2 years — skip decade-old noise
        if (post.created_utc && post.created_utc < TWO_YEARS_AGO) {
          filteredByDate++;
          continue;
        }

        // Filter out pre-preview posts — only audience reactions from people who could have seen it
        if (earliestPostDate && post.created_utc && post.created_utc < earliestPostDate) {
          filteredByDate++;
          continue;
        }

        const classification = classifyPost(post, showTitle);
        if (classification === true) {
          audiencePosts.push(post);
        } else if (classification === null) {
          neutralPosts.push(post);
        }
        // classification === false means industry, skip it
      }
      if (verbose) console.log(`    "${query}": ${audiencePosts.length} audience, ${neutralPosts.length} neutral (of ${totalSearched} total, ${filteredByDate} older than 2yr)`);
    } catch (e) {
      if (verbose) console.log(`    "${query}" failed: ${e.message}`);
    }
  }

  if (filteredByDate > 0) {
    console.log(`  Filtered out ${filteredByDate} posts older than 2 years`);
  }

  // Use audience posts first, then fill with neutral posts if needed
  const result = [...audiencePosts];
  if (result.length < maxPosts) {
    result.push(...neutralPosts.slice(0, maxPosts - result.length));
  }

  if (verbose && neutralPosts.length > 0 && result.length > audiencePosts.length) {
    console.log(`    Added ${result.length - audiencePosts.length} neutral posts to reach ${result.length} total`);
  }

  // Deduplicated volume counts — only posts that passed date/dedup filters
  const dedupedTotalPosts = audiencePosts.length + neutralPosts.length;
  const dedupedTotalComments = [...audiencePosts, ...neutralPosts].reduce((sum, p) => sum + (p.num_comments || 0), 0);

  return {
    posts: result.slice(0, maxPosts),
    totalPosts: dedupedTotalPosts,
    totalComments: dedupedTotalComments
  };
}

/**
 * Process a single show
 */
async function processShow(show) {
  console.log(`\nProcessing: ${show.title}`);

  // 1. Search for posts with audience-focused queries — aggregate across
  // all relevant subreddits (multi-subreddit for opera shows).
  const subreddits = getSubreddits(show);
  if (!subreddits || subreddits.length === 0) {
    console.log(`  Skipping — no relevant subreddit for ${show.category || 'unknown'} category`);
    return null;
  }
  console.log(`  Searching ${subreddits.map(s => 'r/' + s).join(' + ')} for audience reactions...`);

  let posts = [];
  let totalPosts = 0;
  let totalComments = 0;
  const seenPostIds = new Set();

  for (const subreddit of subreddits) {
    let searchResult;
    try {
      searchResult = await searchAudiencePosts(subreddit, show.title, 10000, {
        category: show.category,
        previewsStartDate: show.previewsStartDate || show.previewDate || null,
        isOpera: (show.type || '') === 'opera',
      });
    } catch (e) {
      console.error(`  Search failed in r/${subreddit}: ${e.message}`);
      continue;
    }

    // Tag each post with its source subreddit so comment-fetching uses the right URL
    for (const p of searchResult.posts) {
      if (seenPostIds.has(p.id)) continue;
      seenPostIds.add(p.id);
      p._sourceSubreddit = subreddit;
      posts.push(p);
    }
    totalPosts += searchResult.totalPosts;
    totalComments += searchResult.totalComments;
    console.log(`    r/${subreddit}: ${searchResult.posts.length} audience posts, ${searchResult.totalPosts} total unique, ${searchResult.totalComments} comments`);
  }

  console.log(`  Aggregated: ${posts.length} posts from audience-focused searches (last 2 years), ${totalPosts} total unique, ${totalComments} total comments`);

  if (posts.length === 0) {
    if (totalPosts > 0) {
      console.log(`  ⚠️  ${totalPosts} Reddit posts found but 0 survived filtering — date/classification filters may be too strict`);
    }
    return null;
  }

  // 2. Select posts - use Reddit's relevance ordering from our audience-focused searches
  // Don't re-sort by engagement (that drowns out good posts with high-engagement meta threads)
  // The LLM will filter out irrelevant comments - we just need to give it good posts to work with
  // Filter out posts with very few comments (saves API calls on comment fetching)
  const postsWithComments = posts.filter(p => (p.num_comments || 0) >= 3);
  const topPosts = postsWithComments.slice(0, 75);  // Broad enough for statistical stability

  if (verbose) {
    console.log(`  Top 5 posts (by Reddit search relevance):`);
    topPosts.slice(0, 5).forEach((p, i) => {
      console.log(`    ${i+1}. "${p.title.slice(0, 50)}..." (${p.num_comments} comments)`);
    });
  }

  console.log(`  Collecting comments from top ${topPosts.length} posts...`);

  // Group posts by their source subreddit for batched comment fetching.
  const postsBySubreddit = new Map();
  for (const p of topPosts) {
    const sr = p._sourceSubreddit || subreddits[0];
    if (!postsBySubreddit.has(sr)) postsBySubreddit.set(sr, []);
    postsBySubreddit.get(sr).push(p);
  }

  let comments = [];
  for (const [sr, srPosts] of postsBySubreddit) {
    try {
      const srComments = await collectCommentsFromPosts(sr, srPosts, 10000, MAX_COMMENTS_PER_POST);
      comments.push(...srComments);
    } catch (e) {
      console.error(`  Comment collection failed in r/${sr}: ${e.message}`);
    }
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
    classifications = await classifyAllComments(show.title, filtered, 150);
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

  const scoreData = calculateBuzzScore(classifications, totalPosts, totalComments);
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

// calculateCombinedScore imported from ./lib/audience-weighting.js

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
  const sd = showMapById[showId];
  const showInfo = sd ? { closingDate: sd.closingDate, status: sd.status, category: sd.category } : undefined;
  const { score, weights } = calculateCombinedScore(sources, showInfo);

  if (score !== null) {
    audienceBuzz.shows[showId].combinedScore = score;

    audienceBuzz.shows[showId].designation = getDesignation(score);

    if (verbose) {
      console.log(`  Weights: SS ${weights.showScore}%, Mezz ${weights.mezzanine}%, Reddit ${weights.reddit}%, Theatr ${weights.theatr}%`);
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

  audienceBuzz._meta.lastUpdated = new Date().toISOString();
  audienceBuzz._meta.sources = ['Show Score', 'Mezzanine', 'Reddit'];
  audienceBuzz._meta.notes = 'Proportional weighting by reviewCount volume (max 80% single source)';

  fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));
  return true;
}

/**
 * Main function
 */
async function main() {
  console.log('Reddit Buzz Scraper v2 for Broadway Scorecard');

  // Determine classifier provider
  let classifierName = 'unknown';
  if (process.env.OPENROUTER_API_KEY) classifierName = 'Kimi K2.5 (via OpenRouter)';
  else if (process.env.GEMINI_API_KEY) classifierName = 'Gemini Flash';
  else if (process.env.OPENAI_API_KEY) classifierName = 'GPT-4o-mini';
  else if (process.env.ANTHROPIC_API_KEY) classifierName = 'Claude Sonnet';

  console.log(`Using: Reddit API (free) + ${classifierName}\n`);

  // Check for API keys
  if (!process.env.OPENROUTER_API_KEY && !process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.error('Error: At least one of OPENROUTER_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY must be set');
    process.exit(1);
  }

  // All active shows (open + previews + closed)
  const allActiveShows = showsData.shows.filter(s => s.status === 'open' || s.status === 'previews' || s.status === 'closed');
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
  } else if (refreshStale) {
    // Score-window shows: open/previews, or closed within the 3yr Reddit-
    // eligibility window (mirrors audience-weighting.js isRedditEligible's
    // closed<now-3yr gate). Long-closed shows are excluded — their Reddit no
    // longer affects any live score, so refreshing them is wasted budget.
    const closedWindowCutoff = new Date();
    closedWindowCutoff.setFullYear(closedWindowCutoff.getFullYear() - 3);
    const staleBefore = new Date(Date.now() - staleDays * 24 * 60 * 60 * 1000);
    shows = allActiveShows.filter(s =>
      isRefreshStaleCandidate(s, (audienceBuzz.shows || {})[s.id], { staleBefore, closedWindowCutoff }));
    console.log(`refresh-stale: ${shows.length} score-eligible shows with Reddit older than ${staleDays}d (or missing)`);
  } else if (showsArg === 'missing') {
    const base = includeAll ? allActiveShows : showsData.shows.filter(s => s.status === 'open' || s.status === 'previews');
    shows = base.filter(s => {
      const b = (audienceBuzz.shows || {})[s.id];
      return !(b && b.sources && b.sources.reddit);
    });
    console.log(`Found ${shows.length} shows missing Reddit sentiment data${includeAll ? ' (all statuses)' : ' (open + previews only)'}`);
  } else {
    // Default: open + preview shows. Use --all to include closed shows.
    shows = includeAll ? allActiveShows : showsData.shows.filter(s => s.status === 'open' || s.status === 'previews');
    if (!includeAll) {
      console.log(`Processing open + preview shows (${shows.length}). Use --all for all shows.`);
    }
  }

  if (refreshStale) {
    // Drain oldest/missing Reddit first so a bounded --limit run always attacks
    // the most-stale (and pre-fix contaminated) records first. Successive runs
    // chip through the backlog.
    shows.sort((a, b) =>
      refreshStaleSortKey((audienceBuzz.shows || {})[a.id]) - refreshStaleSortKey((audienceBuzz.shows || {})[b.id]));
  } else {
    // Sort: open first, then by opening date (recent first)
    shows.sort((a, b) => {
      if (a.status === 'open' && b.status !== 'open') return -1;
      if (b.status === 'open' && a.status !== 'open') return 1;
      return new Date(b.openingDate || 0) - new Date(a.openingDate || 0);
    });
  }

  // Multi-production guard: Reddit searches by title, so only process the most
  // recent production of each title (avoids duplicate/conflated data)
  if (includeAll || refreshStale) {
    const beforeCount = shows.length;
    shows = shows.filter(s => isMostRecentProduction(s));
    const skipped = beforeCount - shows.length;
    if (skipped > 0) console.log(`Filtered ${skipped} older productions (kept most recent per title)`);
  }

  // Apply skip (for continuation after timeout)
  if (skipCount > 0) {
    shows = shows.slice(skipCount);
    console.log(`Skipping first ${skipCount} shows, ${shows.length} remaining`);
  }

  // Apply limit
  if (showLimit) {
    shows = shows.slice(0, showLimit);
  }

  // Shard partitioning. refresh-stale keeps its oldest-first order (a stable
  // deterministic id sort would still partition correctly, but re-sorting by id
  // would silently discard the "attack most-stale first" intent).
  if (shardMode) {
    if (!refreshStale) shows.sort((a, b) => a.id.localeCompare(b.id));
    const totalBefore = shows.length;
    shows = shows.filter((_, i) => i % totalShards === shard);
    console.log(`Shard ${shard}/${totalShards}: ${shows.length} shows (of ${totalBefore} total)`);
  }

  console.log(`Processing ${shows.length} shows...\n`);

  // In shard mode, write to separate shard file
  let shardResults = {};
  const shardDir = path.join(__dirname, '../data/reddit-shards');
  const shardOutputPath = shardMode ? path.join(shardDir, `shard-${shard}.json`) : null;
  if (shardMode) {
    fs.mkdirSync(shardDir, { recursive: true });
    // Load existing shard data so progress survives restarts
    if (fs.existsSync(shardOutputPath)) {
      try {
        shardResults = JSON.parse(fs.readFileSync(shardOutputPath, 'utf8'));
        console.log(`  Loaded existing shard data (${Object.keys(shardResults).length} shows)`);
      } catch (e) {
        console.warn(`  Could not load existing shard data: ${e.message}`);
      }
    }
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
      } else if (refreshStale && !dryRun && !shardMode && !redditData) {
        // No Reddit data this run (no qualifying posts / below MIN items). Stamp an
        // attempt marker so the oldest-first --refresh-stale drain doesn't re-select
        // this no-signal show on EVERY run and stall behind it (a bounded --limit run
        // would otherwise churn the same shows forever, never reaching the real
        // stale backlog). Ages out for staleDays like a real scrape, then retries.
        audienceBuzz.shows[show.id] = audienceBuzz.shows[show.id] || { sources: {} };
        audienceBuzz.shows[show.id].redditLastAttempted = new Date().toISOString();
        if (saveAudienceBuzz()) {
          console.log(`  No Reddit data — marked attempted (${processed}/${shows.length})`);
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

  // Print session stats
  const sessionStats = getStats();
  console.log(`\nDone! Processed ${processed} shows, ${successful} with Reddit data.`);
  console.log(`\nSession stats:`);
  console.log(`  Reddit direct requests: ${sessionStats.redditDirect}`);
  console.log(`  Bright Data requests: ${sessionStats.brightData}`);
  console.log(`  ScrapingBee requests: ${sessionStats.scrapingBee}`);
  console.log(`  Rate limits hit: ${sessionStats.rateLimits}`);
  console.log(`  Backoff retries: ${sessionStats.backoffRetries}`);
  console.log(`  Errors: ${sessionStats.errors}`);
  if (sessionStats.usingScrapingBee) {
    console.log(`  (ended on proxy fallback)`);
  }
  if (sessionStats.circuitBroken) {
    console.error(`\n⚠ Circuit breaker tripped after ${sessionStats.consecutiveFailures} consecutive failures.`);
    console.error('All Reddit data sources were unavailable. Exiting with error so retry cron fires.');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
