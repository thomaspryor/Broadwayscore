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

test('BRO-6697: a theatreinchicago row seeded from its first TIC review moves to an earlier review', () => {
  // Shape of top-girls-regional-2026: TIC's first listed review 02-26, Sun-Times reviewed 02-20.
  const tic = (id, d, src = 'tic-first-review') => ({
    id, title: id, slug: id, category: 'regional', venue: 'Goodman Theatre, Chicago, IL', status: 'closed', type: 'play',
    openingDate: d, openingDateSource: src, discoverySource: 'theatreinchicago', localOnly: true,
  });
  const shows = [tic('top-girls-regional-2026', '2026-02-26'), tic('other-chicago-regional-2026', '2026-02-26', 'ibdb')];
  const reviews = [rev('top-girls-regional-2026', '2026-02-20'), rev('top-girls-regional-2026', '2026-02-20'), rev('top-girls-regional-2026', '2026-02-26'), rev('other-chicago-regional-2026', '2026-02-20')];
  const moved = applyMoves(shows, reviews);
  assert.deepEqual(moved.map((m) => m.show.id), ['top-girls-regional-2026'], 'only the review-seeded TIC row moves');
  assert.equal(shows[0].openingDate, '2026-02-20');
  assert.equal(shows[0].openingDateSource, 'first-review-date');
  assert.equal(shows[1].openingDate, '2026-02-26', 'a sourced (non-seeded) date is never moved');
  assert.equal(applyMoves(shows, reviews).length, 0, 'idempotent once re-stamped first-review-date');
});

test('BRO-6697: a localOnly non-TIC regional row stays out of scope', () => {
  const shows = [{ ...row('c-local-2026', 'Gamma', '2026-10-11'), localOnly: true, venue: 'Some Hall, Springfield, IL' }];
  assert.equal(applyMoves(shows, [rev('c-local-2026', '2026-10-05')]).length, 0);
});

test('BRO-6697: one stray early review does not move a TIC row; a pinned or previews-fenced row never moves', () => {
  const tic = (id, extra = {}) => ({
    id, title: id, slug: id, category: 'regional', venue: 'Steppenwolf Theatre, Chicago, IL', status: 'closed', type: 'play',
    openingDate: '2025-01-02', openingDateSource: 'tic-first-review', discoverySource: 'theatreinchicago', localOnly: true, ...extra,
  });
  const shows = [
    tic('stray-regional-2025'),
    tic('pinned-regional-2025', { humanCorrectedOpeningDate: '2025-01-02' }),
    tic('fenced-regional-2025', { previewsStartDate: '2024-12-30' }),
  ];
  const reviews = [];
  // stray: a lone preview-week post 12-29, everyone else on 01-02.
  reviews.push(rev('stray-regional-2025', '2024-12-29'), rev('stray-regional-2025', '2025-01-02'), rev('stray-regional-2025', '2025-01-02'));
  for (const id of ['pinned-regional-2025', 'fenced-regional-2025']) reviews.push(rev(id, '2024-12-28'), rev(id, '2024-12-28'));
  assert.equal(applyMoves(shows, reviews).length, 0);
  assert.deepEqual(shows.map((s) => s.openingDate), ['2025-01-02', '2025-01-02', '2025-01-02']);
});
