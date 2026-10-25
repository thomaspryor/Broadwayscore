#!/usr/bin/env node
const data = require('../data/reviews.json');
const reviews = data.reviews;

const qovReviews = reviews.filter(r => r.showId === 'queen-versailles-2025');
console.log('=== QUEEN OF VERSAILLES REVIEWS ===');
console.log('Total reviews:', qovReviews.length);
console.log('\nOutlet                    | Score | Original        | DTLI | BWW');
console.log('------------------------------------------------------------------');
qovReviews.forEach(r => {
  const outlet = (r.outlet || '').slice(0, 25).padEnd(25);
  const score = String(r.assignedScore ?? 'null').padEnd(5);
  const orig = String(r.originalRating ?? 'null').slice(0, 15).padEnd(15);
  const dtli = r.dtliThumb ?? '-';
  const bww = r.bwwThumb ?? '-';
  console.log(`${outlet} | ${score} | ${orig} | ${dtli} | ${bww}`);
});

const withScores = qovReviews.filter(r => r.assignedScore != null);
if (withScores.length > 0) {
  const avg = withScores.reduce((sum, r) => sum + r.assignedScore, 0) / withScores.length;
  console.log('\nCurrent Average:', avg.toFixed(1));
  console.log('Reviews with scores:', withScores.length);
}
