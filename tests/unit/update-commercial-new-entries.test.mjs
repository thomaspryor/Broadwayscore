// applyChanges() in update-commercial-data.js adds model-proposed new entries.
// The model's slug can be a show id (the-balusters-2026) or made up; an id key
// becomes a second record for the same show that the weekly strict gate
// rejects (Sept 2026). New entries must land under the shows.json slug.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// applyChanges writes commercial.json unless --dry-run; each test file runs in
// its own process, so this only affects this file.
process.argv.push('--dry-run');
const require = createRequire(import.meta.url);
const { applyChanges } = require('../../scripts/update-commercial-data');
const { buildShowKeyIndex } = require('../../scripts/lib/commercial-slug-key');

const balusters = { id: 'the-balusters-2026', slug: 'the-balusters' };
const ragtime = { id: 'ragtime-2025', slug: 'ragtime' };
const showsBySlug = buildShowKeyIndex([balusters, ragtime]);

function fresh(shows = {}) {
  return { _meta: {}, shows: { ...shows } };
}

test('a new entry proposed under a show id is keyed by the slug', () => {
  const commercial = fresh();
  const n = applyChanges([], [{ slug: 'the-balusters-2026', confidence: 'high', data: { designation: 'Nonprofit' } }], commercial, showsBySlug);
  assert.equal(n, 1);
  assert.deepEqual(Object.keys(commercial.shows), ['the-balusters']);
});

test('no duplicate when the slug-keyed record already exists', () => {
  const commercial = fresh({ 'the-balusters': { designation: 'Nonprofit' } });
  const n = applyChanges([], [{ slug: 'the-balusters-2026', confidence: 'high', data: { designation: 'Flop' } }], commercial, showsBySlug);
  assert.equal(n, 0);
  assert.deepEqual(Object.keys(commercial.shows), ['the-balusters']);
  assert.equal(commercial.shows['the-balusters'].designation, 'Nonprofit');
});

test('a slug that matches no show is skipped', () => {
  const commercial = fresh();
  const n = applyChanges([], [{ slug: 'made-up-show', confidence: 'high', data: { designation: 'TBD' } }], commercial, showsBySlug);
  assert.equal(n, 0);
  assert.deepEqual(Object.keys(commercial.shows), []);
});

test('a real slug and low-confidence entries behave as before', () => {
  const commercial = fresh();
  const n = applyChanges([], [
    { slug: 'ragtime', confidence: 'medium', data: { designation: 'TBD' } },
    { slug: 'the-balusters', confidence: 'low', data: { designation: 'TBD' } },
  ], commercial, showsBySlug);
  assert.equal(n, 1);
  assert.deepEqual(Object.keys(commercial.shows), ['ragtime']);
});
