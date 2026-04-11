#!/usr/bin/env node
/**
 * Recalculate all Audience Buzz scores with dynamic weighting
 *
 * Run this after changing the weighting algorithm to update all existing scores.
 *
 * Data dir resolution order:
 *   1. --data-dir=<path> CLI flag
 *   2. DATA_DIR env var (used by CI to point at private repo checkout)
 *   3. <repo>/data (default — public repo working directory)
 *
 * This lets the same script run locally against the public repo AND in
 * CI against the private core-data checkout (/tmp/core-data-checkout/).
 */

const fs = require('fs');
const path = require('path');
const { calculateCombinedScore, getDesignation } = require('./lib/audience-weighting');

// Resolve data dir: --data-dir flag > DATA_DIR env > default
const cliDataDir = process.argv.find(a => a.startsWith('--data-dir='));
const dataDir = cliDataDir
  ? cliDataDir.split('=').slice(1).join('=')
  : (process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

const audienceBuzzPath = path.join(dataDir, 'audience-buzz.json');
const showsPath = path.join(dataDir, 'shows.json');

if (!fs.existsSync(audienceBuzzPath)) {
  console.error(`audience-buzz.json not found at ${audienceBuzzPath}`);
  console.error(`Set DATA_DIR or pass --data-dir=<path> to point at the correct directory.`);
  process.exit(1);
}
if (!fs.existsSync(showsPath)) {
  console.error(`shows.json not found at ${showsPath}`);
  process.exit(1);
}

console.log(`Reading from: ${dataDir}`);
const audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));
const showsFile = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
const showMap = {};
for (const s of showsFile.shows) showMap[s.id] = s;

console.log('Recalculating all Audience Buzz scores with dynamic weighting...\n');

let updated = 0;
for (const [showId, show] of Object.entries(audienceBuzz.shows)) {
  const oldScore = show.combinedScore;
  const showData = showMap[showId];
  const showInfo = showData ? { closingDate: showData.closingDate, status: showData.status, category: showData.category } : undefined;
  const { score, weights } = calculateCombinedScore(show.sources, showInfo);

  if (score !== null) {
    show.combinedScore = score;

    show.designation = getDesignation(score);

    if (oldScore !== score) {
      const weightStr = Object.entries(weights).filter(([, v]) => v > 0).map(([k, v]) => `${k} ${v}%`).join(', ');
      console.log(`${show.title}: ${oldScore} → ${score} (${weightStr})`);
      updated++;
    }
  }
}

audienceBuzz._meta.lastUpdated = new Date().toISOString();
audienceBuzz._meta.designationThresholds = {
  'Loving': '88-100',   // A+, A
  'Liking': '78-87',    // A-, B+
  'Shrugging': '68-77', // B, B-
  'Disliking': '53-67', // C+, C, C-
  'Loathing': '0-52'    // D, F
};
audienceBuzz._meta.notes = 'Proportional weighting by reviewCount volume (max 80% single source)';

fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));
console.log(`\nUpdated ${updated} shows. Saved to audience-buzz.json`);
