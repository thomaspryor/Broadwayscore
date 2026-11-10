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

// BRO-7319 (a): a single review's "extended through" must not move a closing date.
const { laterAnnouncedRunEnd } = require('./run-end-from-text.js');
const tx = (text, url) => ({ text, url, articleDate: '2026-10-05' });
const SHOW = { opening: '2026-10-01', closing: '2026-10-25' };

test('one host saying "extended through" does not move the date (writer default)', () => {
  assert.equal(laterAnnouncedRunEnd(SHOW, { texts: [tx('The show was extended through Nov 8.', 'https://a.com/1')] }), null);
});
test('two hosts naming the same date move it, kind extended only when both used the extended cue', () => {
  const both = laterAnnouncedRunEnd(SHOW, { texts: [tx('extended through Nov 8', 'https://a.com/1'), tx('extended through Nov 8', 'https://b.com/2')] });
  assert.equal(both.date, '2026-11-08'); assert.equal(both.kind, 'extended');
  const mixed = laterAnnouncedRunEnd(SHOW, { texts: [tx('extended through Nov 8', 'https://a.com/1'), tx('runs through Nov 8', 'https://b.com/2')] });
  assert.equal(mixed.date, '2026-11-08'); assert.equal(mixed.kind, 'text');
});
test('two hosts on different dates do not combine', () => {
  assert.equal(laterAnnouncedRunEnd(SHOW, { texts: [tx('extended through Nov 8', 'https://a.com/1'), tx('extended through Nov 15', 'https://b.com/2')] }), null);
});
test('the theatre listing alone still moves the date; audit minSites:1 still sees a single host', () => {
  assert.equal(laterAnnouncedRunEnd(SHOW, { texts: [], listing: { date: '2026-11-01', url: 'https://t.org/p' } }).kind, 'listing');
  assert.equal(laterAnnouncedRunEnd(SHOW, { texts: [tx('extended through Nov 8', 'https://a.com/1')] }, { minSites: 1 }).date, '2026-11-08');
});
test('latest of several two-host dates wins', () => {
  const r = laterAnnouncedRunEnd(SHOW, { texts: [tx('through Nov 1', 'https://a.com/1'), tx('through Nov 1', 'https://b.com/2'), tx('through Nov 8', 'https://c.com/3'), tx('through Nov 8', 'https://d.com/4')] });
  assert.equal(r.date, '2026-11-08');
});
