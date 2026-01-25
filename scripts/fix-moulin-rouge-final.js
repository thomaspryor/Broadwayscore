#!/usr/bin/env node
/**
 * Final cleanup for moulin-rouge-2019:
 * 1. Add NY1/Roma Torre review
 * 2. Remove duplicate files (CHTRIB Chris Jones = same person as NYDN, EW unknown = duplicate)
 */

const fs = require('fs');
const path = require('path');

const reviewsPath = path.join(__dirname, '../data/reviews.json');
const reviewTextsDir = path.join(__dirname, '../data/review-texts/moulin-rouge-2019');

// Load reviews.json
const reviewsData = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));

// Check if NY1 review exists
const mrReviews = reviewsData.reviews.filter(r => r.showId === 'moulin-rouge-2019');
const hasNY1 = mrReviews.some(r => r.outletId === 'NY1' || r.outletId === 'ny1');

if (!hasNY1) {
  console.log('Adding NY1 / Roma Torre review');

  // Find the last moulin-rouge review index
  const lastMRIndex = reviewsData.reviews.findLastIndex(r => r.showId === 'moulin-rouge-2019');

  reviewsData.reviews.splice(lastMRIndex + 1, 0, {
    showId: 'moulin-rouge-2019',
    outletId: 'NY1',
    outlet: 'NY1',
    criticName: 'Roma Torre',
    url: 'https://www.ny1.com/nyc/all-boroughs/news/2019/07/26/theater-review---moulin-rouge--',
    publishDate: '2019-07-25',
    assignedScore: 82,
    bucket: 'Positive',
    thumb: 'Up',
    originalRating: 'Positive',
    pullQuote: "A jukebox musical on steroids. Thanks to a very savvy adaptation, it's paced for maximum pleasure and emotionally engaging.",
    source: 'bww-roundup'
  });

  fs.writeFileSync(reviewsPath, JSON.stringify(reviewsData, null, 2) + '\n');
  console.log('Updated reviews.json with NY1 review');
} else {
  console.log('NY1 review already exists');
}

// Remove duplicate review-text files
const filesToRemove = [
  'CHTRIB--chris-jones.json',  // Chris Jones is already in as NYDN
  'EW--unknown.json',           // Duplicate of EW--leah-greenblatt or ew--leah-greenblatt
  'ew--leah-greenblatt.json',   // Keep uppercase version only
  'deadline--greg-evans.json',  // Keep DEADLINE version
  'guardian--alexis-soloski.json', // Keep GUARDIAN version
  'mashable--erin-strecker.json',  // Keep MASHABLE version
  'observer--david-cote.json',     // Keep OBSERVER version
  'telegraph--diane-snyder.json',  // Keep TELEGRAPH version
  'variety--marilyn-stasio.json',  // Keep VARIETY version
  'amny--matt-windman.json',       // Keep AMNY version
  'the-new-york-daily-news--chris-jones.json', // We have NYDN already
];

console.log('\nRemoving duplicate/redundant files:');
filesToRemove.forEach(f => {
  const filepath = path.join(reviewTextsDir, f);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
    console.log(`  Removed: ${f}`);
  }
});

// Report final state
const remainingFiles = fs.readdirSync(reviewTextsDir).filter(f => f.endsWith('.json'));
console.log(`\nFinal review-text files: ${remainingFiles.length}`);

// List files
console.log('\nRemaining files:');
remainingFiles.forEach(f => console.log(`  ${f}`));

// Count reviews
const finalMRReviews = reviewsData.reviews.filter(r => r.showId === 'moulin-rouge-2019');
console.log(`\nFinal reviews.json entries: ${finalMRReviews.length}`);
