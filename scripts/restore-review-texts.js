#!/usr/bin/env node
/**
 * Restore missing review-text files from reviews.json data
 */
const fs = require('fs');
const path = require('path');

const reviews = require('../data/reviews.json').reviews;
const dir = path.join(__dirname, '../data/review-texts/moulin-rouge-2019');

const mr = reviews.filter(r => r.showId === 'moulin-rouge-2019');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

// Missing reviews that need files created
const missing = [
  { outletId: 'VARIETY', criticName: 'Marilyn Stasio' },
  { outletId: 'DEADLINE', criticName: 'Greg Evans' },
  { outletId: 'AMNY', criticName: 'Matt Windman' },
  { outletId: 'GUARDIAN', criticName: 'Alexis Soloski' },
  { outletId: 'MASHABLE', criticName: 'Erin Strecker' },
  { outletId: 'OBSERVER', criticName: 'David Cote' },
  { outletId: 'TELEGRAPH', criticName: 'Diane Snyder' },
];

missing.forEach(m => {
  const review = mr.find(r =>
    r.outletId.toLowerCase() === m.outletId.toLowerCase() &&
    r.criticName.toLowerCase() === m.criticName.toLowerCase()
  );

  if (!review) {
    console.log('No review found for: ' + m.outletId + ' | ' + m.criticName);
    return;
  }

  const filename = m.outletId + '--' + m.criticName.toLowerCase().replace(/\s+/g, '-') + '.json';
  const filepath = path.join(dir, filename);

  const data = {
    showId: review.showId,
    outletId: review.outletId,
    outlet: review.outlet,
    criticName: review.criticName,
    url: review.url,
    publishDate: review.publishDate,
    fullText: null,
    isFullReview: false,
    bwwExcerpt: review.pullQuote,
    originalScore: review.originalRating,
    assignedScore: review.assignedScore,
    source: review.source || 'reviews-json-stub',
    textStatus: 'missing'
  };

  fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n');
  console.log('Created: ' + filename);
});

// Also handle the-new-york-daily-news -> NYDN (Chris Jones)
// This is actually a duplicate of NYDN Joe Dziemianowicz - different critics from same outlet
// We should keep Chris Jones too as he's a different critic
const chrisJonesReview = mr.find(r => r.outletId === 'the-new-york-daily-news' && r.criticName === 'Chris Jones');
if (chrisJonesReview) {
  const filename = 'NYDN--chris-jones.json';
  const filepath = path.join(dir, filename);

  if (!fs.existsSync(filepath)) {
    const data = {
      showId: chrisJonesReview.showId,
      outletId: 'NYDN',
      outlet: 'New York Daily News',
      criticName: 'Chris Jones',
      url: chrisJonesReview.url,
      publishDate: chrisJonesReview.publishDate,
      fullText: null,
      isFullReview: false,
      bwwExcerpt: chrisJonesReview.pullQuote,
      originalScore: chrisJonesReview.originalRating,
      assignedScore: chrisJonesReview.assignedScore,
      source: chrisJonesReview.source || 'reviews-json-stub',
      textStatus: 'missing'
    };

    fs.writeFileSync(filepath, JSON.stringify(data, null, 2) + '\n');
    console.log('Created: ' + filename);
  }
}

console.log('\nDone. Files now:');
const newFiles = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
console.log('Total: ' + newFiles.length);
