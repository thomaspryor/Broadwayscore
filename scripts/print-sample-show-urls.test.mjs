/**
 * print-sample-show-urls.js (card #1919): pickRotatingShowSlugs() windows
 * over sampleShowPages()'s picks so lighthouse-post-deploy.yml's per-deploy
 * gate isn't pinned to /show/wicked forever.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickRotatingShowSlugs } = require('./print-sample-show-urls.js');

const FIXTURE_SHOWS = [
  ...Array.from({ length: 6 }, (_, i) => ({ slug: `bway-${i}`, category: 'broadway' })),
  ...Array.from({ length: 6 }, (_, i) => ({ slug: `off-bway-${i}`, category: 'off-broadway' })),
  ...Array.from({ length: 6 }, (_, i) => ({ slug: `we-${i}`, category: 'west-end' })),
];

test('pickRotatingShowSlugs returns the requested count', () => {
  const picks = pickRotatingShowSlugs(FIXTURE_SHOWS, 2, 10);
  assert.equal(picks.length, 2);
});

test('pickRotatingShowSlugs never exceeds the number of available picks', () => {
  const tiny = [{ slug: 'only-show', category: 'broadway' }];
  const picks = pickRotatingShowSlugs(tiny, 2, 10);
  assert.equal(picks.length, 1);
});

test('pickRotatingShowSlugs rotates across different day indexes', () => {
  const a = pickRotatingShowSlugs(FIXTURE_SHOWS, 2, 1);
  const b = pickRotatingShowSlugs(FIXTURE_SHOWS, 2, 2);
  assert.notDeepEqual(a, b, 'consecutive days should not always pick the identical window');
});

test('pickRotatingShowSlugs is reproducible for the same day index', () => {
  const a = pickRotatingShowSlugs(FIXTURE_SHOWS, 2, 5);
  const b = pickRotatingShowSlugs(FIXTURE_SHOWS, 2, 5);
  assert.deepEqual(a, b);
});

test('pickRotatingShowSlugs eventually surfaces more than one category over consecutive days', () => {
  const categoriesSeen = new Set();
  for (let day = 0; day < 30; day++) {
    const picks = pickRotatingShowSlugs(FIXTURE_SHOWS, 2, day);
    for (const slug of picks) {
      const show = FIXTURE_SHOWS.find(s => s.slug === slug);
      categoriesSeen.add(show.category);
    }
  }
  assert.ok(categoriesSeen.size > 1, `expected multiple categories over time, got ${[...categoriesSeen]}`);
});

test('pickRotatingShowSlugs returns an empty array for no eligible shows', () => {
  assert.deepEqual(pickRotatingShowSlugs([], 2, 1), []);
});
