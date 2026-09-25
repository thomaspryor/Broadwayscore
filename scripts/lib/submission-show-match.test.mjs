// BRO-4141: issue #919 ("Thelma and Louise") was matched to "Ma" (ma-1971)
// by a raw-substring matcher and sent to manual review, while the real
// production ("Thelma & Louise: A New Musical") was missed over "&" vs "and".
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findMatchingShows } = require('./submission-show-match.js');

const SHOWS = [
  { id: 'ma-1971', title: 'Ma' },
  { id: 'thelma-and-louise-a-new-musical-off-west-end-2026', title: 'Thelma & Louise: A New Musical' },
  { id: 'golden-boy-2012', title: 'Golden Boy' },
  { id: 'golden-boy-off-west-end-2026', title: 'Golden Boy' },
  { id: 'hair-2009', title: 'Hair' },
  { id: 'hairspray-2002', title: 'Hairspray' },
  { id: 'les-miserables-2014', title: 'Les Misérables' },
];
const ids = (name) => findMatchingShows(name, SHOWS).map((s) => s.id);

test('"Thelma and Louise" finds the musical, not "Ma"', () => {
  assert.deepEqual(ids('Thelma and Louise'), ['thelma-and-louise-a-new-musical-off-west-end-2026']);
});

test('exact title returns every production with that title', () => {
  assert.deepEqual(ids('Golden Boy'), ['golden-boy-2012', 'golden-boy-off-west-end-2026']);
});

test('exact normalized match wins over partials ("Hair" is not "Hairspray")', () => {
  assert.deepEqual(ids('Hair'), ['hair-2009']);
});

test('a title that is also one production\'s slug still returns every production', () => {
  const shows = [
    { id: 'ragtime-1998', slug: 'ragtime-1998', title: 'Ragtime' },
    { id: 'ragtime-2025', slug: 'ragtime', title: 'Ragtime' },
  ];
  assert.deepEqual(findMatchingShows('Ragtime', shows).map((s) => s.id), ['ragtime-1998', 'ragtime-2025']);
});

test('slug input matches its show', () => {
  assert.deepEqual(ids('hairspray-2002'), ['hairspray-2002']);
});

test('diacritics and punctuation are normalized', () => {
  assert.deepEqual(ids('Les Miserables'), ['les-miserables-2014']);
});

test('a short title only matches as a whole word, never inside another word', () => {
  assert.deepEqual(ids('Thelma'), ['thelma-and-louise-a-new-musical-off-west-end-2026']);
  assert.deepEqual(ids('Mama Mia'), []);
});

test('empty input matches nothing', () => {
  assert.deepEqual(ids(''), []);
  assert.deepEqual(ids(null), []);
});
