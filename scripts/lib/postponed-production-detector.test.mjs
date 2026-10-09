import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractCuedDates, evaluatePostponed } = require('./postponed-production-detector.js');

const NOW = new Date('2026-10-11T12:00:00Z');
const show = { id: 'mm', status: 'open', openingDate: '2026-10-08' };
const base = { now: NOW, reviewCount: 0 };

test('Magic Mike page text: coming to NYC Jan 28 2027 → flagged', () => {
  const r = evaluatePostponed(show, { ...base, pageText: '<h1>Coming to NYC January 28, 2027</h1> tickets' });
  assert.equal(r.futureDate, '2027-01-28');
});
test('abbreviated month + ordinal', () => {
  assert.deepEqual(extractCuedDates('Coming soon to NYC Feb. 3rd, 2027'), ['2027-02-03']);
});
test('uncued date (closing) ignored', () => {
  assert.deepEqual(extractCuedDates('Final performance through June 27, 2027'), []);
  assert.equal(evaluatePostponed(show, { ...base, pageText: 'through June 27, 2027' }), null);
});
test('reviews exist → not flagged', () => {
  assert.equal(evaluatePostponed(show, { ...base, reviewCount: 3, pageText: 'Coming to NYC January 28, 2027' }), null);
});
test('within 48h grace → not flagged', () => {
  const s = { ...show, openingDate: '2026-10-10' };
  assert.equal(evaluatePostponed(s, { ...base, pageText: 'Coming to NYC January 28, 2027' }), null);
});
test('non open/previews status → not flagged', () => {
  assert.equal(evaluatePostponed({ ...show, status: 'upcoming' }, { ...base, pageText: 'Coming to NYC January 28, 2027' }), null);
});
test('past cued date on page → not flagged', () => {
  assert.equal(evaluatePostponed(show, { ...base, pageText: 'Opened September 1, 2026' }), null);
});
test('no page text → not flagged', () => {
  assert.equal(evaluatePostponed(show, { ...base, pageText: null }), null);
});
test('unrelated begins/starts/opens/returning dates ignored (reviewer FP list)', () => {
  for (const t of ['Lottery begins Monday, November 3, 2026', 'Cast change: Jane begins December 1, 2026',
    'The national tour opens February 10, 2027 in Chicago', 'Rush begins Jan 5, 2027', 'Performances start March 3, 2027'])
    assert.deepEqual(extractCuedDates(t), [], t);
});
test('Opening Night: and HTML-split cue are detected', () => {
  assert.deepEqual(extractCuedDates('Opening Night: January 28, 2027'), ['2027-01-28']);
  assert.deepEqual(extractCuedDates('<b>Coming to NYC</b><br>January 28, 2027'), ['2027-01-28']);
});
test('show opened >60d ago → not flagged (long-running page noise)', () => {
  const s = { ...show, openingDate: '2026-06-01' };
  assert.equal(evaluatePostponed(s, { ...base, pageText: 'Coming to NYC January 28, 2027' }), null);
});
