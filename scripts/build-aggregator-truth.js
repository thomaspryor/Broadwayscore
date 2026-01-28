#!/usr/bin/env node

/**
 * Build Aggregator Truth - Extract expected review counts from all three aggregators
 *
 * This script extracts review counts from archived HTML pages (Show Score, DTLI, BWW)
 * and compares them against local review counts to identify anomalies.
 *
 * Usage: node scripts/build-aggregator-truth.js
 *
 * Output:
 *   - data/aggregator-truth.json - Main truth file with all counts
 *   - data/aggregator-truth-flags.json - Flagged anomalies
 */

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

// Paths
const SHOWS_PATH = path.join(__dirname, '../data/shows.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const SHOW_SCORE_ARCHIVE = path.join(__dirname, '../data/aggregator-archive/show-score');
const DTLI_ARCHIVE = path.join(__dirname, '../data/aggregator-archive/dtli');
const BWW_ARCHIVE = path.join(__dirname, '../data/aggregator-archive/bww-roundups');
const OUTPUT_PATH = path.join(__dirname, '../data/aggregator-truth.json');
const FLAGS_PATH = path.join(__dirname, '../data/aggregator-truth-flags.json');

/**
 * Load shows from shows.json
 */
function loadShows() {
  const data = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
  return data.shows;
}

/**
 * Count local review files for a show
 */
function countLocalReviews(showId) {
  const showDir = path.join(REVIEW_TEXTS_DIR, showId);
  if (!fs.existsSync(showDir)) {
    return 0;
  }

  const files = fs.readdirSync(showDir)
    .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

  return files.length;
}

/**
 * Extract review count from Show Score archived HTML
 *
 * Show Score displays "Critic Reviews (N)" in the page and also has
 * review tiles with class "review-tile-v2 -critic"
 */
function extractShowScoreCount(showId) {
  const archivePath = path.join(SHOW_SCORE_ARCHIVE, `${showId}.html`);

  if (!fs.existsSync(archivePath)) {
    return { reviewCount: null, hasArchive: false };
  }

  try {
    const html = fs.readFileSync(archivePath, 'utf8');

    // Check if it's a valid show page (not a redirect or error page)
    if (html.includes('NYC Theatre Reviews and Tickets</title>') && !html.includes('(Broadway)')) {
      return { reviewCount: null, hasArchive: true, error: 'wrong-page' };
    }

    // Check for West End pages
    if ((html.includes('London') || html.includes('West End')) && !html.includes('(Broadway)')) {
      const canonicalMatch = html.match(/<link rel="canonical" href="([^"]+)"/);
      if (canonicalMatch && (canonicalMatch[1].includes('/uk/') || canonicalMatch[1].includes('west-end'))) {
        return { reviewCount: null, hasArchive: true, error: 'west-end-page' };
      }
    }

    // Method 1: Extract from "Critic Reviews (N)" heading
    const headingMatch = html.match(/Critic Reviews\s*\((\d+)\)/);
    if (headingMatch) {
      return {
        reviewCount: parseInt(headingMatch[1], 10),
        hasArchive: true,
        method: 'heading'
      };
    }

    // Method 2: Count review tiles
    const dom = new JSDOM(html);
    const doc = dom.window.document;
    const reviewTiles = doc.querySelectorAll('.review-tile-v2.-critic');

    if (reviewTiles.length > 0) {
      return {
        reviewCount: reviewTiles.length,
        hasArchive: true,
        method: 'tiles'
      };
    }

    return { reviewCount: 0, hasArchive: true, method: 'none-found' };

  } catch (error) {
    return { reviewCount: null, hasArchive: true, error: error.message };
  }
}

/**
 * Extract review count from DTLI archived HTML
 *
 * DTLI shows thumb counts in images like "thumb-N.png" and has review-item divs
 */
function extractDTLICount(showId) {
  const archivePath = path.join(DTLI_ARCHIVE, `${showId}.html`);

  if (!fs.existsSync(archivePath)) {
    return { reviewCount: null, hasArchive: false };
  }

  try {
    const html = fs.readFileSync(archivePath, 'utf8');

    // Method 1: Extract from thumb images (thumb-N.png)
    // These represent up/meh/down counts
    const thumbUpMatch = html.match(/thumbs-up\/thumb-(\d+)\.png/);
    const thumbMehMatch = html.match(/thumbs-meh\/thumb-(\d+)\.png/);
    const thumbDownMatch = html.match(/thumbs-down\/thumb-(\d+)\.png/);

    const upCount = thumbUpMatch ? parseInt(thumbUpMatch[1], 10) : 0;
    const mehCount = thumbMehMatch ? parseInt(thumbMehMatch[1], 10) : 0;
    const downCount = thumbDownMatch ? parseInt(thumbDownMatch[1], 10) : 0;
    const totalFromThumbs = upCount + mehCount + downCount;

    if (totalFromThumbs > 0) {
      return {
        reviewCount: totalFromThumbs,
        hasArchive: true,
        method: 'thumbs',
        breakdown: { up: upCount, meh: mehCount, down: downCount }
      };
    }

    // Method 2: Count review-item divs
    const reviewItemMatches = html.match(/<div class="review-item">/g);
    if (reviewItemMatches && reviewItemMatches.length > 0) {
      return {
        reviewCount: reviewItemMatches.length,
        hasArchive: true,
        method: 'review-items'
      };
    }

    return { reviewCount: 0, hasArchive: true, method: 'none-found' };

  } catch (error) {
    return { reviewCount: null, hasArchive: true, error: error.message };
  }
}

