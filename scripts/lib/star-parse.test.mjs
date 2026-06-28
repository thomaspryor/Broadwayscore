import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseStar } = require('./star-parse.js');

test('N/M ratings', () => {
  assert.equal(parseStar('5/5').score, 100);
  assert.equal(parseStar('4/5 stars').score, 80);
  assert.equal(parseStar('3/5').score, 60);
  assert.equal(parseStar('3.5/5 stars').score, 70);
  assert.equal(parseStar('2/5').score, 40);
  assert.equal(parseStar('8/10').score, 80);
});

test('glyph stars + half', () => {
  assert.equal(parseStar('★★★').score, 60);
  assert.equal(parseStar('★★★★★').score, 100);
  assert.equal(parseStar('★★★½').score, 70);
});

test('word + "out of" forms', () => {
  assert.equal(parseStar('Three stars').score, 60);
  assert.equal(parseStar('4 out of 5').score, 80);
  assert.equal(parseStar('three out of five').score, 60);
  assert.equal(parseStar('four and a half stars').score, 90);
});

test('letter grades', () => {
  assert.equal(parseStar('B+').score, 85);
  assert.equal(parseStar('A').score, 95);
});

test('null when unparseable / out of range', () => {
  assert.equal(parseStar(''), null);
  assert.equal(parseStar(null), null);
  assert.equal(parseStar('a glowing review'), null);
  assert.equal(parseStar('6/5'), null); // impossible
});

test('returns stars + outOf for star ratings', () => {
  const r = parseStar('3/5');
  assert.equal(r.stars, 3);
  assert.equal(r.outOf, 5);
});
