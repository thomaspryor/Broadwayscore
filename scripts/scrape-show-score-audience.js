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
const includeAll = args.includes('--all');
const shardArg = args.find(a => a.startsWith('--shard='));
const totalShardsArg = args.find(a => a.startsWith('--total-shards='));
const shard = shardArg ? parseInt(shardArg.split('=')[1]) : null;
const totalShards = totalShardsArg ? parseInt(totalShardsArg.split('=')[1]) : null;
const shardMode = shard !== null && totalShards !== null;

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

// Max new URL discoveries per run to avoid rate-limit avalanche
// In shard mode (bulk backfill), raise cap significantly
const MAX_DISCOVERIES = shardMode ? 100 : 10;
// Cooldown before retrying discovery for a show (7 days, disabled in shard mode)
const DISCOVERY_COOLDOWN_MS = shardMode ? 0 : 7 * 24 * 60 * 60 * 1000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Fetch URL through ScrapingBee (single attempt)
 */
function fetchViaScrapingBeeSingle(url) {
  return new Promise((resolve, reject) => {
    if (!SCRAPINGBEE_KEY) {
      reject(new Error('SCRAPINGBEE_API_KEY must be set'));
      return;
    }

    const apiUrl = `https://app.scrapingbee.com/api/v1/?api_key=${SCRAPINGBEE_KEY}&url=${encodeURIComponent(url)}&render_js=true&premium_proxy=true&wait=3000`;

    https.get(apiUrl, { timeout: 60000 }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        }
      });
    }).on('error', reject)
      .on('timeout', () => reject(new Error('Request timeout')));
  });
}

/**
 * Fetch URL through ScrapingBee with retry logic
 */
async function fetchViaScrapingBee(url, retries = 2) {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fetchViaScrapingBeeSingle(url);
    } catch (error) {
      if (attempt > retries) throw error;
      const delay = 5000 * attempt;
      if (verbose) console.log(`  Retry ${attempt}/${retries} in ${delay / 1000}s: ${error.message}`);
      await sleep(delay);
    }
  }
}

/**
 * Slugify a show title for Show Score URL patterns
 */
function slugifyTitle(title) {
  return title
    .toLowerCase()
    .replace(/&/g, '')           // Drop ampersand
    .replace(/['']/g, '-')       // Apostrophes → hyphen
    .replace(/[:.!?,()]/g, '')   // Drop punctuation
    .replace(/\s+/g, '-')        // Spaces → hyphens
    .replace(/-+/g, '-')         // Collapse multiple hyphens
    .replace(/^-|-$/g, '');      // Trim leading/trailing hyphens
}

/**
 * Generate candidate Show Score URLs for a show
 */
function generateCandidateUrls(show) {
  const titleSlug = slugifyTitle(show.title);
  const titleNoColon = show.title.replace(/:.*$/, '').trim();
  const titleNoColonSlug = slugifyTitle(titleNoColon);
  const showSlug = (show.slug || show.id).replace(/-\d{4}$/, '');
  const isMusical = show.type === 'musical' ||
    (show.tags && show.tags.some(t => /musical/i.test(t)));

  const candidates = [
    `${titleSlug}-broadway`,
    `${titleNoColonSlug}-broadway`,
    `${showSlug}-broadway`,
  ];

  if (isMusical) {
    candidates.push(
      `${titleSlug}-the-musical-broadway`,
      `${titleNoColonSlug}-the-musical-broadway`,
    );
  }

  candidates.push(titleSlug, showSlug);

  // Deduplicate while preserving order
  return [...new Set(candidates)].map(
    slug => `https://www.show-score.com/broadway-shows/${slug}`
  );
}

/**
 * Validate that HTML is a valid Show Score Broadway show page with audience data
 */
function isValidShowScorePage(html, url) {
  if (!html) return false;
  // Not a 404
  if (html.includes('Page not found') || html.includes('404 -')) return false;
  // Not the homepage
  if (html.includes('<title>Show Score | NYC Theatre Reviews and Tickets</title>')) return false;
  // Not off-broadway
  if (url.includes('/off-broadway-shows/') || url.includes('/off-off-broadway-shows/')) return false;
  if (html.includes('/off-broadway-shows/') && !html.includes('/broadway-shows/')) return false;
  // Must have JSON-LD with numeric aggregateRating
  const jsonLdMatch = html.match(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi);
  if (jsonLdMatch) {
    for (const match of jsonLdMatch) {
      try {
        const content = match.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
        const data = JSON.parse(content);
        if (data.aggregateRating && typeof data.aggregateRating.ratingValue === 'number') {
          return true;
        }
      } catch (e) { /* skip */ }
    }
  }
  return false;
}

/**
 * Discover Show Score URL for a show by trying candidate patterns
 */
async function discoverShowScoreUrl(show) {
  const candidates = generateCandidateUrls(show);
  if (verbose) console.log(`  Trying ${candidates.length} URL patterns...`);

  for (const url of candidates) {
    try {
      if (verbose) console.log(`  Trying: ${url}`);
      const html = await fetchViaScrapingBee(url, 0); // No retries during discovery
      if (isValidShowScorePage(html, url)) {
        console.log(`  ✓ Discovered: ${url}`);
        return url;
      }
    } catch (error) {
      if (verbose) console.log(`    ${error.message}`);
    }
    await sleep(2000); // Rate limit between discovery attempts
  }
  return null;
}

