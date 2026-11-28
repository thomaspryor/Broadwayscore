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

test('BRO-5975: findOverdueMissingScored skips same-day openings and shows with no collected reviews', async () => {
  const { reviewedShowIds, findOverdueMissingScored } = await import('./opening-night-scored-check.js');
  const shows = [
    { id: 'today-show', openingDate: '2026-10-21', category: 'off-broadway' },
    { id: 'yday-no-reviews', openingDate: '2026-10-20', category: 'off-broadway' },
    { id: 'yday-reviewed-unscored', openingDate: '2026-10-20', category: 'off-broadway' },
    { id: 'yday-stalled', openingDate: '2026-10-20', category: 'off-broadway' },
  ];
  const lines = [
    JSON.stringify({ showId: 'today-show', stage: 'rebuilt', at: '2026-10-21T10:00:00Z', metadata: { reviewCount: 9 } }),
    JSON.stringify({ showId: 'yday-no-reviews', stage: 'rebuilt', at: '2026-10-21T10:00:00Z', metadata: { reviewCount: 0 } }),
    JSON.stringify({ showId: 'yday-reviewed-unscored', stage: 'rebuilt', at: '2026-10-21T10:00:00Z', metadata: { reviewCount: 3 } }),
    JSON.stringify({ showId: 'yday-no-reviews', stage: 'review-text-collected', at: '2026-10-21T10:00:00Z' }),
    JSON.stringify({ showId: 'yday-no-reviews', stage: 'excluded', at: '2026-10-21T10:00:00Z' }),
    JSON.stringify({ showId: 'yday-stalled', stage: 'review-text-collected', at: '2026-10-21T10:00:00Z' }),
  ];
  const missing = findOverdueMissingScored(shows, new Set(), reviewedShowIds(lines), '2026-10-21').map((s) => s.id);
  assert.deepEqual(missing, ['yday-reviewed-unscored', 'yday-stalled']);
});

test('llmScoredShowIds counts opening-day LLM-scored reviews when the stage row is lost (BRO-6653)', () => {
  const { llmScoredShowIds } = require('./opening-night-scored-check.js');
  const shows = ['lost-row', 'anchored', 'adj', 'thumb-only', 'preview-only', 'unscored']
    .map((id) => ({ id, openingDate: '2026-10-29' }));
  const set = llmScoredShowIds({ reviews: [
    { showId: 'lost-row', scoreSource: 'llm-v6', publishDate: '2026-10-29' },
    { showId: 'anchored', scoreSource: 'anchored-v6', publishDate: '2026-10-30' },
    { showId: 'adj', scoreSource: 'adjudicated', publishDate: '2026-10-29' },
    { showId: 'thumb-only', scoreSource: 'thumb', publishDate: '2026-10-29' },
    { showId: 'preview-only', scoreSource: 'llm-v6', publishDate: '2026-10-20' },
    { showId: 'unscored', publishDate: '2026-10-29' },
    { showId: 'not-opening', scoreSource: 'llm-v6', publishDate: '2026-10-29' },
  ] }, shows);
  assert.deepEqual([...set].sort(), ['adj', 'anchored', 'lost-row']);
});

test('a preview-only review does not make a show "reviewed" for the overdue alert (BRO-6653)', () => {
  const { reviewedShowIds, openingDayReviewShowIds, findOverdueMissingScored } = require('./opening-night-scored-check.js');
  const shows = [{ id: 'preview-only', openingDate: '2026-10-29' }, { id: 'has-opening-review', openingDate: '2026-10-29' }];
  const lines = shows.map((s) => JSON.stringify({ showId: s.id, stage: 'rebuilt', at: '2026-10-30T10:00:00Z', metadata: { reviewCount: 1 } }));
  const opening = openingDayReviewShowIds({ reviews: [
    { showId: 'preview-only', publishDate: '2026-10-27' },
    { showId: 'has-opening-review', publishDate: '2026-10-29' },
  ] }, shows);
  const missing = findOverdueMissingScored(shows, new Set(), reviewedShowIds(lines, opening), '2026-10-30').map((s) => s.id);
  assert.deepEqual(missing, ['has-opening-review']);
  // without reviews.json the old behaviour (any rebuilt count) is kept
  assert.equal(reviewedShowIds(lines).has('preview-only'), true);
});
