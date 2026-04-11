#!/usr/bin/env node
/**
 * compute-social-pulse-ranks.js — post-loop rank aggregator.
 *
 * This script runs AFTER fetch-social-pulse.js has processed all running
 * shows. It reads every data/social-pulse/*.json file, sorts shows within
 * each market (Broadway / West End) by raw volume, and writes the rank
 * field back into both the canonical and public files.
 *
 * Why a separate step: rank is a CROSS-SHOW property — you can't compute
 * "#3 of 33 Broadway shows" until you know all 33 current volumes. The
 * plan-review surfaced this as a P0 issue (Claude + Gemini both flagged it).
 *
 * Usage:
 *   node scripts/compute-social-pulse-ranks.js
 *   node scripts/compute-social-pulse-ranks.js --dry-run
 *
 * Output files updated:
 *   data/social-pulse/{id}.json         — sets `rank` field
 *   public/data/shows/{id}.social.json  — sets `r` field (compact)
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const SOCIAL_PULSE_DIR = path.join(REPO_ROOT, 'data', 'social-pulse');
const PUBLIC_SHOWS_DIR = path.join(REPO_ROOT, 'public', 'data', 'shows');

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
  };
}

/**
 * Reads all data/social-pulse/*.json files (skipping _budget.json and any
 * other leading-underscore metadata files). Returns parsed objects with
 * the showId attached.
 */
function loadAllPulseFiles() {
  if (!fs.existsSync(SOCIAL_PULSE_DIR)) {
    console.error(`No ${SOCIAL_PULSE_DIR} directory — run fetch-social-pulse.js first`);
    return [];
  }
  const files = fs.readdirSync(SOCIAL_PULSE_DIR).filter((f) => f.endsWith('.json') && !f.startsWith('_'));
  const pulseData = [];
  for (const filename of files) {
    const filePath = path.join(SOCIAL_PULSE_DIR, filename);
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      if (!parsed.showId) continue;
      pulseData.push({ filePath, filename, data: parsed });
    } catch (err) {
      console.warn(`Skipping ${filename}: ${err.message}`);
    }
  }
  return pulseData;
}

/**
 * Groups shows by market. The canonical file stores the market label
 * ('Broadway' / 'West End' / etc.) from fetch-social-pulse.js.
 *
 * Shows with Hidden tier are still ranked — they still have a volume, just
 * too low to display a card. This lets a show cross the display threshold
 * between weeks without its rank disappearing and reappearing.
 */
function groupByMarket(pulseData) {
  const groups = new Map();
  for (const entry of pulseData) {
    const market = entry.data.market || 'Broadway';
    if (!groups.has(market)) groups.set(market, []);
    groups.get(market).push(entry);
  }
  return groups;
}

/**
 * For each market, sort shows by volume desc and assign 1-based rank.
 * Mutates the entries in-place.
 */
function assignRanks(groups) {
  for (const [, entries] of groups) {
    entries.sort((a, b) => (b.data.volume || 0) - (a.data.volume || 0));
    entries.forEach((entry, i) => {
      const rankText = `${i + 1}/${entries.length} ${marketShortLabel(entry.data.market)}`;
      entry.newRank = { position: i + 1, total: entries.length, text: rankText };
    });
  }
}

function marketShortLabel(market) {
  if (!market) return 'Broadway';
  if (market === 'Broadway') return 'Broadway';
  if (market === 'West End') return 'West End';
  if (market === 'Off-Broadway') return 'Off-Broadway';
  if (market === 'Off-West End') return 'Off-West End';
  return market;
}

/**
 * Writes the rank back into both files. Matches the public file's compact
 * schema: adds `r` as the short rank string (e.g., "3/33 Broadway").
 */
function writeRanks(pulseData, dryRun, logger = console) {
  let writeCount = 0;
  for (const entry of pulseData) {
    const canonicalPath = entry.filePath;
    const publicPath = path.join(PUBLIC_SHOWS_DIR, `${entry.data.showId}.social.json`);

    // Update canonical
    entry.data.rank = entry.newRank;
    if (!dryRun) {
      fs.writeFileSync(canonicalPath, JSON.stringify(entry.data, null, 2));
    }

    // Update public compact file if it exists
    if (fs.existsSync(publicPath)) {
      try {
        const publicData = JSON.parse(fs.readFileSync(publicPath, 'utf-8'));
        publicData.r = entry.newRank.text;
        if (!dryRun) {
          fs.writeFileSync(publicPath, JSON.stringify(publicData));
        }
      } catch (err) {
        logger.warn(`Could not update ${publicPath}: ${err.message}`);
      }
    }

    writeCount++;
  }
  return writeCount;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`Loading social-pulse files from ${SOCIAL_PULSE_DIR}...`);
  const pulseData = loadAllPulseFiles();
  if (pulseData.length === 0) {
    console.log('No pulse files to rank.');
    process.exit(0);
  }

  console.log(`Loaded ${pulseData.length} pulse files`);

  const groups = groupByMarket(pulseData);
  console.log('\nMarket groups:');
  for (const [market, entries] of groups) {
    console.log(`  ${market}: ${entries.length} shows`);
  }

  assignRanks(groups);

  // Show the top 5 per market before writing
  console.log('\n─── Rank previews (top 5 per market) ───');
  for (const [market, entries] of groups) {
    console.log(`\n${market}:`);
    for (const entry of entries.slice(0, 5)) {
      console.log(
        `  #${entry.newRank.position}/${entry.newRank.total}  ${entry.data.showId.padEnd(40)}  vol=${String(entry.data.volume).padStart(4)}  tier=${entry.data.tier}`,
      );
    }
  }

  const writeCount = writeRanks(pulseData, args.dryRun);
  console.log(`\n${args.dryRun ? '[dry-run] would write' : 'Wrote'} ${writeCount} files`);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadAllPulseFiles,
  groupByMarket,
  assignRanks,
  writeRanks,
};
