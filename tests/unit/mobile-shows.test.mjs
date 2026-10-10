import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MAX_CLOSED_WITHOUT_REVIEWS,
  buildShowsWithScores,
  findClosedShowsWithoutScores,
} = require('../../scripts/lib/mobile-shows-validator.js');

test('buildShowsWithScores includes only showIds with a non-null assignedScore', () => {
  const reviews = [
    { showId: 'a', assignedScore: 85 },
    { showId: 'b', assignedScore: null },
    { showId: 'c' },
  ];
  const set = buildShowsWithScores(reviews);
  assert.equal(set.has('a'), true);
  assert.equal(set.has('b'), false);
  assert.equal(set.has('c'), false);
});

test('findClosedShowsWithoutScores flags closed shows missing from showsWithScores', () => {
  const mobileShows = [
    { id: 'scored-closed', st: 'closed' },
    { id: 'unscored-closed', st: 'closed' },
    { id: 'unscored-open', st: 'open' },
  ];
  const showsWithScores = new Set(['scored-closed']);
  const result = findClosedShowsWithoutScores(mobileShows, showsWithScores);
  assert.deepEqual(result.map(s => s.id), ['unscored-closed']);
});

test('findClosedShowsWithoutScores ignores non-closed shows regardless of scores', () => {
  const mobileShows = [
    { id: 'previews-show', st: 'previews' },
    { id: 'open-show', st: 'open' },
  ];
  const result = findClosedShowsWithoutScores(mobileShows, new Set());
  assert.deepEqual(result, []);
});

test('findClosedShowsWithoutScores returns empty when every closed show has a score', () => {
  const mobileShows = [
    { id: 'a', st: 'closed' },
    { id: 'b', st: 'closed' },
  ];
  const showsWithScores = new Set(['a', 'b']);
  assert.deepEqual(findClosedShowsWithoutScores(mobileShows, showsWithScores), []);
});

test('MAX_CLOSED_WITHOUT_REVIEWS is the documented threshold used by the CI gate', () => {
  assert.equal(MAX_CLOSED_WITHOUT_REVIEWS, 5);
});

test('regression guard: current mobile-shows.json + reviews.json stay within threshold', () => {
  const fs = require('fs');
  const path = require('path');
  const { fileURLToPath } = require('url');
  const dirname = path.dirname(fileURLToPath(import.meta.url));
  const mobilePath = path.join(dirname, '..', '..', 'public', 'data', 'mobile-shows.json');
  const reviewsPath = path.join(dirname, '..', '..', 'data', 'reviews.json');

  if (!fs.existsSync(mobilePath) || !fs.existsSync(reviewsPath)) {
    return; // pre-build / no local data — same skip behavior as validate-mobile-shows.js
  }

  const mobile = JSON.parse(fs.readFileSync(mobilePath, 'utf8'));
  const reviewsRaw = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  const reviews = reviewsRaw.reviews || reviewsRaw;
  const reviewArr = Array.isArray(reviews) ? reviews : Object.values(reviews);

  const showsWithScores = buildShowsWithScores(reviewArr);
  const closedWithoutReviews = findClosedShowsWithoutScores(mobile.shows || [], showsWithScores);

  assert.ok(
    closedWithoutReviews.length <= MAX_CLOSED_WITHOUT_REVIEWS,
    `mobile-shows.json has ${closedWithoutReviews.length} closed shows without scored reviews ` +
      `(max ${MAX_CLOSED_WITHOUT_REVIEWS}): ${closedWithoutReviews.slice(0, 20).map(s => s.id).join(', ')}`
  );
});