/**
 * Save URL cache to disk (incremental persist)
 */
function saveUrlCache() {
  urlData._meta.lastUpdated = new Date().toISOString().split('T')[0];
  fs.writeFileSync(urlsPath, JSON.stringify(urlData, null, 2) + '\n');
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
 * Get cached Show Score URL for a show (cache-only, no discovery)
 */
function getCachedUrl(showId) {
  if (urlData.shows && urlData.shows[showId]) {
    return urlData.shows[showId];
  }
  return null;
}

/**
 * Process a single show (cache-only — URL must already be in show-score-urls.json)
 */
async function processShow(show) {
  const url = getCachedUrl(show.id);
  if (!url) {
    if (verbose) console.log(`\n  SKIP: ${show.title} — no cached URL`);
    return null;
  }

  console.log(`\nProcessing: ${show.title}`);
  console.log(`  URL: ${url}`);

  try {
    const html = await fetchViaScrapingBee(url);

    // Validate page
    if (!html || html.includes('Page not found') || html.includes('404 -')) {
      console.log(`  SKIP: Show not found on Show Score`);
      return null;
    }

    if (!html.includes('show-score.com') && !html.includes('Show Score')) {
      console.log(`  SKIP: Page doesn't appear to be Show Score`);
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

  // When only Reddit exists, give it 100% weight (not 20%)
  if (!hasShowScore && !hasMezzanine && hasReddit) {
    return {
      score: Math.round(sources.reddit.score),
      weights: { showScore: 0, mezzanine: 0, reddit: 100 }
    };
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
  console.log('Show Score Audience Data Scraper');
  console.log('================================\n');

  if (!SCRAPINGBEE_KEY) {
    console.error('Error: SCRAPINGBEE_API_KEY environment variable must be set');
    process.exit(1);
  }

  // Get shows to process — open shows only by default, --all includes closed
  const allActiveShows = showsData.shows.filter(s => s.status === 'open' || s.status === 'closed');
  let shows = includeAll ? allActiveShows : showsData.shows.filter(s => s.status === 'open');

  // Handle single show filter (can target any status)
  if (showFilter) {
    shows = allActiveShows.filter(s => s.id === showFilter || s.slug === showFilter);
    if (shows.length === 0) {
      console.error(`Show not found: ${showFilter}`);
      process.exit(1);
    }
  } else if (showsArg) {
    // Handle multiple shows (comma-separated) or special keywords
    if (showsArg === 'missing') {
      // Filter to shows without Show Score data
      const base = includeAll ? allActiveShows : showsData.shows.filter(s => s.status === 'open');
      shows = base.filter(s => {
        const b = (audienceBuzz.shows || {})[s.id];
        return !b || !b.sources || !b.sources.showScore;
      });
      console.log(`Found ${shows.length} shows missing Show Score data${includeAll ? ' (all statuses)' : ' (open only)'}`);
    } else {
      const showIds = showsArg.split(',').map(s => s.trim()).filter(Boolean);
      shows = allActiveShows.filter(s => showIds.includes(s.id) || showIds.includes(s.slug));
      if (shows.length === 0) {
        console.error(`No shows found matching: ${showsArg}`);
        process.exit(1);
      }
      console.log(`Processing specific shows: ${shows.map(s => s.title).join(', ')}`);
    }
  } else if (!includeAll) {
    console.log(`Processing open shows only (${shows.length}). Use --all for all shows.`);
  }

  // Shard mode: partition shows across parallel workers
  if (shardMode) {
    shows = shows.filter((_, i) => i % totalShards === shard);
    console.log(`Shard ${shard}/${totalShards}: processing ${shows.length} shows`);
  }

  // Initialize shard output for incremental writing (survives timeout/crash)
  let shardOutput = null;
  let shardPath = null;
  if (shardMode && !dryRun) {
    const shardDir = path.join(__dirname, '../data/show-score-shards');
    if (!fs.existsSync(shardDir)) fs.mkdirSync(shardDir, { recursive: true });
    shardOutput = { discoveredUrls: {}, scores: {} };
    shardPath = path.join(shardDir, `shard-${shard}.json`);
  }

  if (showLimit) {
    shows = shows.slice(0, showLimit);
  }

  // ── Phase A: Discovery pass (uncached shows only, capped) ──
  const uncachedShows = shows.filter(s => !getCachedUrl(s.id));
  if (uncachedShows.length > 0) {
    // Filter out shows we attempted recently
    const now = Date.now();
    const discoveryTargets = uncachedShows.filter(s => {
      const meta = urlData._discoveryAttempts && urlData._discoveryAttempts[s.id];
      if (!meta) return true;
      return (now - new Date(meta).getTime()) > DISCOVERY_COOLDOWN_MS;
    }).slice(0, MAX_DISCOVERIES);

    if (discoveryTargets.length > 0) {
      console.log(`\n── Discovery Phase: ${discoveryTargets.length} uncached shows (max ${MAX_DISCOVERIES}) ──\n`);

      for (const show of discoveryTargets) {
        console.log(`Discovering: ${show.title} (${show.id})`);
        const url = await discoverShowScoreUrl(show);

        // Track attempt timestamp
        if (!urlData._discoveryAttempts) urlData._discoveryAttempts = {};
        urlData._discoveryAttempts[show.id] = new Date().toISOString();

        if (url) {
          // Cache immediately
          if (!urlData.shows) urlData.shows = {};
          urlData.shows[show.id] = url;
          if (!dryRun) saveUrlCache();
          // Update shard incrementally
          if (shardOutput) {
            shardOutput.discoveredUrls[show.id] = url;
            fs.writeFileSync(shardPath, JSON.stringify(shardOutput, null, 2));
          }
          console.log(`  ✓ Cached URL for ${show.id}`);
        } else {
          console.log(`  ✗ No Show Score page found for ${show.title}`);
          if (!dryRun) saveUrlCache(); // Save attempt timestamp
        }

        await sleep(3000);
      }
      console.log('');
    } else if (uncachedShows.length > 0) {
      console.log(`\n${uncachedShows.length} uncached shows skipped (discovery cooldown)\n`);
    }
  }

  // ── Phase B: Score scraping (cached URLs only) ──
  const showsWithUrls = shows.filter(s => getCachedUrl(s.id));
  console.log(`Processing ${showsWithUrls.length} shows with cached URLs...\n`);

  // Snapshot existing scores for guard comparison
  const previousScores = {};
  let previousScoredCount = 0;
  for (const show of showsWithUrls) {
    const existing = audienceBuzz.shows && audienceBuzz.shows[show.id];
    if (existing && existing.sources && existing.sources.showScore && existing.sources.showScore.score != null) {
      previousScores[show.id] = existing.sources.showScore.score;
      previousScoredCount++;
    }
  }

  let processed = 0;
  let successful = 0;
  const scoreDrops = [];

  for (const show of showsWithUrls) {
    try {
      const data = await processShow(show);
      processed++;

      if (data) {
        // Check for score drops
        if (previousScores[show.id] != null && data.score == null) {
          scoreDrops.push(show.id);
        }

        if (!dryRun) {
          updateAudienceBuzz(show.id, show.title, data);
          successful++;

          // Save incrementally after each successful show
          audienceBuzz._meta.lastUpdated = new Date().toISOString().split('T')[0];
          audienceBuzz._meta.sources = ['Show Score', 'Mezzanine', 'Reddit'];
          audienceBuzz._meta.notes = 'Dynamic weighting: Reddit fixed 20%, Show Score & Mezzanine split remaining 80% by sample size';
          fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));
          // Update shard incrementally (survives timeout)
          if (shardOutput) {
            const entry = audienceBuzz.shows && audienceBuzz.shows[show.id];
            if (entry && entry.sources && entry.sources.showScore) {
              shardOutput.scores[show.id] = entry.sources.showScore;
            }
            const cachedUrl = getCachedUrl(show.id);
            if (cachedUrl) shardOutput.discoveredUrls[show.id] = cachedUrl;
            fs.writeFileSync(shardPath, JSON.stringify(shardOutput, null, 2));
          }
          console.log(`  ✓ Saved (${successful}/${showsWithUrls.length})`);
        } else {
          successful++;
        }
      } else if (previousScores[show.id] != null) {
        scoreDrops.push(show.id);
      }
    } catch (e) {
      console.error(`Error processing ${show.title}:`, e.message);
    }

    // Rate limiting
    await sleep(3000);
  }

  // ── Validation guards ──
  if (showsWithUrls.length > 0) {
    const successRate = successful / showsWithUrls.length;
    if (successRate < 0.5) {
      console.error(`\nGUARD: Only ${successful}/${showsWithUrls.length} shows returned scores (${(successRate * 100).toFixed(0)}% < 50% minimum)`);
      console.error('Possible systemic failure. Check ScrapingBee and Show Score status.');
    }
  }

  if (scoreDrops.length > 0) {
    console.warn(`\n⚠ ${scoreDrops.length} shows lost their score this run:`);
    for (const id of scoreDrops) {
      console.warn(`  - ${id} (was: ${previousScores[id]})`);
    }
  }

  if (previousScoredCount > 0 && successful < previousScoredCount - 5) {
    console.warn(`\n⚠ Score count dropped: ${successful} (was ${previousScoredCount}, delta: -${previousScoredCount - successful})`);
  }

  // Log shard summary (data already written incrementally above)
  if (shardOutput) {
    console.log(`\nShard ${shard} output: ${Object.keys(shardOutput.scores).length} scores, ${Object.keys(shardOutput.discoveredUrls).length} URLs`);
  }

  console.log(`\nDone! Processed ${processed} shows, ${successful} with Show Score data.`);
  console.log(`  Cached URLs: ${Object.keys(urlData.shows || {}).length}`);
  console.log(`  Uncached shows: ${uncachedShows.length}`);
}

main().catch(console.error);
