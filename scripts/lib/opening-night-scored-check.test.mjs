import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  etDateToday, etDateYesterday, selectOpeningWindowShows, scoredShowIds, reviewEvidenceShowIds, findMissingScored,
} = require('./opening-night-scored-check.js');

test('etDateToday/etDateYesterday return ET calendar days one apart', () => {
  const now = new Date('2026-08-17T14:00:00Z'); // 10am ET
  assert.equal(etDateToday(now), '2026-08-17');
  assert.equal(etDateYesterday(now), '2026-08-16');
});

test('selectOpeningWindowShows includes off-broadway and off-west-end, not just broadway/west-end', () => {
  const shows = [
    { id: 'bway-show', category: 'broadway', openingDate: '2026-08-16' },
    { id: 'ob-show', category: 'off-broadway', openingDate: '2026-08-16' },
    { id: 'we-show', category: 'west-end', openingDate: '2026-08-16' },
    { id: 'owe-show', category: 'off-west-end', openingDate: '2026-08-16' },
    { id: 'other-category', category: 'regional', openingDate: '2026-08-16' },
    { id: 'opens-tonight', category: 'broadway', openingDate: '2026-08-17' },
    { id: 'out-of-window', category: 'off-broadway', openingDate: '2026-08-01' },
  ];
  const selected = selectOpeningWindowShows(shows, { today: '2026-08-17', yesterday: '2026-08-16' })
    .map((s) => s.id);
  assert.deepEqual(
    selected.sort(),
    ['bway-show', 'ob-show', 'owe-show', 'we-show'].sort(),
  );
});

test('scoredShowIds keeps only recent "scored" entries', () => {
  const cutoffMs = new Date('2026-08-16T00:00:00Z').getTime();
  const lines = [
    JSON.stringify({ showId: 'recent-scored', stage: 'scored', at: '2026-08-17T00:00:00Z' }),
    JSON.stringify({ showId: 'stale-scored', stage: 'scored', at: '2026-08-01T00:00:00Z' }),
    JSON.stringify({ showId: 'wrong-stage', stage: 'discovered', at: '2026-08-17T00:00:00Z' }),
    'not json {{{',
    '',
  ];
  const set = scoredShowIds(lines, cutoffMs);
  assert.equal(set.has('recent-scored'), true);
  assert.equal(set.has('stale-scored'), false);
  assert.equal(set.has('wrong-stage'), false);
});

test('an off-broadway show with no recent scored entry triggers the same alert a Broadway show would', () => {
  const shows = [
    { id: 'bway-no-score', title: 'Broadway No Score', category: 'broadway', openingDate: '2026-08-16' },
    { id: 'ob-no-score', title: 'Off-Broadway No Score', category: 'off-broadway', openingDate: '2026-08-16' },
    { id: 'owe-scored', title: 'Off-West-End Scored', category: 'off-west-end', openingDate: '2026-08-16' },
  ];
  const openingShows = selectOpeningWindowShows(shows, { today: '2026-08-17', yesterday: '2026-08-16' });
  const scoredSet = scoredShowIds(
    [JSON.stringify({ showId: 'owe-scored', stage: 'scored', at: '2026-08-17T12:00:00Z' })],
    new Date('2026-08-15T00:00:00Z').getTime(),
  );
  const missing = findMissingScored(openingShows, scoredSet).map((s) => s.id).sort();
  assert.deepEqual(missing, ['bway-no-score', 'ob-no-score']);
});

test('findMissingScored is empty when every opening-window show has a recent scored entry', () => {
  const shows = [{ id: 'we-scored', category: 'west-end', openingDate: '2026-08-17' }];
  const openingShows = selectOpeningWindowShows(shows, { today: '2026-08-17', yesterday: '2026-08-16' });
  const scoredSet = scoredShowIds(
    [JSON.stringify({ showId: 'we-scored', stage: 'scored', at: '2026-08-17T12:00:00Z' })],
    new Date('2026-08-15T00:00:00Z').getTime(),
  );
  assert.deepEqual(findMissingScored(openingShows, scoredSet), []);
});

test('a show opening today is not checked: its curtain has not risen at the 9 AM ET run (BRO-5975)', () => {
  const shows = [{ id: 'tonight', category: 'off-broadway', openingDate: '2026-10-21' }];
  assert.deepEqual(selectOpeningWindowShows(shows, { today: '2026-10-21', yesterday: '2026-10-20' }), []);
});

test('only shows with a collected, non-excluded review can be missing a score (BRO-5975)', () => {
  const row = (showId, reviewKey, stage) => JSON.stringify({ showId, reviewKey, stage, at: '2026-10-21T12:00:00Z' });
  const lines = [
    // Jest to Impress: a ticket listing page, collected then excluded (author case differs)
    row('listing-only', 'donyc:Unknown:https://donyc.com/x', 'review-text-collected'),
    row('listing-only', 'donyc:unknown:https://donyc.com/x', 'excluded'),
    // the race: a real review collected and never scored
    row('race', 'nytimes:Jane Doe:https://nytimes.com/r', 'review-text-collected'),
    row('first-seen-only', 'vulture:unknown:https://vulture.com/r', 'review-first-seen'),
    JSON.stringify({ showId: 'all-shows-row', reviewKey: null, stage: 'rebuilt', at: '2026-10-21T12:00:00Z' }),
  ];
  const evidence = reviewEvidenceShowIds(lines);
  assert.deepEqual([...evidence].sort(), ['first-seen-only', 'race']);
  const shows = ['listing-only', 'race', 'first-seen-only', 'no-rows'].map((id) => ({ id, category: 'off-broadway' }));
  assert.deepEqual(findMissingScored(shows, new Set(), evidence).map((s) => s.id), ['race', 'first-seen-only']);
  assert.equal(findMissingScored(shows, new Set()).length, 4, 'without an evidence set every unscored show counts');
  const bway = [{ id: 'no-rows', category: 'broadway' }, { id: 'listing-only', category: 'west-end' }];
  assert.equal(findMissingScored(bway, new Set(), evidence).length, 2, 'a Broadway or West End opening with nothing collected still alerts');
});
