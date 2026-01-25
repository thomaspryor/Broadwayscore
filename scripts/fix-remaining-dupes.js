#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');

console.log('Reading reviews.json...');
const data = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
const reviews = data.reviews;
const originalCount = reviews.length;
console.log(`Total reviews: ${originalCount}\n`);

let deletedDuplicates = 0;

console.log('=== Fixing Remaining Duplicates ===\n');

// The Great Gatsby - NY Stage Review duplicates
console.log('The Great Gatsby - NY Stage Review:');
const gatsbyDupes = reviews.filter(r =>
  r.showId === 'the-great-gatsby-2024' &&
  r.outlet && r.outlet.includes('Stage') &&
  r.url === 'https://nystagereview.com/2024/04/25/the-great-gatsby-all-that-glitters-but-short-on-depth/'
);
console.log(`  Found ${gatsbyDupes.length} duplicates`);
gatsbyDupes.forEach((r, i) => {
  console.log(`    ${i + 1}. ${r.criticName} - pullQuote: ${r.pullQuote ? 'YES' : 'NO'}`);
});

// Keep Frank Scheck (first one), delete Sandy MacDonald
const gatsbyToDelete = reviews.findIndex(r =>
  r.showId === 'the-great-gatsby-2024' &&
  r.criticName === 'Sandy MacDonald' &&
  r.url === 'https://nystagereview.com/2024/04/25/the-great-gatsby-all-that-glitters-but-short-on-depth/'
);
if (gatsbyToDelete >= 0) {
  console.log(`  ✓ Deleting duplicate: Sandy MacDonald\n`);
  reviews.splice(gatsbyToDelete, 1);
  deletedDuplicates++;
}

// Stranger Things - NY Stage Review duplicates
console.log('Stranger Things - NY Stage Review:');
const strangerDupes = reviews.filter(r =>
  r.showId === 'stranger-things-2024' &&
  r.outlet && r.outlet.includes('Stage') &&
  r.url === 'https://nystagereview.com/2025/04/22/stranger-things-the-first-shadow-stage-version-of-series-maybe-not-strange-enough/'
);
console.log(`  Found ${strangerDupes.length} duplicates`);
strangerDupes.forEach((r, i) => {
  console.log(`    ${i + 1}. ${r.criticName} - pullQuote: ${r.pullQuote ? 'YES' : 'NO'}`);
});

// Keep David Finkle, delete Bob Verini
const strangerToDelete = reviews.findIndex(r =>
  r.showId === 'stranger-things-2024' &&
  r.criticName === 'Bob Verini' &&
  r.url === 'https://nystagereview.com/2025/04/22/stranger-things-the-first-shadow-stage-version-of-series-maybe-not-strange-enough/'
);
if (strangerToDelete >= 0) {
  console.log(`  ✓ Deleting duplicate: Bob Verini\n`);
  reviews.splice(strangerToDelete, 1);
  deletedDuplicates++;
}

// Mamma Mia - Fix the wrong outlet for Michael Sommers
console.log('Mamma Mia - Entertainment Weekly:');
const mammaMiaWrong = reviews.filter(r =>
  r.showId === 'mamma-mia-2025' &&
  r.criticName === 'Michael Sommers' &&
  r.outlet && r.outlet.includes('Entertainment')
);
console.log(`  Found ${mammaMiaWrong.length} EW reviews with wrong outlet`);
mammaMiaWrong.forEach((r, i) => {
  console.log(`    ${i + 1}. ${r.criticName} - URL: ${r.url}`);
});

// This is actually a duplicate of David Finkle's NY Stage Review - delete it
const mammaMiaToDelete = reviews.findIndex(r =>
  r.showId === 'mamma-mia-2025' &&
  r.criticName === 'Michael Sommers' &&
  r.url === 'https://nystagereview.com/2025/08/14/mamma-mia-thank-you-for-music/'
);
if (mammaMiaToDelete >= 0) {
  console.log(`  ✓ Deleting duplicate: Michael Sommers (wrong outlet, same URL as David Finkle)\n`);
  reviews.splice(mammaMiaToDelete, 1);
  deletedDuplicates++;
}

// Write back to file
console.log('=== Writing Updated Reviews ===');
data.reviews = reviews;
fs.writeFileSync(REVIEWS_PATH, JSON.stringify(data, null, 2));
console.log(`✓ Wrote ${reviews.length} reviews (was ${originalCount})`);
console.log(`✓ Removed ${originalCount - reviews.length} total reviews\n`);

console.log('=== SUMMARY ===');
console.log(`Duplicate reviews deleted: ${deletedDuplicates}/3`);
