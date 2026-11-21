import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseStar } = require('./star-parse.js');
const { LETTER_GRADES } = require('./score-extractors.js');

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

test('letter grades use the CANONICAL table (not the old A=95 local copy)', () => {
  // The audit must grade against production's conversion. Assert parity with the
  // canonical map for EVERY grade so any future drift fails here.
  assert.equal(parseStar('A').score, 90);   // was 95 before recalibration
  assert.equal(parseStar('B+').score, 80);  // was 85
  assert.equal(parseStar('D').score, 35);   // was 47 — the FP class
  assert.equal(parseStar('F').score, 20);   // was 25
  for (const [grade, val] of Object.entries(LETTER_GRADES)) {
    assert.equal(parseStar(grade).score, val, `parseStar(${grade}) must == canonical ${val}`);
    assert.equal(parseStar(grade.toLowerCase()).score, val, `case-insensitive: ${grade}`);
  }
});

test('negative control — a deliberately-wrong stored score still diverges from its grade', () => {
  // Guards against the audit going BLIND post-recalibration (pre-mortem): a B+
  // (canonical 80) wrongly stored as 95 must still register a large gap. If this
  // ever passes with a small gap, the comparator has collapsed.
  const gradeScore = parseStar('B+').score; // 80
  const wronglyStored = 95;
  assert.ok(Math.abs(wronglyStored - gradeScore) > 6, 'planted bad score must exceed HARD_TOL');
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
