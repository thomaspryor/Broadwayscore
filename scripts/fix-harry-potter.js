#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const REVIEWS_PATH = path.join(__dirname, '..', 'data', 'reviews.json');

console.log('Reading reviews.json...');
const data = JSON.parse(fs.readFileSync(REVIEWS_PATH, 'utf8'));
const reviews = data.reviews;
const originalCount = reviews.length;
console.log(`Total reviews: ${originalCount}\n`);

let deletedCount = 0;

console.log('=== Fixing Harry Potter Wrong Production Reviews ===\n');

// Delete the 3 reviews from 2018 (San Francisco production)
const toDelete = [
  { outlet: 'Time Out', criticName: 'Adam Feldman', publishDate: '2018-04-22T20:11:20-04:00' },
  { outlet: 'Entertainment Weekly', criticName: 'Marc Snetiker', publishDate: '2018-04-22T20:11:20-04:00' },
  { outlet: 'The Guardian', criticName: 'Alexis Soloski', publishDate: '2018-04-22T20:11:20-04:00' }
];

toDelete.forEach(({ outlet, criticName, publishDate }) => {
  const idx = reviews.findIndex(r =>
    r.showId === 'harry-potter-2021' &&
    r.outlet === outlet &&
    r.criticName === criticName &&
    r.publishDate === publishDate
  );
  if (idx >= 0) {
    console.log(`✓ Deleting: ${outlet} - ${criticName} (2018)`);
    reviews.splice(idx, 1);
    deletedCount++;
  } else {
    console.log(`✗ NOT FOUND: ${outlet} - ${criticName}`);
  }
});

// Write back to file
console.log('\n=== Writing Updated Reviews ===');
data.reviews = reviews;
fs.writeFileSync(REVIEWS_PATH, JSON.stringify(data, null, 2));
console.log(`✓ Wrote ${reviews.length} reviews (was ${originalCount})`);
console.log(`✓ Removed ${deletedCount} reviews\n`);

console.log('=== SUMMARY ===');
console.log(`Harry Potter wrong production reviews deleted: ${deletedCount}/3`);
