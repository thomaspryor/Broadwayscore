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
const { calculateCombinedScore } = require('./lib/audience-weighting');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const cleanup = args.includes('--cleanup');

const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');
const showsData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
const showMapById = {};
for (const s of showsData.shows) showMapById[s.id] = s;
const urlsPath = path.join(__dirname, '../data/show-score-urls.json');
const shardDir = path.join(__dirname, '../data/show-score-shards');

// Build multi-production lookup: for each title base, find the most recent production.
// ShowScore has ONE page per title — only the most recent production gets the data.
const mostRecentByTitle = {};
for (const s of showsData.shows) {
  const titleBase = s.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\(.*?\)\s*$/, '').trim();
  const existing = mostRecentByTitle[titleBase];
  if (!existing || (s.openingDate || '') > (existing.openingDate || '')) {
    mostRecentByTitle[titleBase] = s;
  }
}

function isMostRecentProduction(showId) {
  const show = showMapById[showId];
  if (!show) return true; // Unknown show, allow
  const titleBase = show.title.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s*\(.*?\)\s*$/, '').trim();
  const newest = mostRecentByTitle[titleBase];
  return !newest || newest.id === showId;
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
    // Only cache URLs for the most recent production
    if (!isMostRecentProduction(showId)) continue;
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
  let skippedOlder = 0;

  for (const [showId, showScoreData] of Object.entries(allScores)) {
    // Multi-production guard: only the most recent production gets ShowScore data
    if (!isMostRecentProduction(showId)) {
      console.log(`  SKIP ${showId}: not the most recent production of this title`);
      skippedOlder++;
      continue;
    }

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
    const sd = showMapById[showId];
    const showInfo = sd ? { closingDate: sd.closingDate, status: sd.status } : undefined;
    const { score } = calculateCombinedScore(sources, showInfo);

    if (score !== null) {
      audienceBuzz.shows[showId].combinedScore = score;
      if (score >= 88) audienceBuzz.shows[showId].designation = 'Loving';
      else if (score >= 78) audienceBuzz.shows[showId].designation = 'Liking';
      else if (score >= 68) audienceBuzz.shows[showId].designation = 'Shrugging';
      else audienceBuzz.shows[showId].designation = 'Loathing';
    }

    merged++;
  }

  console.log(`Merged: ${merged} shows (${created} new entries, ${skippedOlder} older productions skipped)`);

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
