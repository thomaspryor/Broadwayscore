// Tests for stale-slot-squatters.js (BRO-5501).
// Run: node --test scripts/lib/stale-slot-squatters.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findDroppedByWrongTwin, findStaleSlotSquatters, normalizeUrl } = require('./stale-slot-squatters.js');

const long = (s) => (s + ' ').repeat(80);
const files = (...a) => a.map(([file, data]) => ({ file, data }));

test('good review pointing at a wrongProduction twin with different text is reported', () => {
  const out = findDroppedByWrongTwin(files(
    ['standard--unknown.json', { duplicateOf: 'standard--nick-curtis.json', fullText: long('Kristin Scott Thomas is magnificent') }],
    ['standard--nick-curtis.json', { wrongProduction: true, fullText: long('Revelatory Benedict Andrews') }],
  ));
  assert.equal(out.length, 1);
  assert.equal(out[0].file, 'standard--unknown.json');
  assert.equal(out[0].twinFlag, 'wrongProduction');
});

test('a true second copy of the bad text, a cleared inheritance and a short stub are not reported', () => {
  const bad = long('Revelatory Benedict Andrews');
  assert.equal(findDroppedByWrongTwin(files(
    ['a.json', { duplicateOf: 'b.json', fullText: bad }], ['b.json', { wrongProduction: true, fullText: bad }])).length, 0);
  assert.equal(findDroppedByWrongTwin(files(
    ['a.json', { duplicateOf: 'b.json', duplicateOfFlagInheritanceCleared: true, fullText: long('x y z') }],
    ['b.json', { wrongProduction: true, fullText: bad }])).length, 0);
  assert.equal(findDroppedByWrongTwin(files(
    ['a.json', { duplicateOf: 'b.json', fullText: 'short' }], ['b.json', { wrongProduction: true, fullText: bad }])).length, 0);
});

test('old wrongProduction text under a url no other show owns is a squatter', () => {
  const f = files(['timeout-london--andrzej-lukowski.json', { wrongProduction: true, url: 'https://www.timeout.com/london/x-101426', publishDate: '2024-05-03' }]);
  const owners = new Map([['timeout.com/london/x-101426', new Set(['cherry-we'])]]);
  const out = findStaleSlotSquatters(f, { openingDate: '2026-10-13' }, owners, 'cherry-we');
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, 'stale-slot-squatter');
});

test('a url another show folder owns, a recent date, or no opening date is not a squatter', () => {
  const f = files(['a.json', { wrongProduction: true, url: 'https://x.com/old', publishDate: '1977-06-30' }]);
  const owners = new Map([['x.com/old', new Set(['cherry-we', 'cherry-1977'])]]);
  assert.equal(findStaleSlotSquatters(f, { openingDate: '2026-10-13' }, owners, 'cherry-we').length, 0);
  const g = files(['a.json', { wrongProduction: true, url: 'https://x.com/new', publishDate: '2026-10-01' }]);
  assert.equal(findStaleSlotSquatters(g, { openingDate: '2026-10-13' }, new Map(), 'cherry-we').length, 0);
  assert.equal(findStaleSlotSquatters(f, {}, new Map(), 'cherry-we').length, 0);
});

test('cleared twin flag, duplicateTextOf, missing twin and bad dates', () => {
  const bad = long('Revelatory Benedict Andrews');
  assert.equal(findDroppedByWrongTwin(files(
    ['a.json', { duplicateOf: 'b.json', fullText: long('fresh review text here') }],
    ['b.json', { wrongProduction: true, wrongProductionManualClear: true, fullText: bad }])).length, 0);
  assert.equal(findDroppedByWrongTwin(files(
    ['a.json', { duplicateTextOf: 'b.json', fullText: long('fresh review text here') }],
    ['b.json', { wrongShow: true, fullText: bad }])).length, 1);
  assert.equal(findDroppedByWrongTwin(files(['a.json', { duplicateOf: 'gone.json', fullText: bad }])).length, 0);
  const f = files(['a.json', { wrongProduction: true, url: 'https://x.com/n', publishDate: 'not a date' }]);
  assert.equal(findStaleSlotSquatters(f, { openingDate: '2026-10-13' }, new Map(), 's').length, 0);
});

test('human-verified clears, circular pairs and query-id urls (ship-check review)', () => {
  const bad = long('Revelatory Benedict Andrews');
  const real = long('fresh review text here');
  // humanReviewedWrongProduction=false is a clear the rebuild honours
  assert.equal(findDroppedByWrongTwin(files(
    ['a.json', { duplicateOf: 'b.json', fullText: real }],
    ['b.json', { wrongProduction: true, humanReviewedWrongProduction: false, fullText: bad }])).length, 0);
  // wrongShowOverride clears wrongShow via the shared guard
  assert.equal(findDroppedByWrongTwin(files(
    ['a.json', { duplicateOf: 'b.json', fullText: real }],
    ['b.json', { wrongShow: true, wrongShowOverride: true, fullText: bad }])).length, 0);
  // circular pair with different text: the rebuild keeps both
  assert.equal(findDroppedByWrongTwin(files(
    ['a.json', { duplicateOf: 'b.json', fullText: real }],
    ['b.json', { wrongProduction: true, duplicateOf: 'a.json', fullText: bad }])).length, 0);
  // a human-cleared wrongProduction file is never a squatter
  const f = files(['a.json', { wrongProduction: true, wrongProductionManualClear: true, url: 'https://x.com/o', publishDate: '1977-06-30' }]);
  assert.equal(findStaleSlotSquatters(f, { openingDate: '2026-10-13' }, new Map(), 's').length, 0);
  // ?p=123 style urls stay distinct
  assert.notEqual(normalizeUrl('https://x.com/?p=1'), normalizeUrl('https://x.com/?p=2'));
  assert.equal(normalizeUrl('https://x.com/a?utm=1#z'), 'x.com/a');
});
