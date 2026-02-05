#!/usr/bin/env node
/**
 * merge-show-score-shards.js
 *
 * Merges Show Score shard output files into audience-buzz.json and show-score-urls.json.
 * Each shard file (data/show-score-shards/shard-N.json) contains:
 *   { discoveredUrls: { showId: url }, scores: { showId: showScoreData } }
 *
 * Usage:
 *   node scripts/merge-show-score-shards.js [--dry-run] [--cleanup]
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const cleanup = args.includes('--cleanup');

const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');
const urlsPath = path.join(__dirname, '../data/show-score-urls.json');
const shardDir = path.join(__dirname, '../data/show-score-shards');

/**
 * Calculate combined Audience Buzz score with dynamic weighting
 * (Same logic as in scrape-reddit-sentiment.js / merge-reddit-shards.js)
 */
function calculateCombinedScore(sources) {
  const hasShowScore = sources.showScore && sources.showScore.score != null;
  const hasMezzanine = sources.mezzanine && sources.mezzanine.score != null;
  const hasReddit = sources.reddit && sources.reddit.score != null;

  if (!hasShowScore && !hasMezzanine && !hasReddit) {
    return { score: null };
  }

  // Single-source cases
  if (!hasMezzanine && !hasReddit && hasShowScore) {
    return { score: Math.round(sources.showScore.score) };
  }
  if (!hasShowScore && !hasMezzanine && hasReddit) {
    return { score: Math.round(sources.reddit.score) };
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

  return { score: Math.round(weightedSum) };
}

function main() {
  console.log('=== Show Score Shard Merger ===\n');

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

  // Aggregate all shard data
  const allUrls = {};
  const allScores = {};

  for (const file of shardFiles) {
    const filePath = path.join(shardDir, file);
    try {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const urlCount = Object.keys(data.discoveredUrls || {}).length;
      const scoreCount = Object.keys(data.scores || {}).length;
      console.log(`  ${file}: ${scoreCount} scores, ${urlCount} URLs`);
      Object.assign(allUrls, data.discoveredUrls || {});
      Object.assign(allScores, data.scores || {});
    } catch (e) {
      console.error(`  Error reading ${file}: ${e.message}`);
    }
  }

  console.log(`\nTotal: ${Object.keys(allScores).length} scores, ${Object.keys(allUrls).length} URLs to merge`);

  // ── Merge discovered URLs into show-score-urls.json ──
  const urlData = JSON.parse(fs.readFileSync(urlsPath, 'utf8'));
  if (!urlData.shows) urlData.shows = {};

  let newUrls = 0;
  for (const [showId, url] of Object.entries(allUrls)) {
    if (!urlData.shows[showId]) {
      newUrls++;
    }
    urlData.shows[showId] = url;
  }

  console.log(`\nURL cache: ${newUrls} new URLs added (total: ${Object.keys(urlData.shows).length})`);

  // ── Merge scores into audience-buzz.json ──
  const audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));
  if (!audienceBuzz.shows) audienceBuzz.shows = {};

  let merged = 0;
  let created = 0;

  for (const [showId, showScoreData] of Object.entries(allScores)) {
    if (!audienceBuzz.shows[showId]) {
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

    audienceBuzz.shows[showId].sources.showScore = showScoreData;

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

  console.log(`Merged: ${merged} shows (${created} new entries)`);

  // Update metadata
  audienceBuzz._meta.lastUpdated = new Date().toISOString().split('T')[0];

  if (!dryRun) {
    fs.writeFileSync(urlsPath, JSON.stringify(urlData, null, 2));
    console.log('Wrote show-score-urls.json');

    fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));
    console.log('Wrote audience-buzz.json');

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
