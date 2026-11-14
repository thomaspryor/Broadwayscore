/**
 * Tests for scripts/lib/cross-show-images.js (BRO-4380)
 * Run: node --test scripts/lib/cross-show-images.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const {
  crossShowImageProblems, findCrossShowImages, stripCrossShowImages, pickOwnProductionPhotoFallback, lineageIds,
} = require('./cross-show-images.js');

const img = (id, f = 'thumbnail.jpg') => `/images/shows/${id}/${f}`;

test('flags a thumbnail under an unrelated show id (the PHYL/BOCKING case)', () => {
  const shows = [
    { id: 'bocking-off-broadway-2026', images: { thumbnail: img('bocking-off-broadway-2026') } },
    { id: 'phyl-off-broadway-2026', images: { thumbnail: img('bocking-off-broadway-2026'), poster: img('phyl-off-broadway-2026', 'poster.jpg') } },
  ];
  const found = findCrossShowImages(shows, {});
  assert.deepEqual(found, [{ id: 'phyl-off-broadway-2026', problems: [{ key: 'thumbnail', path: img('bocking-off-broadway-2026'), owner: 'bocking-off-broadway-2026' }] }]);
});

test('own paths, remote URLs and nulls pass', () => {
  const s = { id: 'a', images: { thumbnail: img('a'), poster: 'https://cdn.example/x.jpg', hero: null, _tmp: img('b') } };
  assert.deepEqual(crossShowImageProblems(s, [s], {}), []);
});

test('an id that is a prefix of another is still a different show', () => {
  const s = { id: 'wicked', images: { thumbnail: img('wicked-2003') } };
  assert.equal(crossShowImageProblems(s, [s], {}).length, 1);
});

test('transferredTo, transitive tourParent and tourOf links allow sharing', () => {
  const shows = [
    { id: 'pa-2026', category: 'broadway' },
    { id: 'pa-tour-2025', transferredTo: 'pa-2026' },
    { id: 'pa-chicago-2025', tourParent: 'pa-tour-2025', images: { poster: img('pa-2026', 'poster.webp') } },
    { id: 'x-tour', tourOf: 'pa-2026', images: { thumbnail: img('pa-2026') } },
  ];
  assert.deepEqual(findCrossShowImages(shows, {}), []);
  assert.ok(lineageIds('pa-chicago-2025', shows).has('pa-2026'));
});

test('allowlist permits only the named owner', () => {
  const allow = { a: { owner: 'b', reason: 'test' } };
  assert.deepEqual(crossShowImageProblems({ id: 'a', images: { thumbnail: img('b') } }, [], allow), []);
  assert.equal(crossShowImageProblems({ id: 'a', images: { thumbnail: img('c') } }, [], allow).length, 1);
});

test('stripCrossShowImages nulls only the foreign path and does not mutate input', () => {
  const images = { thumbnail: img('other'), poster: img('me', 'poster.jpg') };
  const { images: out, dropped } = stripCrossShowImages('me', images, [], {});
  assert.deepEqual(out, { thumbnail: null, poster: img('me', 'poster.jpg') });
  assert.equal(dropped.length, 1);
  assert.equal(images.thumbnail, img('other'));
});

test('last-resort fallback: never another show\'s entry, and a copy not the shared object', () => {
  const jackals = { showId: 'jackals', images: { thumbnail: img('jackals') }, bufSize: 9000 };
  const fallbacks = [jackals];
  assert.equal(pickOwnProductionPhotoFallback(fallbacks, 'van-man'), null);
  fallbacks.push({ showId: 'van-man', images: { thumbnail: img('van-man') }, bufSize: 9000 });
  const got = pickOwnProductionPhotoFallback(fallbacks, 'van-man');
  assert.equal(got.images.thumbnail, img('van-man'));
  got.images.poster = 'x';
  assert.equal(fallbacks[1].images.poster, undefined);
});

test('tours are left to tour-family.js (same-title Broadway art is allowed there)', () => {
  const tour = { id: 'x-tour', category: 'tour', images: { thumbnail: img('x-revival-2019') } };
  assert.deepEqual(crossShowImageProblems(tour, [tour], {}), []);
});

test('tours of any market are left to tourImageProblems (BRO-4931): off-broadway parent art passes there, foreign art does not', () => {
  const { tourImageProblems } = require('./tour-family.js');
  const parent = { id: 'x-off-broadway-2025', title: 'X', category: 'off-broadway' };
  const tour = { id: 'x-tour-2026', title: 'X', category: 'tour', tourOf: parent.id, images: { thumbnail: img(parent.id) } };
  const shows = [parent, tour];
  assert.deepEqual(crossShowImageProblems(tour, shows, {}), [], 'delegated, not double-reported');
  assert.deepEqual(tourImageProblems(tour, shows), []);
  const foreign = { ...tour, images: { thumbnail: img('y-2019') } };
  assert.deepEqual(crossShowImageProblems(foreign, [parent, foreign], {}), []);
  assert.equal(tourImageProblems(foreign, [parent, foreign]).length, 1);
});

test('baseline is empty: every cross-show path fails validate-data', () => {
  const { CROSS_SHOW_IMAGES_BASELINE } = require('./cross-show-images.js');
  assert.equal(CROSS_SHOW_IMAGES_BASELINE.size, 0);
});

test('the fetcher wires the per-show picker and the applyImages guard', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../fetch-show-images-auto.js', import.meta.url), 'utf8');
  assert.match(src, /pickOwnProductionPhotoFallback\(verifyCtx\.productionPhotoFallbacks, show\.id\)/);
  assert.doesNotMatch(src, /productionPhotoFallbacks\[0\]/);
  assert.match(src, /stripCrossShowImages\(show\.id,/);
});
