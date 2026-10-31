#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');

// Read reviews.json
console.log('Reading reviews.json...');
const data = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
const reviews = data.reviews;
const originalCount = reviews.length;
console.log(`Total reviews: ${originalCount}\n`);

let fixedScores = 0;
let deletedWrongProduction = 0;
let deletedDuplicates = 0;

// TASK 1: Fix Rating Conversion Bugs
console.log('=== TASK 1: Fix Rating Conversion Bugs ===');

// 1. Cabaret - Sara Holdren - Rave should be 90
const cabaretSara = reviews.find(r =>
  r.showId === 'cabaret-2024' &&
  r.outlet === 'Vulture' &&
  r.criticName === 'Sara Holdren' &&
  r.originalRating === 'Rave'
);
if (cabaretSara && cabaretSara.assignedScore === 72) {
  console.log(`✓ Fixing Cabaret - Sara Holdren: 72 → 90`);
  cabaretSara.assignedScore = 90;
  cabaretSara.bucket = 'Rave';
  fixedScores++;
}

// 2. Oedipus - Johnny Oleksinski - 3.5/4 should be 88
const oedipusJohnny = reviews.find(r =>
  r.showId === 'oedipus-2025' &&
  r.outlet === 'New York Post' &&
  r.criticName === 'Johnny Oleksinski' &&
  r.publishDate === '2025-11-13'
);
if (oedipusJohnny) {
  console.log(`✓ Fixing Oedipus - Johnny Oleksinski: ${oedipusJohnny.assignedScore} → 88`);
  oedipusJohnny.assignedScore = 88;
  oedipusJohnny.bucket = 'Rave';
  fixedScores++;
}

// 3. Wicked - Clive Barnes - 2.5/4 should be 63
const wickedClive = reviews.find(r =>
  r.showId === 'wicked-2003' &&
  r.outlet === 'New York Post' &&
  r.criticName === 'Clive Barnes' &&
  r.publishDate === '2003-10-30'
);
if (wickedClive && wickedClive.assignedScore === 55) {
  console.log(`✓ Fixing Wicked - Clive Barnes: 55 → 63`);
  wickedClive.assignedScore = 63;
  wickedClive.bucket = 'Positive';
  fixedScores++;
}

// 4. The Notebook - Emlyn Travis - B+ should be 82
const notebookEmlyn = reviews.find(r =>
  r.showId === 'the-notebook-2024' &&
  r.outlet === 'Entertainment Weekly' &&
  r.criticName === 'Emlyn Travis' &&
  r.publishDate === '2024-03-14' &&
  r.originalRating === 'B+'
);
if (notebookEmlyn && notebookEmlyn.assignedScore === 72) {
  console.log(`✓ Fixing The Notebook - Emlyn Travis: 72 → 82`);
  notebookEmlyn.assignedScore = 82;
  notebookEmlyn.bucket = 'Positive';
  fixedScores++;
}

// 5. Back to the Future - Dalton Ross - B should be 80
const bttfDalton = reviews.find(r =>
  r.showId === 'back-to-the-future-2023' &&
  r.outlet === 'Entertainment Weekly' &&
  r.criticName === 'Dalton Ross' &&
  r.publishDate === '2023-08-03' &&
  r.originalRating === 'B'
);
if (bttfDalton && bttfDalton.assignedScore === 67) {
  console.log(`✓ Fixing Back to the Future - Dalton Ross: 67 → 80`);
  bttfDalton.assignedScore = 80;
  bttfDalton.bucket = 'Positive';
  fixedScores++;
}

console.log(`\nFixed ${fixedScores}/5 rating conversion bugs\n`);

// TASK 2: Remove Wrong Production Reviews
console.log('=== TASK 2: Remove Wrong Production Reviews ===');

// Harry Potter - reviews from 2018 (show opened 2021)
const harryPotterWrong = [
  { outlet: 'Time Out', criticName: 'Adam Feldman', publishDate: '2018-04-22' },
  { outlet: 'Entertainment Weekly', criticName: 'Marc Snetiker', publishDate: '2018-04-22' },
  { outlet: 'The Guardian', criticName: 'Alexis Soloski', publishDate: '2018-04-22' }
];

harryPotterWrong.forEach(({ outlet, criticName, publishDate }) => {
  const idx = reviews.findIndex(r =>
    r.showId === 'harry-potter-cursed-child-2021' &&
    r.outlet === outlet &&
    r.criticName === criticName &&
    r.publishDate === publishDate
  );
  if (idx >= 0) {
    console.log(`✓ Deleting Harry Potter - ${outlet} - ${criticName} (2018)`);
    reviews.splice(idx, 1);
    deletedWrongProduction++;
  }
});

// Mamma Mia - reviews from 2025-01-08 (show opened 2025-08-14)
const mammaMiaWrong = [
  { outlet: 'New York Post', criticName: 'Johnny Oleksinski', publishDate: '2025-01-08' },
  { outlet: 'Culture Sauce', criticName: 'Thom Geier', publishDate: '2025-01-08' }
];

mammaMiaWrong.forEach(({ outlet, criticName, publishDate }) => {
  const idx = reviews.findIndex(r =>
    r.showId === 'mamma-mia-2025' &&
    r.outlet === outlet &&
    r.criticName === criticName &&
    r.publishDate === publishDate
  );
  if (idx >= 0) {
    console.log(`✓ Deleting Mamma Mia - ${outlet} - ${criticName} (2025-01-08)`);
    reviews.splice(idx, 1);
    deletedWrongProduction++;
  }
});

