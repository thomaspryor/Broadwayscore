#!/usr/bin/env node
const reviews = require('../data/reviews.json').reviews;
const fs = require('fs');
const path = require('path');

const mr = reviews.filter(r => r.showId === 'moulin-rouge-2019');
const dir = './data/review-texts/moulin-rouge-2019';
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

console.log('Reviews in reviews.json: ' + mr.length);
console.log('Files in directory: ' + files.length);
console.log('\nReviews without matching files:');

mr.forEach(r => {
  const criticSlug = r.criticName.toLowerCase().replace(/\s+/g, '-');

  const hasFile = files.some(f => {
    const fnorm = f.toLowerCase();
    return fnorm.includes(criticSlug) || fnorm.includes(r.outletId.toLowerCase());
  });

  if (!hasFile) {
    console.log('  Missing: ' + r.outletId + ' | ' + r.criticName);
  }
});
