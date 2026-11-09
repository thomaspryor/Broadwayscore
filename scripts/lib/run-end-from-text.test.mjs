import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runEndCandidates, pickRunEnd, closingFields } = require('./run-end-from-text.js');

test('reads "through Month d" and infers the year from the article date', () => {
  const c = runEndCandidates('The play runs through Nov. 23 at the Old Globe.', { opening: '2026-10-01', articleDate: '2026-10-02' });
  assert.equal(c.length, 1);
  assert.equal(c[0].date, '2026-11-23');
});

test('year rolls over for a December review of a January closing', () => {
  const c = runEndCandidates('Continues through January 11, 2027.', { opening: '2026-12-05', articleDate: '2026-12-06' });
  assert.equal(pickRunEnd(c), '2027-01-11');
});

test('ignores dates outside [opening, opening+200d] and impossible dates', () => {
  assert.equal(runEndCandidates('Performances through Feb 30. Tickets until May 2.', { opening: '2026-10-01', articleDate: '2026-10-02' }).length, 0);
});

test('an "extended through" date beats an earlier announced close', () => {
  const t = 'Originally closing Oct 18, the show was extended through Nov 1. Runs through Oct 18.';
  assert.equal(pickRunEnd(runEndCandidates(t, { opening: '2026-09-17', articleDate: '2026-09-20' })), '2026-11-01');
});

test('no closing language gives null', () => {
  assert.equal(pickRunEnd(runEndCandidates('A lovely evening of theatre.', { opening: '2026-10-01' })), null);
});

test('closingFields never writes a date without a source and flags the rest estimated', () => {
  assert.deepEqual(closingFields('2026-11-23', 'broadwayworld-regional-listing'), { closingDate: '2026-11-23', closingDateSource: 'broadwayworld-regional-listing' });
  assert.deepEqual(closingFields('2026-11-23', null), { closingDateSource: 'estimated' });
  assert.deepEqual(closingFields(null, null), { closingDateSource: 'estimated' });
});

test('pickRunEnd counts a date once per site (boilerplate repeats do not outvote other outlets)', () => {
  const c = (date, url) => ({ date, extended: false, url });
  const cands = [
    ...Array.from({ length: 8 }, () => c('2026-02-15', 'https://www.metrmag.com/a')),
    c('2026-02-08', 'https://www.bostonglobe.com/x'),
    c('2026-02-08', 'https://www.broadwayworld.com/article/y'),
    c('2026-02-08', 'https://www.broadwayworld.com/boston/article/y'),
  ];
  assert.equal(pickRunEnd(cands), '2026-02-08');
});
