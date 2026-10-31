import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { applyMoves } = require('./reconcile-uk-regional-opening-dates.js');

const row = (id, title, openingDate) => ({
  id, title, slug: id, category: 'regional', venue: 'Dundee Rep Theatre', status: 'open', type: 'play',
  openingDate, openingDateSource: 'guardian-review',
});
const rev = (showId, publishDate) => ({ showId, publishDate });

test('applyMoves moves a seeded date back to the earliest review once, and is idempotent', () => {
  const shows = [row('a-leeds-2026', 'Alpha', '2026-10-11')];
  const reviews = [rev('a-leeds-2026', '2026-10-10'), rev('a-leeds-2026', '2026-10-11')];
  const moved = applyMoves(shows, reviews);
  assert.equal(moved.length, 1);
  assert.equal(shows[0].openingDate, '2026-10-10');
  assert.equal(shows[0].openingDateSource, 'first-review-date');
  assert.equal(applyMoves(shows, reviews).length, 0);
});

test('applyMoves leaves a row alone when no review predates the stored date', () => {
  const shows = [row('b-leeds-2026', 'Beta', '2026-10-10')];
  const reviews = [rev('b-leeds-2026', '2026-10-10'), rev('b-leeds-2026', '2026-10-12')];
  assert.equal(applyMoves(shows, reviews).length, 0);
  assert.equal(shows[0].openingDate, '2026-10-10');
});

test('applyMoves skips a move that would create a duplicate row (the write guard would refuse the save)', () => {
  // Shape of the real Dundee Rep pair: two titles for one run, four days apart, so they read as
  // separate rows until the later one is moved onto the earlier one's date.
  const mk = (id, title, d, src) => ({ ...row(id, title, d), type: 'musical', openingDateSource: src, venue: 'Dundee Rep, Dundee', status: 'closed' });
  const shows = [
    mk('the-high-life-the-musical-still-living-it-dundee-rep-regional-2026', 'The High Life: The Musical, Still Living It!', '2026-04-03', 'guardian-review'),
    mk('the-high-life-the-musical-dundee-rep-regional-2026', 'The High Life the Musical', '2026-04-07', 'census-review'),
  ];
  const before = shows.map((x) => ({ ...x }));
  const moved = applyMoves(shows, [rev(shows[1].id, '2026-04-03')]);
  assert.equal(moved.length, 0, 'the duplicate-creating move is skipped');
  assert.deepEqual(shows, before, 'rows are restored untouched');
});
