#!/usr/bin/env node
/**
 * Pure decision logic for validate-mobile-shows.js.
 * Extracted so the "closed shows without scored reviews" guard can be
 * unit-tested without needing real shows.json/reviews.json/mobile-shows.json.
 */

// Closed shows without any scored review in reviews.json should never appear
// in mobile-shows.json — the visibility filter requires showsWithScores.
// A small number (threshold) allows for race conditions during builds.
const MAX_CLOSED_WITHOUT_REVIEWS = 5;

// Mirrors the showsWithScores set generate-mobile-data.js's visibility
// filter uses: any review with a non-null assignedScore makes a show visible.
function buildShowsWithScores(reviewArr) {
  const showsWithScores = new Set();
  for (const r of reviewArr) {
    if (r.assignedScore != null) showsWithScores.add(r.showId);
  }
  return showsWithScores;
}

// The visibility filter itself: showsWithScores.has(show.id) || show.status !== 'closed'.
// So every closed show in mobile MUST have a scored review in reviews.json —
// this returns the ones that don't (stale build artifacts).
function findClosedShowsWithoutScores(mobileShows, showsWithScores) {
  return mobileShows
    .filter(s => s.st === 'closed')
    .filter(s => !showsWithScores.has(s.id));
}

module.exports = {
  MAX_CLOSED_WITHOUT_REVIEWS,
  buildShowsWithScores,
  findClosedShowsWithoutScores,
};
