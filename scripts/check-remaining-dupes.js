#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'reviews.json'), 'utf8'));
const reviews = data.reviews;

const shows = [
  'the-great-gatsby-2024',
  'stranger-things-2024',
  'mamma-mia-2025'
];

shows.forEach(showId => {
  console.log(`\n=== ${showId} ===`);
  const showReviews = reviews.filter(r => r.showId === showId);
  console.log(`Total reviews: ${showReviews.length}`);

  // Check for NY Stage Review duplicates
  const nysr = showReviews.filter(r => r.outlet && (r.outlet.includes('Stage') || r.outlet.includes('NYSR')));
  if (nysr.length > 1) {
    console.log(`NY Stage Review reviews (${nysr.length}):`);
    nysr.forEach(r => {
      console.log(`  - ${r.criticName} | ${r.url}`);
    });

    // Check for duplicate URLs
    const urls = nysr.map(r => r.url);
    const uniqueUrls = [...new Set(urls)];
    if (urls.length !== uniqueUrls.length) {
      console.log(`  ** DUPLICATES FOUND **`);
    }
  }

  // Check for Entertainment Weekly duplicates
  const ew = showReviews.filter(r => r.outlet && r.outlet.includes('Entertainment'));
  if (ew.length > 1) {
    console.log(`Entertainment Weekly reviews (${ew.length}):`);
    ew.forEach(r => {
      console.log(`  - ${r.criticName} | ${r.url}`);
    });

    const urls = ew.map(r => r.url);
    const uniqueUrls = [...new Set(urls)];
    if (urls.length !== uniqueUrls.length) {
      console.log(`  ** DUPLICATES FOUND **`);
    }
  }
});
