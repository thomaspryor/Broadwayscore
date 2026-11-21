// BRO-2517: backfill-cast-web.js --show-filter accepts a comma-separated list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { selectShowsByFilter } = require('./lib/cast-show-filter.js');

const SHOWS = [
  { id: 'a-off-broadway-2026', slug: 'a' },
  { id: 'b-off-broadway-2026', slug: 'b' },
  { id: 'c-west-end-2026', slug: 'c' },
];

test('a single id still selects exactly that show', () => {
  const r = selectShowsByFilter(SHOWS, 'a-off-broadway-2026');
  assert.deepEqual(r.matched.map((s) => s.id), ['a-off-broadway-2026']);
  assert.deepEqual(r.missing, []);
});

test('a comma-separated list selects each show, by id or slug', () => {
  const r = selectShowsByFilter(SHOWS, 'a-off-broadway-2026,c');
  assert.deepEqual(r.matched.map((s) => s.id), ['a-off-broadway-2026', 'c-west-end-2026']);
});

test('whitespace, empty items and duplicates are ignored', () => {
  const r = selectShowsByFilter(SHOWS, ' b , ,b,');
  assert.deepEqual(r.matched.map((s) => s.id), ['b-off-broadway-2026']);
  assert.deepEqual(r.wanted, ['b']);
});

test('unknown ids are reported as missing and the rest still match', () => {
  const r = selectShowsByFilter(SHOWS, 'a,nope');
  assert.deepEqual(r.matched.map((s) => s.id), ['a-off-broadway-2026']);
  assert.deepEqual(r.missing, ['nope']);
});

test('nothing matched: single unknown id and an empty value both come back empty', () => {
  assert.equal(selectShowsByFilter(SHOWS, 'nope').matched.length, 0);
  assert.equal(selectShowsByFilter(SHOWS, '').matched.length, 0);
  assert.equal(selectShowsByFilter(undefined, 'a').matched.length, 0);
});
