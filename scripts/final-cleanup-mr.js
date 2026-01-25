#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const reviewsPath = path.join(__dirname, '../data/reviews.json');
const reviewTextsDir = path.join(__dirname, '../data/review-texts/moulin-rouge-2019');
const reviewsData = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));

// Fix remaining outlet IDs
const fixes = {
  'NYSR2': 'NYSR',
  'telegraph': 'TELEGRAPH',
  'theater-news-online': 'TNO',
};

reviewsData.reviews.forEach(r => {
  if (r.showId === 'moulin-rouge-2019') {
    if (fixes[r.outletId]) {
      console.log(`${r.outletId} -> ${fixes[r.outletId]}`);
      r.outletId = fixes[r.outletId];
    }
  }
});

fs.writeFileSync(reviewsPath, JSON.stringify(reviewsData, null, 2) + '\n');
console.log('Updated reviews.json');

// Rename review-text files
const fileRenames = {
  'ny-stage-review--melissa-rose-bernardo.json': 'NYSR--melissa-rose-bernardo.json',
  'theater-news-online--jeremy-gerard.json': 'TNO--jeremy-gerard.json',
};

Object.entries(fileRenames).forEach(([oldName, newName]) => {
  const oldPath = path.join(reviewTextsDir, oldName);
  const newPath = path.join(reviewTextsDir, newName);
  if (fs.existsSync(oldPath)) {
    // Also update the outletId in the file
    const data = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    data.outletId = newName.split('--')[0];
    fs.writeFileSync(newPath, JSON.stringify(data, null, 2) + '\n');
    fs.unlinkSync(oldPath);
    console.log(`Renamed: ${oldName} -> ${newName}`);
  }
});

// Create EW review-text file
const ewReview = reviewsData.reviews.find(r => r.showId === 'moulin-rouge-2019' && r.outletId === 'EW');
if (ewReview) {
  const ewPath = path.join(reviewTextsDir, 'EW--leah-greenblatt.json');
  if (!fs.existsSync(ewPath)) {
    const data = {
      showId: ewReview.showId,
      outletId: 'EW',
      outlet: ewReview.outlet,
      criticName: ewReview.criticName,
      url: ewReview.url,
      publishDate: ewReview.publishDate,
      fullText: null,
      isFullReview: false,
      bwwExcerpt: ewReview.pullQuote,
      originalScore: ewReview.originalRating,
      assignedScore: ewReview.assignedScore,
      source: 'reviews-json-stub',
      textStatus: 'missing'
    };
    fs.writeFileSync(ewPath, JSON.stringify(data, null, 2) + '\n');
    console.log('Created: EW--leah-greenblatt.json');
  }
}

// Also need to rename ny1 to NY1
const ny1Old = path.join(reviewTextsDir, 'ny1--roma-torre.json');
const ny1New = path.join(reviewTextsDir, 'NY1--roma-torre.json');
if (fs.existsSync(ny1Old)) {
  const data = JSON.parse(fs.readFileSync(ny1Old, 'utf8'));
  data.outletId = 'NY1';
  fs.writeFileSync(ny1New, JSON.stringify(data, null, 2) + '\n');
  fs.unlinkSync(ny1Old);
  console.log('Renamed: ny1--roma-torre.json -> NY1--roma-torre.json');
}

// Final count
const mr = reviewsData.reviews.filter(r => r.showId === 'moulin-rouge-2019');
const files = fs.readdirSync(reviewTextsDir).filter(f => f.endsWith('.json'));
console.log(`\nFinal: ${mr.length} reviews, ${files.length} files`);