console.log(`\nDeleted ${deletedWrongProduction}/5 wrong production reviews\n`);

// TASK 3: Remove Duplicate Reviews
console.log('=== TASK 3: Remove Duplicate Reviews ===');

// Function to find and remove duplicates by URL for a show/outlet
function removeDuplicatesByUrl(showId, outlet) {
  const showReviews = reviews.filter(r => r.showId === showId && r.outlet === outlet);
  const urlMap = new Map();
  const toDelete = [];

  showReviews.forEach((review, idx) => {
    if (review.url) {
      if (urlMap.has(review.url)) {
        // Found duplicate - decide which to keep
        const existing = urlMap.get(review.url);
        // Keep the one with more data (pullQuote, or named critic)
        if (review.pullQuote && !existing.pullQuote) {
          toDelete.push(existing);
          urlMap.set(review.url, review);
        } else {
          toDelete.push(review);
        }
      } else {
        urlMap.set(review.url, review);
      }
    }
  });

  return toDelete;
}

// The Notebook duplicates
const notebookDupes = removeDuplicatesByUrl('the-notebook-2024', 'IndieWire')
  .concat(removeDuplicatesByUrl('the-notebook-2024', 'New York Theatre Guide'));
notebookDupes.forEach(review => {
  const idx = reviews.indexOf(review);
  if (idx >= 0) {
    console.log(`✓ Deleting The Notebook duplicate - ${review.outlet} - ${review.criticName}`);
    reviews.splice(idx, 1);
    deletedDuplicates++;
  }
});

// Two Strangers duplicates
const twoStrangersDupes = removeDuplicatesByUrl('two-strangers-bway-2025', 'New York Stage Review');
twoStrangersDupes.forEach(review => {
  const idx = reviews.indexOf(review);
  if (idx >= 0) {
    console.log(`✓ Deleting Two Strangers duplicate - ${review.outlet} - ${review.criticName}`);
    reviews.splice(idx, 1);
    deletedDuplicates++;
  }
});

// The Great Gatsby duplicates
const gatsbyDupes = removeDuplicatesByUrl('great-gatsby-bway-2024', 'New York Stage Review');
gatsbyDupes.forEach(review => {
  const idx = reviews.indexOf(review);
  if (idx >= 0) {
    console.log(`✓ Deleting The Great Gatsby duplicate - ${review.outlet} - ${review.criticName}`);
    reviews.splice(idx, 1);
    deletedDuplicates++;
  }
});

// & Juliet duplicates
const julietDupes = removeDuplicatesByUrl('and-juliet-2022', 'New York Stage Review');
julietDupes.forEach(review => {
  const idx = reviews.indexOf(review);
  if (idx >= 0) {
    console.log(`✓ Deleting & Juliet duplicate - ${review.outlet} - ${review.criticName}`);
    reviews.splice(idx, 1);
    deletedDuplicates++;
  }
});

// Stranger Things duplicates
const strangerThingsDupes = removeDuplicatesByUrl('stranger-things-2025', 'New York Stage Review');
strangerThingsDupes.forEach(review => {
  const idx = reviews.indexOf(review);
  if (idx >= 0) {
    console.log(`✓ Deleting Stranger Things duplicate - ${review.outlet} - ${review.criticName}`);
    reviews.splice(idx, 1);
    deletedDuplicates++;
  }
});

// Mamma Mia duplicates
const mammaMiaDupes = removeDuplicatesByUrl('mamma-mia-2025', 'New York Stage Review')
  .concat(removeDuplicatesByUrl('mamma-mia-2025', 'Entertainment Weekly'));
mammaMiaDupes.forEach(review => {
  const idx = reviews.indexOf(review);
  if (idx >= 0) {
    console.log(`✓ Deleting Mamma Mia duplicate - ${review.outlet} - ${review.criticName}`);
    reviews.splice(idx, 1);
    deletedDuplicates++;
  }
});

// Operation Mincemeat duplicates
const opMincemeatDupes = removeDuplicatesByUrl('operation-mincemeat-2025', 'New York Stage Review');
opMincemeatDupes.forEach(review => {
  const idx = reviews.indexOf(review);
  if (idx >= 0) {
    console.log(`✓ Deleting Operation Mincemeat duplicate - ${review.outlet} - ${review.criticName}`);
    reviews.splice(idx, 1);
    deletedDuplicates++;
  }
});

console.log(`\nDeleted ${deletedDuplicates}/8 duplicate reviews\n`);

// Write back to file
console.log('=== Writing Updated Reviews ===');
data.reviews = reviews;
fs.writeFileSync(REVIEWS_PATH, JSON.stringify(data, null, 2));
console.log(`✓ Wrote ${reviews.length} reviews (was ${originalCount})`);
console.log(`✓ Removed ${originalCount - reviews.length} total reviews\n`);

console.log('=== SUMMARY ===');
console.log(`Rating conversion bugs fixed: ${fixedScores}/5`);
console.log(`Wrong production reviews deleted: ${deletedWrongProduction}/5`);
console.log(`Duplicate reviews deleted: ${deletedDuplicates}/8`);
console.log(`Total critical errors fixed: ${fixedScores + deletedWrongProduction + deletedDuplicates}`);
