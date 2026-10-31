// BRO-6516 acceptance: >=300 UK regional productions (Jan 2024 on) are in shows.json with a city;
// each is scoreable (3+ scored reviews, or 5 if all T3 via hasEnoughReviews) or listed as below-bar.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { coverage } = require('./uk-regional-coverage.js');
const { loadReviewsWithBlog } = require('./lib/load-reviews-with-blog');
const raw = require('../data/shows.json');
const reg = require('../data/outlet-registry.json');

test('at least 300 UK regional productions with a city, each scoreable or listed below-bar', () => {
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const { cities, total, belowBar } = coverage(shows, loadReviewsWithBlog(), reg.outlets || reg);
  assert.ok(total.shows >= 300, `${total.shows} UK regional productions < 300`);
  assert.equal(cities.unknown, undefined, 'UK regional rows missing a city');
  assert.equal(new Set(belowBar.map((b) => b.id)).size, belowBar.length, 'duplicate below-bar ids');
  assert.ok(belowBar.every((b) => shows.some((s) => s.id === b.id && s.city)), 'below-bar row not in shows.json with a city');
});
