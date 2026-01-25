#!/usr/bin/env node
/**
 * Fix moulin-rouge-2019 review data v2:
 * 1. Add NYT review from review-text file (was incorrectly removed)
 * 2. Remove true duplicates (same outlet normalized + same critic normalized)
 * 3. Clean up review-text files
 */

const fs = require('fs');
const path = require('path');

const reviewsPath = path.join(__dirname, '../data/reviews.json');
const reviewTextsDir = path.join(__dirname, '../data/review-texts/moulin-rouge-2019');

// Load reviews.json
const reviewsData = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));

// Separate moulin-rouge-2019 reviews from others
const otherReviews = reviewsData.reviews.filter(r => r.showId !== 'moulin-rouge-2019');
let mrReviews = reviewsData.reviews.filter(r => r.showId === 'moulin-rouge-2019');

console.log(`Found ${mrReviews.length} moulin-rouge-2019 reviews`);

// Load NYT review from review-text file to add back
const nytReviewTextPath = path.join(reviewTextsDir, 'NYT--ben-brantley.json');
if (fs.existsSync(nytReviewTextPath)) {
  const nytData = JSON.parse(fs.readFileSync(nytReviewTextPath, 'utf8'));

  // Check if NYT is already in reviews
  const hasNYT = mrReviews.some(r => r.outletId === 'NYT' && r.criticName.toLowerCase().includes('brantley'));

  if (!hasNYT) {
    console.log('Adding NYT review back (was incorrectly removed)');
    mrReviews.push({
      showId: 'moulin-rouge-2019',
      outletId: 'NYT',
      outlet: 'The New York Times',
      criticName: 'Ben Brantley',
      url: nytData.url,
      publishDate: nytData.publishDate,
      assignedScore: nytData.assignedScore || 89,
      bucket: 'Positive',
      thumb: 'Up',
      originalRating: "Critic's Pick",
      pullQuote: "This one's for the hedonists. All you party people should know that the Al Hirschfeld Theater has been refurbished as an opulent pleasure palace.",
      source: 'review-text-file',
      designation: 'Critics_Pick'
    });
  }
}

