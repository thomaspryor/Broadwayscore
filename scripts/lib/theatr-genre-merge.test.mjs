import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { mergeTheatrShows, filterBroadwayCategories, fetchExtraBroadwayShows } = require('./theatr-genre-merge.js');

const billy = { id: 860, name: 'Billy Crystal', eventCategory: 'Broadway', genreCategory: 'Other' };

test('adds non-Theatre Broadway show missing from primary', () => {
  const primary = [{ id: 1, name: 'Hamilton', eventCategory: 'Broadway' }];
  const out = mergeTheatrShows(primary, [billy]);
  assert.deepEqual(out.map(r => r.id), [1, 860]);
});

test('dedupes by id, primary wins', () => {
  const p = { id: 860, name: 'primary', eventCategory: 'Broadway' };
  const out = mergeTheatrShows([p], [billy, billy]);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, 'primary');
});

test('drops non-Broadway categories, keeps Off & Off-Off', () => {
  const extra = [
    { id: 5, eventCategory: 'Touring' },
    { id: 6, eventCategory: 'Off & Off-Off Broadway' },
    { id: 7, eventCategory: 'West End' },
    null,
  ];
  assert.deepEqual(filterBroadwayCategories(extra).map(r => r.id), [6]);
  assert.deepEqual(mergeTheatrShows([], extra).map(r => r.id), [6]);
});

test('tolerates null/undefined inputs', () => {
  assert.deepEqual(mergeTheatrShows(undefined, undefined), []);
});

test('scraper wires the helper and warns-not-fails on extra query', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../scrape-theatr-audience.js', import.meta.url), 'utf8');
  assert.match(src, /require\('\.\/lib\/theatr-genre-merge'\)/);
  assert.match(src, /mergeTheatrShows\(/);
  assert.match(src, /fetchExtraBroadwayShows\(/);
});

test('one failing category warns and keeps the other; never throws', async () => {
  const warns = [];
  const out = await fetchExtraBroadwayShows(async (cat) => {
    if (cat === 'Off & Off-Off Broadway') throw new Error('boom');
    return [billy];
  }, m => warns.push(m));
  assert.deepEqual(out, [billy]);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /boom/);
});

test('all categories failing returns [] (primary results preserved)', async () => {
  const out = await fetchExtraBroadwayShows(async () => { throw new Error('x'); }, () => {});
  assert.deepEqual(mergeTheatrShows([{ id: 1 }], out), [{ id: 1 }]);
});