/**
 * Extract review count from BWW Review Roundup archived HTML
 *
 * BWW roundups have reviews in the articleBody or as BlogPosting entries
 */
function extractBWWCount(showId) {
  const archivePath = path.join(BWW_ARCHIVE, `${showId}.html`);

  if (!fs.existsSync(archivePath)) {
    return { reviewCount: null, hasArchive: false };
  }

  try {
    const html = fs.readFileSync(archivePath, 'utf8');

    // Method 1: Count BlogPosting entries (newer format)
    const blogPostingMatches = html.match(/"@type":\s*"BlogPosting"/g);
    if (blogPostingMatches && blogPostingMatches.length > 0) {
      return {
        reviewCount: blogPostingMatches.length,
        hasArchive: true,
        method: 'blog-postings'
      };
    }

    // Method 2: Parse articleBody and count "Critic, Outlet:" patterns
    const jsonMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
    if (jsonMatch) {
      try {
        // Remove control characters
        const cleanedJson = jsonMatch[1].replace(/[\x00-\x1F\x7F]/g, ' ');
        const json = JSON.parse(cleanedJson);

        if (json.articleBody) {
          // Count "Name, Outlet:" patterns
          // Pattern: Capitalized First Last, Outlet Name:
          const criticPattern = /([A-Z][a-z]+(?:\s+[A-Z]\.?)?\s+[A-Z][a-z]+),\s+([A-Za-z][A-Za-z\s&'.]+):/g;
          const matches = [...json.articleBody.matchAll(criticPattern)];

          // Deduplicate by critic name
          const seen = new Set();
          let count = 0;
          for (const match of matches) {
            const key = match[1].toLowerCase();
            if (!seen.has(key)) {
              seen.add(key);
              count++;
            }
          }

          if (count > 0) {
            return {
              reviewCount: count,
              hasArchive: true,
              method: 'article-body'
            };
          }
        }
      } catch (e) {
        // JSON parsing failed
      }
    }

    return { reviewCount: 0, hasArchive: true, method: 'none-found' };

  } catch (error) {
    return { reviewCount: null, hasArchive: true, error: error.message };
  }
}

/**
 * Determine flags for anomalies
 */
function determineFlags(showData, showId) {
  const flags = [];
  const { showScore, dtli, bww, maxAggregator, localCount } = showData;

  // Flag: local count > maxAggregator * 1.5 (likely duplicates)
  if (maxAggregator > 0 && localCount > maxAggregator * 1.5) {
    flags.push({
      type: 'likely-duplicates',
      message: `localCount (${localCount}) > maxAggregator (${maxAggregator}) * 1.5`,
      severity: 'warning'
    });
  }

  // Flag: local count < maxAggregator * 0.8 (possibly missing reviews)
  if (maxAggregator > 0 && localCount < maxAggregator * 0.8) {
    const missing = maxAggregator - localCount;
    flags.push({
      type: 'possibly-missing',
      message: `localCount (${localCount}) < maxAggregator (${maxAggregator}) * 0.8 - missing ~${missing} reviews`,
      severity: 'info'
    });
  }

  // Flag: aggregator returns 0 but we have >10 local (check URL)
  if (showScore.hasArchive && showScore.reviewCount === 0 && localCount > 10) {
    flags.push({
      type: 'check-show-score-url',
      message: `Show Score has 0 reviews but we have ${localCount} local`,
      severity: 'warning'
    });
  }

  if (dtli.hasArchive && dtli.reviewCount === 0 && localCount > 10) {
    flags.push({
      type: 'check-dtli-url',
      message: `DTLI has 0 reviews but we have ${localCount} local`,
      severity: 'warning'
    });
  }

  if (bww.hasArchive && bww.reviewCount === 0 && localCount > 10) {
    flags.push({
      type: 'check-bww-url',
      message: `BWW has 0 reviews but we have ${localCount} local`,
      severity: 'warning'
    });
  }

  // Flag: no archives exist
  if (!showScore.hasArchive && !dtli.hasArchive && !bww.hasArchive) {
    flags.push({
      type: 'no-archives',
      message: 'No aggregator archives exist for this show',
      severity: 'info'
    });
  }

  // Flag: aggregator errors
  if (showScore.error) {
    flags.push({
      type: 'show-score-error',
      message: `Show Score extraction error: ${showScore.error}`,
      severity: 'error'
    });
  }

  if (dtli.error) {
    flags.push({
      type: 'dtli-error',
      message: `DTLI extraction error: ${dtli.error}`,
      severity: 'error'
    });
  }

  if (bww.error) {
    flags.push({
      type: 'bww-error',
      message: `BWW extraction error: ${bww.error}`,
      severity: 'error'
    });
  }

  return flags;
}

/**
 * Main function
 */
function main() {
  console.log('Building Aggregator Truth...\n');

  const shows = loadShows();
  console.log(`Loaded ${shows.length} shows from shows.json\n`);

  const truth = {
    _meta: {
      generatedAt: new Date().toISOString(),
      description: 'Expected review counts from all three aggregators compared to local counts',
      sources: {
        showScore: 'show-score.com',
        dtli: 'didtheylikeit.com',
        bww: 'broadwayworld.com review roundups'
      }
    },
    shows: {}
  };

  const allFlags = {};

  // Stats
  let processedCount = 0;
  let showScoreCount = 0;
  let dtliCount = 0;
  let bwwCount = 0;
  let allThreeCount = 0;
  let flaggedCount = 0;

  for (const show of shows) {
    const showId = show.id;

    // Get local count
    const localCount = countLocalReviews(showId);

    // Extract from each aggregator
    const showScore = extractShowScoreCount(showId);
    const dtli = extractDTLICount(showId);
    const bww = extractBWWCount(showId);

    // Calculate max aggregator count
    const counts = [
      showScore.reviewCount || 0,
      dtli.reviewCount || 0,
      bww.reviewCount || 0
    ];
    const maxAggregator = Math.max(...counts);

    // Calculate ratio (local / max aggregator)
    const ratio = maxAggregator > 0 ? parseFloat((localCount / maxAggregator).toFixed(2)) : null;

    // Build show data
    const showData = {
      showScore: {
        reviewCount: showScore.reviewCount,
        hasArchive: showScore.hasArchive,
        ...(showScore.method && { method: showScore.method }),
        ...(showScore.breakdown && { breakdown: showScore.breakdown }),
        ...(showScore.error && { error: showScore.error })
      },
      dtli: {
        reviewCount: dtli.reviewCount,
        hasArchive: dtli.hasArchive,
        ...(dtli.method && { method: dtli.method }),
        ...(dtli.breakdown && { breakdown: dtli.breakdown }),
        ...(dtli.error && { error: dtli.error })
      },
      bww: {
        reviewCount: bww.reviewCount,
        hasArchive: bww.hasArchive,
        ...(bww.method && { method: bww.method }),
        ...(bww.error && { error: bww.error })
      },
      maxAggregator,
      localCount,
      ratio
    };

    truth.shows[showId] = showData;

    // Determine flags
    const flags = determineFlags(showData, showId);
    if (flags.length > 0) {
      allFlags[showId] = {
        title: show.title,
        flags
      };
      flaggedCount++;
    }

    // Update stats
    processedCount++;
    if (showScore.hasArchive) showScoreCount++;
    if (dtli.hasArchive) dtliCount++;
    if (bww.hasArchive) bwwCount++;
    if (showScore.hasArchive && dtli.hasArchive && bww.hasArchive) allThreeCount++;

    // Log progress
    const ssStr = showScore.reviewCount !== null ? showScore.reviewCount : '-';
    const dtliStr = dtli.reviewCount !== null ? dtli.reviewCount : '-';
    const bwwStr = bww.reviewCount !== null ? bww.reviewCount : '-';
    const flagStr = flags.length > 0 ? ` [${flags.length} flags]` : '';

    console.log(`${showId}: SS=${ssStr}, DTLI=${dtliStr}, BWW=${bwwStr}, Local=${localCount}, Max=${maxAggregator}${flagStr}`);
  }

  // Write truth file
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(truth, null, 2));
  console.log(`\nWrote: ${OUTPUT_PATH}`);

  // Write flags file
  const flagsOutput = {
    _meta: {
      generatedAt: new Date().toISOString(),
      description: 'Flagged shows with potential anomalies',
      totalFlagged: flaggedCount
    },
    shows: allFlags
  };
  fs.writeFileSync(FLAGS_PATH, JSON.stringify(flagsOutput, null, 2));
  console.log(`Wrote: ${FLAGS_PATH}`);

  // Print summary
  console.log('\n========================================');
  console.log('Aggregator Truth Summary:');
  console.log('========================================');
  console.log(`Shows processed: ${processedCount}`);
  console.log(`Shows with Show Score archive: ${showScoreCount}`);
  console.log(`Shows with DTLI archive: ${dtliCount}`);
  console.log(`Shows with BWW archive: ${bwwCount}`);
  console.log(`Shows with all 3 aggregators: ${allThreeCount}`);
  console.log(`Shows flagged: ${flaggedCount}`);

  if (flaggedCount > 0) {
    console.log('\nFlags:');
    for (const [showId, data] of Object.entries(allFlags)) {
      for (const flag of data.flags) {
        const icon = flag.severity === 'error' ? '[!]' : flag.severity === 'warning' ? '[*]' : '[-]';
        console.log(`${icon} ${showId}: ${flag.message}`);
      }
    }
  }
}

main();
