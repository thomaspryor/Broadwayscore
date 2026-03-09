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

const showsFile = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
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

    // Designations match the grade labels in data-audience.ts getAudienceGrade()
    if (score >= 88) show.designation = 'Loving';       // A+, A
    else if (score >= 78) show.designation = 'Liking';  // A-, B+
    else if (score >= 68) show.designation = 'Shrugging'; // B, B-
    else if (score >= 53) show.designation = 'Disliking'; // C+, C, C-
    else show.designation = 'Loathing';                 // D, F

    if (oldScore !== score) {
      console.log(`${show.title}: ${oldScore} → ${score} (SS ${weights.showScore}%, Mezz ${weights.mezzanine}%, Reddit ${weights.reddit}%, Theatr ${weights.theatr}%)`);
      updated++;
    }
  }
}

audienceBuzz._meta.lastUpdated = new Date().toISOString().split('T')[0];
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