// Normalize functions
function normalizeOutlet(outlet) {
  return outlet.toLowerCase()
    .replace(/^the\s+/, '')
    .replace(/\s+/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function normalizeCritic(name) {
  return name.toLowerCase()
    .replace(/[^a-z]/g, '');
}

// Map outlet IDs to normalized names
const outletNormMap = {
  'THR': 'hollywoodreporter',
  'VARIETY': 'variety',
  'DEADLINE': 'deadline',
  'AMNY': 'amnewyork',
  'VULT': 'vulture',
  'vulture': 'vulture',
  'EW': 'entertainmentweekly',
  'ew': 'entertainmentweekly',
  'NYDN': 'newyorkdailynews',
  'the-new-york-daily-news': 'newyorkdailynews',
  'GUARDIAN': 'guardian',
  'guardian': 'guardian',
  'MASHABLE': 'mashable',
  'mashable': 'mashable',
  'NYSR2': 'nystagereview',
  'ny-stage-review': 'nystagereview',
  'NYSR': 'nystagereview',
  'OBSERVER': 'observer',
  'observer': 'observer',
  'broadwayworld': 'broadwayworld',
  'BWW': 'broadwayworld',
  'timeout-ny': 'timeoutnewyork',
  'TIMEOUTNY': 'timeoutnewyork',
  'washington-post': 'washingtonpost',
  'WASHPOST': 'washingtonpost',
  'nypost': 'newyorkpost',
  'NYP': 'newyorkpost',
  'thewrap': 'wrap',
  'WRAP': 'wrap',
  'usa-today': 'usatoday',
  'USATODAY': 'usatoday',
  'rolling-stone': 'rollingstone',
  'ROLLSTONE': 'rollingstone',
  'daily-beast': 'dailybeast',
  'TDB': 'dailybeast',
  'telegraph': 'telegraph',
  'TELEGRAPH': 'telegraph',
  'nj-com': 'njcom',
  'NJCOM': 'njcom',
  'theater-news-online': 'theaternewsonline',
  'TNO': 'theaternewsonline',
  'new-york-theatre-guide': 'newyorktheatreguide',
  'NYTG': 'newyorktheatreguide',
  'NYT': 'newyorktimes',
  'nytimes': 'newyorktimes',
  'NY1': 'ny1',
  'ny1': 'ny1',
  'CHTRIB': 'chicagotribune',
};

// Deduplicate by normalized outlet + critic
const uniqueReviews = new Map();

mrReviews.forEach(r => {
  const outletNorm = outletNormMap[r.outletId] || normalizeOutlet(r.outlet);
  const criticNorm = normalizeCritic(r.criticName);
  const key = `${outletNorm}-${criticNorm}`;

  if (uniqueReviews.has(key)) {
    const existing = uniqueReviews.get(key);
    // Prefer uppercase outlet IDs (they tend to be more complete)
    if (r.outletId === r.outletId.toUpperCase() && existing.outletId !== existing.outletId.toUpperCase()) {
      console.log(`REPLACING ${existing.outletId} (${existing.criticName}) with ${r.outletId} (${r.criticName})`);
      uniqueReviews.set(key, r);
    } else {
      console.log(`SKIPPING duplicate: ${r.outletId} - ${r.criticName} (keeping ${existing.outletId})`);
    }
  } else {
    uniqueReviews.set(key, r);
  }
});

const finalReviews = Array.from(uniqueReviews.values());
console.log(`\nAfter deduplication: ${finalReviews.length} reviews`);

// Update reviews.json
reviewsData.reviews = [...otherReviews, ...finalReviews];
fs.writeFileSync(reviewsPath, JSON.stringify(reviewsData, null, 2) + '\n');
console.log('Updated reviews.json');

// Clean up duplicate review-text files
console.log('\n--- Cleaning up review-text files ---');

const reviewTextFiles = fs.readdirSync(reviewTextsDir).filter(f => f.endsWith('.json'));
const seenReviewTexts = new Map();
const filesToRemove = [];

// Map critic names that are the same person
const criticAliases = {
  'rosebernardo': 'melissarosebernardo',
  'sarahholdren': 'saraholdren',
};

reviewTextFiles.forEach(f => {
  const parts = f.replace('.json', '').split('--');
  if (parts.length !== 2) {
    console.log(`Malformed filename (removing): ${f}`);
    filesToRemove.push(f);
    return;
  }

  const [outletPart, criticPart] = parts;
  const outletNorm = outletNormMap[outletPart] || normalizeOutlet(outletPart);
  let criticNorm = normalizeCritic(criticPart);

  // Apply critic aliases
  if (criticAliases[criticNorm]) {
    criticNorm = criticAliases[criticNorm];
  }

  const key = `${outletNorm}-${criticNorm}`;

  if (seenReviewTexts.has(key)) {
    const existing = seenReviewTexts.get(key);
    // Prefer uppercase outlet IDs
    if (outletPart === outletPart.toUpperCase()) {
      console.log(`Will keep ${f}, remove ${existing}`);
      filesToRemove.push(existing);
      seenReviewTexts.set(key, f);
    } else {
      console.log(`Will remove ${f}, keep ${existing}`);
      filesToRemove.push(f);
    }
  } else {
    seenReviewTexts.set(key, f);
  }
});

// Remove duplicate files
console.log('\nRemoving files:');
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
console.log(`Final reviews.json entries for moulin-rouge-2019: ${finalReviews.length}`);

// List final reviews
console.log('\nFinal reviews:');
finalReviews.forEach(r => {
  console.log(`  ${r.outletId.padEnd(20)} | ${r.criticName}`);
});
