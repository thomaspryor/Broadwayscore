#!/usr/bin/env node
/**
 * Analyze review-texts files to find reviews with valid thumb data
 */

const fs = require('fs');
const path = require('path');

const showId = process.argv[2] || 'queen-versailles-2025';
const showDir = path.join(__dirname, '../data/review-texts', showId);

if (!fs.existsSync(showDir)) {
  console.log('Show directory not found:', showDir);
  process.exit(1);
}

console.log(`=== REVIEW-TEXTS FOR ${showId.toUpperCase()} ===\n`);
console.log('Outlet                    | DTLI | BWW  | Score | Original | LLM');
console.log('------------------------------------------------------------------------');

const files = fs.readdirSync(showDir).filter(f => f.endsWith('.json'));
const reviews = [];

files.forEach(file => {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8'));
    const outlet = (data.outlet || data.outletId || file).slice(0, 25).padEnd(25);
    const dtli = (data.dtliThumb || '-').padEnd(4);
    const bww = (data.bwwThumb || '-').padEnd(4);
    const score = String(data.assignedScore ?? '-').padEnd(5);
    const orig = String(data.originalScore ?? '-').slice(0, 8).padEnd(8);
    const llm = data.llmScore ? String(data.llmScore.score) : '-';

    reviews.push({
      outlet: data.outlet || data.outletId,
      dtliThumb: data.dtliThumb,
      bwwThumb: data.bwwThumb,
      score: data.assignedScore,
      originalScore: data.originalScore,
      llmScore: data.llmScore?.score,
      file
    });

    console.log(`${outlet} | ${dtli} | ${bww} | ${score} | ${orig} | ${llm}`);
  } catch (e) {
    // skip invalid files
  }
});

// Calculate what the score SHOULD be
console.log('\n=== SCORE ANALYSIS ===\n');

const THUMB_TO_SCORE = { 'Up': 78, 'Flat': 55, 'Meh': 55, 'Down': 35 };

let totalScore = 0;
let count = 0;

reviews.forEach(r => {
  // Determine best score
  let bestScore = null;
  let source = null;

  // Priority: LLM > originalScore > thumb
  if (r.llmScore) {
    bestScore = r.llmScore;
    source = 'LLM';
  } else if (r.originalScore) {
    const rating = r.originalScore.toString();
    const starMatch = rating.match(/^(\d(?:\.\d)?)\s*(?:\/\s*5|stars?)/i);
    if (starMatch) {
      const stars = Math.round(parseFloat(starMatch[1]));
      bestScore = [10, 25, 45, 63, 82, 92][stars] || 55;
      source = `${stars}/5`;
    }
    const letterMatch = rating.match(/^([A-D][+-]?|F)$/i);
    if (letterMatch) {
      const grades = {'A+':97,'A':93,'A-':89,'B+':85,'B':80,'B-':74,'C+':67,'C':60,'C-':53,'D+':45,'D':36,'D-':28,'F':15};
      bestScore = grades[letterMatch[1].toUpperCase()];
      source = letterMatch[1];
    }
  } else if (r.dtliThumb) {
    bestScore = THUMB_TO_SCORE[r.dtliThumb] || 55;
    source = `DTLI=${r.dtliThumb}`;
  } else if (r.bwwThumb) {
    bestScore = THUMB_TO_SCORE[r.bwwThumb] || 55;
    source = `BWW=${r.bwwThumb}`;
  }

  if (bestScore) {
    console.log(`${r.outlet?.slice(0,30)}: ${bestScore} (${source})`);
    totalScore += bestScore;
    count++;
  }
});

if (count > 0) {
  console.log(`\nProjected average: ${(totalScore / count).toFixed(1)} from ${count} reviews`);
}
