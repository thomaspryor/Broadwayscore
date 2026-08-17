import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const {
  etDateToday, etDateYesterday, selectOpeningWindowShows, scoredShowIds, findMissingScored,
} = require('./opening-night-scored-check.js');

test('etDateToday/etDateYesterday return ET calendar days one apart', () => {
  const now = new Date('2026-08-17T14:00:00Z'); // 10am ET
  assert.equal(etDateToday(now), '2026-08-17');
  assert.equal(etDateYesterday(now), '2026-08-16');
});

test('selectOpeningWindowShows includes off-broadway and off-west-end, not just broadway/west-end', () => {
  const shows = [
    { id: 'bway-show', category: 'broadway', openingDate: '2026-08-17' },
    { id: 'ob-show', category: 'off-broadway', openingDate: '2026-08-17' },
    { id: 'we-show', category: 'west-end', openingDate: '2026-08-16' },
    { id: 'owe-show', category: 'off-west-end', openingDate: '2026-08-16' },
    { id: 'other-category', category: 'regional', openingDate: '2026-08-17' },
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
    { id: 'bway-no-score', title: 'Broadway No Score', category: 'broadway', openingDate: '2026-08-17' },
    { id: 'ob-no-score', title: 'Off-Broadway No Score', category: 'off-broadway', openingDate: '2026-08-17' },
    { id: 'owe-scored', title: 'Off-West-End Scored', category: 'off-west-end', openingDate: '2026-08-17' },
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
