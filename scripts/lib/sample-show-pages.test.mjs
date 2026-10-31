/**
 * sampleShowPages() (BRO-175, extracted for card #1919): CWV_PAGES used to
 * hardcode exactly one show page (/show/hamilton) out of ~2800 show routes.
 * These pin sampleShowPages() to pick a diverse, reproducible-per-week set
 * spanning every show category instead.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { sampleShowPages } = require('./sample-show-pages.js');

const FIXTURE_SHOWS = [
  ...Array.from({ length: 6 }, (_, i) => ({ slug: `bway-${i}`, category: 'broadway' })),
  ...Array.from({ length: 6 }, (_, i) => ({ slug: `off-bway-${i}`, category: 'off-broadway' })),
  ...Array.from({ length: 6 }, (_, i) => ({ slug: `we-${i}`, category: 'west-end' })),
  ...Array.from({ length: 6 }, (_, i) => ({ slug: `owe-${i}`, category: 'off-west-end' })),
  ...Array.from({ length: 6 }, (_, i) => ({ slug: `regional-${i}`, category: 'regional' })),
];

test('sampleShowPages picks more than one show page', () => {
  const picks = sampleShowPages(FIXTURE_SHOWS, { weekIndex: 3 });
  assert.ok(picks.length > 1, `expected a diverse sample, got ${picks.length}`);
});

test('sampleShowPages spans every category present, not just one', () => {
  const picks = sampleShowPages(FIXTURE_SHOWS, { weekIndex: 3 });
  const categories = new Set(
    picks.map(slug => FIXTURE_SHOWS.find(s => s.slug === slug).category)
  );
  assert.equal(categories.size, 5, `expected all 5 categories represented, got ${[...categories]}`);
});

test('sampleShowPages is reproducible for the same weekIndex', () => {
  const a = sampleShowPages(FIXTURE_SHOWS, { weekIndex: 7 });
  const b = sampleShowPages(FIXTURE_SHOWS, { weekIndex: 7 });
  assert.deepEqual(a, b);
});

test('sampleShowPages rotates its picks across different weekIndex values', () => {
  const a = sampleShowPages(FIXTURE_SHOWS, { weekIndex: 1 });
  const b = sampleShowPages(FIXTURE_SHOWS, { weekIndex: 2 });
  assert.notDeepEqual(a, b, 'consecutive weeks should not pick the identical sample forever');
});

test('sampleShowPages never exceeds the requested sample size', () => {
  const picks = sampleShowPages(FIXTURE_SHOWS, { weekIndex: 5, sampleSize: 10 });
  assert.ok(picks.length <= 10);
});

test('sampleShowPages returns an empty array for empty/invalid input', () => {
  assert.deepEqual(sampleShowPages([]), []);
  assert.deepEqual(sampleShowPages(null), []);
  assert.deepEqual(sampleShowPages(undefined), []);
});

test('sampleShowPages ignores shows with a non-string or missing slug', () => {
  const dirty = [...FIXTURE_SHOWS, { slug: 42, category: 'broadway' }, { category: 'broadway' }, null];
  const picks = sampleShowPages(dirty, { weekIndex: 3 });
  assert.ok(picks.every(p => typeof p === 'string'));
});

test('sampleShowPages still represents every category when categories outnumber sampleSize', () => {
  // 20 categories, one show each, sampleSize 12: perCategory floors to 1,
  // so 20 candidates are picked before de-dupe/cap — every category must
  // survive the cap rather than losing whichever sort last alphabetically.
  const manyCategories = Array.from({ length: 20 }, (_, i) => ({ slug: `show-${i}`, category: `cat-${String(i).padStart(2, '0')}` }));
  const picks = sampleShowPages(manyCategories, { weekIndex: 3, sampleSize: 12 });
  const categories = new Set(picks.map(slug => manyCategories.find(s => s.slug === slug).category));
  assert.equal(categories.size, 20, `expected all 20 categories represented, got ${categories.size}`);
});
