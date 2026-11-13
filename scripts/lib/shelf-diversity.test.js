'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { diversifyShelves, DEFAULT_MIN_COUNT } = require('./shelf-diversity');

const shows = ids => ids.map(id => ({ id }));
const ids = shelf => shelf.shows.map(s => s.id);

test('a themed shelf pushes shows already leading an earlier shelf to the back', () => {
  const out = diversifyShelves([
    { title: 'picks', shows: shows(['ham', 'bom', 'mary', 'mhe', 'hp', 'sg']) },
    { title: 'lottery', diversify: true, shows: shows(['ham', 'bom', 'mary', 'lion', 'mhe', 'hades', 'six']) },
  ]);
  assert.deepEqual(ids(out[1]), ['lion', 'hades', 'six', 'ham', 'bom', 'mary', 'mhe']);
  assert.equal(out[1].shows.length, 7, 'nothing removed');
});

test('a ranked shelf keeps its true order but its lead cards count as seen', () => {
  const out = diversifyShelves([
    { title: 'picks', shows: shows(['ham', 'bom', 'mary', 'mhe']) },
    { title: 'box office', shows: shows(['ham', 'odc', 'lion', 'hp']) },
    { title: 'kids', diversify: true, shows: shows(['lion', 'hp', 'juliet', 'aladdin', 'wicked']) },
  ]);
  assert.deepEqual(ids(out[1]), ['ham', 'odc', 'lion', 'hp']);
  assert.deepEqual(ids(out[2]), ['juliet', 'aladdin', 'wicked', 'lion', 'hp']);
});

test('a shelf with fewer than 3 fresh shows keeps its order', () => {
  const out = diversifyShelves([
    { title: 'picks', shows: shows(['ham', 'bom', 'lion', 'chicago']) },
    { title: 'tony', diversify: true, shows: shows(['ham', 'bom', 'lion', 'chicago', 'hades', 'six']) },
  ]);
  assert.deepEqual(ids(out[1]), ['ham', 'bom', 'lion', 'chicago', 'hades', 'six']);
});

test('only the first 5 cards of an earlier shelf count as seen', () => {
  const out = diversifyShelves([
    { title: 'picks', shows: shows(['a', 'b', 'c', 'd', 'e', 'f']) },
    { title: 'rush', diversify: true, shows: shows(['f', 'a', 'x', 'y', 'z']) },
  ]);
  assert.deepEqual(ids(out[1]), ['f', 'x', 'y', 'z', 'a']);
});

test('a shelf the page hides (too few shows) does not count as seen', () => {
  const out = diversifyShelves([
    { title: 'tiny', shows: shows(['ham', 'bom', 'mary']) }, // < 4, hidden
    { title: 'opera', minCount: 2, shows: shows(['boheme', 'tosca']) }, // visible
    { title: 'lottery', diversify: true, shows: shows(['ham', 'bom', 'boheme', 'x', 'y', 'z']) },
  ]);
  assert.deepEqual(ids(out[2]), ['ham', 'bom', 'x', 'y', 'z', 'boheme']);
});

for (const [file, prop] of [['HomePageClient.tsx', 'minCount'], ['WestEndPageClient.tsx', 'minShows']]) {
  test(`DEFAULT_MIN_COUNT matches the FeaturedRow default in ${file}`, () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/components', file), 'utf8');
    const m = new RegExp(`function FeaturedRow\\([^)]*${prop} = (\\d+)`).exec(src);
    assert.ok(m, `FeaturedRow ${prop} default not found in ${file}`);
    assert.equal(Number(m[1]), DEFAULT_MIN_COUNT);
  });
}
