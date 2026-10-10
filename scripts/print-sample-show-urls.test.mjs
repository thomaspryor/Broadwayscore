/**
 * print-sample-show-urls.js (card #1919): pickRotatingWindow() rotates over
 * live sitemap-derived show slugs so lighthouse-post-deploy.yml's per-deploy
 * gate isn't pinned to /show/wicked forever, with a guaranteed fallback slug
 * when the live slug list is empty (sitemap fetch failed or returned none).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pickRotatingWindow, FALLBACK_SLUG } = require('./print-sample-show-urls.js');

const FIXTURE_SLUGS = ['bway-0', 'bway-1', 'bway-2', 'off-bway-0', 'off-bway-1', 'we-0'];

test('pickRotatingWindow returns the requested count', () => {
  const picks = pickRotatingWindow(FIXTURE_SLUGS, 2, 10);
  assert.equal(picks.length, 2);
});

test('pickRotatingWindow never exceeds the number of available slugs', () => {
  const picks = pickRotatingWindow(['only-show'], 2, 10);
  assert.equal(picks.length, 1);
});

test('pickRotatingWindow rotates across different day indexes', () => {
  const a = pickRotatingWindow(FIXTURE_SLUGS, 2, 1);
  const b = pickRotatingWindow(FIXTURE_SLUGS, 2, 2);
  assert.notDeepEqual(a, b, 'consecutive days should not always pick the identical window');
});

test('pickRotatingWindow is reproducible for the same day index', () => {
  const a = pickRotatingWindow(FIXTURE_SLUGS, 2, 5);
  const b = pickRotatingWindow(FIXTURE_SLUGS, 2, 5);
  assert.deepEqual(a, b);
});

test('pickRotatingWindow eventually surfaces every slug over consecutive days', () => {
  const seen = new Set();
  for (let day = 0; day < FIXTURE_SLUGS.length; day++) {
    for (const slug of pickRotatingWindow(FIXTURE_SLUGS, 1, day)) seen.add(slug);
  }
  assert.equal(seen.size, FIXTURE_SLUGS.length, `expected every slug visited, got ${[...seen]}`);
});

test('pickRotatingWindow falls back to the guaranteed slug when given no live slugs', () => {
  assert.deepEqual(pickRotatingWindow([], 2, 1), [FALLBACK_SLUG]);
});
