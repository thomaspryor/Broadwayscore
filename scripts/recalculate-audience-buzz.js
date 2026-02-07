#!/usr/bin/env node
/**
 * Recalculate all Audience Buzz scores with dynamic weighting
 *
 * Run this after changing the weighting algorithm to update all existing scores.
 */

const fs = require('fs');
const path = require('path');
const { calculateCombinedScore } = require('./lib/audience-weighting');

const audienceBuzzPath = path.join(__dirname, '../data/audience-buzz.json');
const audienceBuzz = JSON.parse(fs.readFileSync(audienceBuzzPath, 'utf8'));

console.log('Recalculating all Audience Buzz scores with dynamic weighting...\n');

let updated = 0;
for (const [showId, show] of Object.entries(audienceBuzz.shows)) {
  const oldScore = show.combinedScore;
  const { score, weights } = calculateCombinedScore(show.sources);

  if (score !== null) {
    show.combinedScore = score;

    if (score >= 88) show.designation = 'Loving';
    else if (score >= 78) show.designation = 'Liking';
    else if (score >= 68) show.designation = 'Shrugging';
    else show.designation = 'Loathing';

    if (oldScore !== score) {
      console.log(`${show.title}: ${oldScore} → ${score} (SS ${weights.showScore}%, Mezz ${weights.mezzanine}%, Reddit ${weights.reddit}%)`);
      updated++;
    }
  }
}

audienceBuzz._meta.lastUpdated = new Date().toISOString().split('T')[0];
audienceBuzz._meta.designationThresholds = {
  'Loving': '88-100',
  'Liking': '78-87',
  'Shrugging': '68-77',
  'Loathing': '0-67'
};
audienceBuzz._meta.notes = 'Proportional weighting by reviewCount volume (max 80% single source)';

fs.writeFileSync(audienceBuzzPath, JSON.stringify(audienceBuzz, null, 2));
console.log(`\nUpdated ${updated} shows. Saved to audience-buzz.json`);
