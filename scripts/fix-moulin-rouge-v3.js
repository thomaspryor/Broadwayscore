#!/usr/bin/env node
/**
 * Fix moulin-rouge-2019 review data v3:
 * Final cleanup - remove remaining duplicates
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

// Critic name aliases (different spellings of same person)
const criticAliases = {
  'rosebernardo': 'melissarosebernardo',
  'sarahholdren': 'saraholdren', // Sarah vs Sara
};

function normalizeCritic(name) {
  let norm = name.toLowerCase().replace(/[^a-z]/g, '');
  // Apply aliases
  if (criticAliases[norm]) {
    norm = criticAliases[norm];
  }
  return norm;
}

// Deduplicate - collect duplicates to remove
const uniqueReviews = new Map();
const toRemove = [];

mrReviews.forEach((r, i) => {
  const outletNorm = outletNormMap[r.outletId] || r.outlet.toLowerCase().replace(/[^a-z]/g, '');
  const criticNorm = normalizeCritic(r.criticName);
  const key = `${outletNorm}-${criticNorm}`;

  if (uniqueReviews.has(key)) {
    const existingIdx = uniqueReviews.get(key);
    const existing = mrReviews[existingIdx];

    // Prefer uppercase outlet IDs and keep the one with more data
    const currentIsUpper = r.outletId === r.outletId.toUpperCase();
    const existingIsUpper = existing.outletId === existing.outletId.toUpperCase();

    if (currentIsUpper && !existingIsUpper) {
      console.log(`REPLACING ${existing.outletId} with ${r.outletId} (preferring uppercase)`);
      toRemove.push(existingIdx);
      uniqueReviews.set(key, i);
    } else {
      console.log(`SKIPPING duplicate: ${r.outletId} - ${r.criticName} (keeping ${existing.outletId})`);
      toRemove.push(i);
    }
  } else {
    uniqueReviews.set(key, i);
  }
});

// Filter out duplicates
const finalReviews = mrReviews.filter((r, i) => !toRemove.includes(i));
console.log(`\nAfter deduplication: ${finalReviews.length} reviews (removed ${toRemove.length})`);

// Update reviews.json
reviewsData.reviews = [...otherReviews, ...finalReviews];
fs.writeFileSync(reviewsPath, JSON.stringify(reviewsData, null, 2) + '\n');
console.log('Updated reviews.json');

// Clean up duplicate review-text files
console.log('\n--- Cleaning up review-text files ---');

const reviewTextFiles = fs.readdirSync(reviewTextsDir).filter(f => f.endsWith('.json'));
const seenReviewTexts = new Map();
const filesToRemove = [];

reviewTextFiles.forEach(f => {
  const parts = f.replace('.json', '').split('--');
  if (parts.length !== 2) {
    console.log(`Malformed filename (removing): ${f}`);
    filesToRemove.push(f);
    return;
  }

  const [outletPart, criticPart] = parts;
  const outletNorm = outletNormMap[outletPart] || outletPart.toLowerCase().replace(/[^a-z]/g, '');
  const criticNorm = normalizeCritic(criticPart);
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
  console.log(`  ${r.outletId.padEnd(25)} | ${r.criticName.padEnd(25)} | ${r.thumb}`);
});
