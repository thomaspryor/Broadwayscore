#!/usr/bin/env node
/**
 * merge-reddit-shards.js
 *
 * Merges Reddit sentiment shard output files into audience-buzz.json.
 * Each shard file (data/reddit-shards/shard-N.json) contains { showId: redditData }
 * for the shows processed by that shard.
 *
 * Usage:
 *   node scripts/merge-reddit-shards.js [--dry-run] [--cleanup]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const cleanup = args.includes('--cleanup');

const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');
const shardDir = path.join(__dirname, '../data/reddit-shards');

/**
 * Calculate combined Audience Buzz score with dynamic weighting
 * (Same logic as in scrape-reddit-sentiment.js)
 */
function calculateCombinedScore(sources) {
  const hasShowScore = sources.showScore && sources.showScore.score != null;
  const hasMezzanine = sources.mezzanine && sources.mezzanine.score != null;
  const hasReddit = sources.reddit && sources.reddit.score != null;

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

  const redditWeight = hasReddit ? 0.20 : 0;
  const remainingWeight = 1 - redditWeight;

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

  let weightedSum = 0;
  if (hasShowScore) weightedSum += sources.showScore.score * showScoreWeight;
  if (hasMezzanine) weightedSum += sources.mezzanine.score * mezzanineWeight;
  if (hasReddit) weightedSum += sources.reddit.score * redditWeight;

  return {
    score: Math.round(weightedSum),
    weights: {
      showScore: Math.round(showScoreWeight * 100),
      mezzanine: Math.round(mezzanineWeight * 100),
      reddit: Math.round(redditWeight * 100),
    }
  };
}

function main() {
  console.log('=== Reddit Shard Merger ===\n');

  // Read shard files
  if (!fs.existsSync(shardDir)) {
    console.log('No shard directory found. Nothing to merge.');
    return;
  }

  const shardFiles = fs.readdirSync(shardDir)
    .filter(f => f.startsWith('shard-') && f.endsWith('.json'))
    .sort();

  if (shardFiles.length === 0) {
    console.log('No shard files found. Nothing to merge.');
    return;
  }

  console.log(`Found ${shardFiles.length} shard files`);

  // Load all shard data
  let totalShows = 0;
  const allRedditData = {};

  for (const file of shardFiles) {
    const filePath = path.join(shardDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const showCount = Object.keys(data).length;
      totalShows += showCount;
      console.log(`  ${file}: ${showCount} shows`);
      Object.assign(allRedditData, data);
    } catch (e) {
      console.error(`  Error reading ${file}: ${e.message}`);
    }
  }

  console.log(`\nTotal shows to merge: ${totalShows}`);

  // Load audience-buzz.json
  const audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));
  if (!audienceBuzz.shows) audienceBuzz.shows = {};

  // Merge Reddit data
  let merged = 0;
  let skipped = 0;
  let created = 0;

  for (const [showId, redditData] of Object.entries(allRedditData)) {
    if (!audienceBuzz.shows[showId]) {
      // Show doesn't exist in buzz yet — create a skeleton entry
      audienceBuzz.shows[showId] = {
        designation: 'Shrugging',
        combinedScore: null,
        sources: {}
      };
      created++;
    }

    if (!audienceBuzz.shows[showId].sources) {
      audienceBuzz.shows[showId].sources = {};
    }

    audienceBuzz.shows[showId].sources.reddit = redditData;

    // Recalculate combined score
    const sources = audienceBuzz.shows[showId].sources;
    const { score } = calculateCombinedScore(sources);

    if (score !== null) {
      audienceBuzz.shows[showId].combinedScore = score;
      if (score >= 88) audienceBuzz.shows[showId].designation = 'Loving';
      else if (score >= 78) audienceBuzz.shows[showId].designation = 'Liking';
      else if (score >= 68) audienceBuzz.shows[showId].designation = 'Shrugging';
      else audienceBuzz.shows[showId].designation = 'Loathing';
    }

    merged++;
  }

  console.log(`\nMerged: ${merged} shows`);
  console.log(`Created new entries: ${created}`);
  console.log(`Skipped: ${skipped}`);

  // Update metadata
  audienceBuzz._meta.lastUpdated = new Date().toISOString().split('T')[0];
  audienceBuzz._meta.sources = ['Show Score', 'Mezzanine', 'Reddit'];
  audienceBuzz._meta.notes = 'Dynamic weighting: Reddit fixed 20%, Show Score & Mezzanine split remaining 80% by sample size';

  if (!dryRun) {
    fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));
    console.log(`\nWrote audience-buzz.json`);

    // Clean up shard files
    if (cleanup) {
      for (const file of shardFiles) {
        fs.unlinkSync(path.join(shardDir, file));
      }
      try { fs.rmdirSync(shardDir); } catch (e) { /* dir might not be empty */ }
      console.log('Cleaned up shard files');
    }
  } else {
    console.log('\n(Dry run - no files written)');
  }
}

main();
