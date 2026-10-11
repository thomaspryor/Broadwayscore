/**
 * Theatr screenshot import, client side (src/lib/show-import.ts): feed-date
 * resolution, backfill days, merging repeats, and the mapping to import
 * entries (BRO-4618, BRO-5082).
 *
 * The feed fixture mirrors a real Theatr Activity feed's shape (owner's
 * screenshots, 2026-10-12): headers with no year, a bare "2025" divider, a
 * same-day backfill of several shows, reviews ending in "84/100". Titles and
 * venues only; no review text.
 *
 * Run: npx tsx --test tests/unit/theatr-import.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  theatrRowsToEntries,
  mergeTheatrRows,
  resolveFeedDates,
  dropBackfillDates,
  theatrRowsPipeline,
  theatrNotices,
  chunk,
  type TheatrRow,
} from '../../src/lib/show-import';

const row = (over: Partial<TheatrRow>): TheatrRow => ({
  title: 'Show', venue: null, list: 'attended', screen: 'activity', date: null, monthDay: null,
  yearHint: null, score: null, rating: null, review: null, reaction: null, ...over,
});

const TODAY = '2026-10-11';

// Newest first, in screenshot order, as the edge function returns it.
const FEED: TheatrRow[] = [
  row({ title: 'Garry Starr: Classic Penguins', venue: 'Studio Seaview', monthDay: '10-12', reaction: 'recommend' }),
  row({ title: 'A Few Good Men', list: 'interested', monthDay: '10-12' }),
  row({ title: 'Much Ado About Nothing', list: 'interested', monthDay: '10-12' }),
  row({ title: 'The Holes', venue: 'Wild Project', monthDay: '10-12', reaction: 'recommend' }),
  row({ title: 'The Outsiders', venue: 'Bernard B. Jacobs Theatre', monthDay: '10-12', reaction: 'dislike' }),
  row({ title: "Arthur Miller's Death of a Salesman", list: 'interested', monthDay: '04-10' }),
  row({ title: 'High Spirits', venue: 'New York City Center', monthDay: '03-10', reaction: 'recommend', score: 68, rating: 3.5, review: 'review text' }),
  // Its header scrolled off into the previous screenshot.
  row({ title: 'The 25th Annual Putnam County Spelling Bee', venue: 'New World Stages', reaction: 'recommend', score: 84, rating: 4, review: 'review text' }),
  row({ title: 'Kyoto', list: 'interested', monthDay: '10-11', yearHint: 2025 }),
  row({ title: 'Are the Bennet Girls Ok?', list: 'interested', monthDay: '10-07' }),
  row({ title: 'Cabaret at the Kit Kat Club', list: 'interested', monthDay: '04-16' }),
  row({ title: 'Cabaret at the Kit Kat Club', list: 'interested', monthDay: '04-16' }),
  row({ title: 'Wicked', monthDay: '01-31', score: 90, rating: 4.5 }),
];

test('feed walk: headers without a year resolve against today and the 2025 divider', () => {
  const dated = resolveFeedDates(FEED, TODAY);
  const by = (t: string) => dated.find(r => r.title === t)!;
  // Oct 12 is a day ahead of a UTC "today" for a Berlin user: still this year.
  assert.equal(by('The Holes').date, '2026-10-12');
  assert.equal(by('High Spirits').date, '2026-03-10');
  // No header of its own: sits under the last one seen.
  assert.equal(by('The 25th Annual Putnam County Spelling Bee').date, '2026-03-10');
  // After the "2025" divider; Interested rows walk the feed but carry no date.
  assert.equal(by('Kyoto').date, null);
  assert.equal(by('Wicked').date, '2025-01-31');
});

test('feed walk: month/day going up means the previous year, even with no divider', () => {
  const dated = resolveFeedDates([
    row({ title: 'A', monthDay: '01-31' }),
    row({ title: 'B', monthDay: '12-20' }),
    row({ title: 'C', monthDay: '12-01' }),
  ], TODAY);
  assert.deepEqual(dated.map(r => r.date), ['2026-01-31', '2025-12-20', '2025-12-01']);
});

test('feed walk: a first header later in the year than today is last year', () => {
  const [r] = resolveFeedDates([row({ monthDay: '11-30' })], TODAY);
  assert.equal(r.date, '2025-11-30');
});

test('feed walk leaves full dates and Collection rows alone', () => {
  const dated = resolveFeedDates([
    row({ title: 'A', date: '2019-05-04', screen: 'collection' }),
    row({ title: 'B', screen: 'collection', monthDay: '03-01' }),
  ], TODAY);
  assert.deepEqual(dated.map(r => [r.date, r.dateFromFeed ?? false]), [['2019-05-04', false], [null, false]]);
});

test('backfill day: three or more attended on one logged date lose that date', () => {
  const { rows, dropped } = dropBackfillDates(resolveFeedDates(FEED, TODAY));
  assert.equal(dropped, 3);
  assert.equal(rows.find(r => r.title === 'The Holes')!.date, null);
  // Two shows on one day (matinee + evening) keep it.
  assert.equal(rows.find(r => r.title === 'High Spirits')!.date, '2026-03-10');
});

test('pipeline: scored reviews become rated diary entries, reactions stay unrated', () => {
  const { entries, feedDates, backfillDropped } = theatrRowsPipeline(FEED, TODAY);
  const by = (t: string) => entries.find(e => e.title === t)!;
  const bee = by('The 25th Annual Putnam County Spelling Bee');
  assert.deepEqual([bee.kind, bee.rating, bee.sourceScore, bee.date, bee.reviewText], ['diary', 4, 84, '2026-03-10', 'review text']);
  assert.equal(by('High Spirits').rating, 3.5);
  assert.deepEqual([by('The Outsiders').rating, by('The Outsiders').date], [null, null]);
  assert.equal(by('Kyoto').kind, 'watchlist');
  // Cabaret logged three times → one row.
  assert.equal(entries.filter(e => e.title === 'Cabaret at the Kit Kat Club').length, 1);
  assert.equal(backfillDropped, 3);
  assert.equal(feedDates, 3);
});

test('an off-scale rating from the edge function is dropped, not written', () => {
  const [e] = theatrRowsToEntries([row({ rating: 7, score: 140 })]);
  assert.equal(e.rating, null);
});

test('merge folds an undated attended copy into the dated one, whichever comes first, and fills gaps', () => {
  for (const rows of [
    [row({ title: 'Six' }), row({ title: 'Six', date: '2024-04-01' })],
    [row({ title: 'Six', date: '2024-04-01' }), row({ title: 'six', venue: 'Lena Horne Theatre', score: 80, rating: 4 })],
  ]) {
    const merged = mergeTheatrRows(rows);
    assert.deepEqual(merged.map(r => r.date), ['2024-04-01']);
  }
  const [filled] = mergeTheatrRows([
    row({ title: 'Six', date: '2024-04-01' }),
    row({ title: 'six', venue: 'Lena Horne Theatre', score: 80, rating: 4, review: 'r' }),
  ]);
  assert.deepEqual([filled.venue, filled.rating, filled.review], ['Lena Horne Theatre', 4, 'r']);
});

test('merge keeps two viewings on different dates and keeps screenshot order', () => {
  const rows = mergeTheatrRows([
    row({ title: 'B', date: '2024-01-02' }),
    row({ title: 'A', date: '2024-01-01' }),
    row({ title: 'A', date: '2019-01-01' }),
  ]);
  assert.deepEqual(rows.map(r => r.title), ['B', 'A', 'A']);
});

test('merge does not mutate the caller rows', () => {
  const input = [row({ title: 'Six' }), row({ title: 'Six', venue: 'Lena Horne Theatre' })];
  mergeTheatrRows(input);
  assert.equal(input[0].venue, null);
});

test('chunk makes edge-function-sized batches', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5, 6, 7], 6).map(b => b.length), [6, 1]);
});

test('notices explain scores, reactions, feed dates, backfill and failures', () => {
  const { entries, feedDates, backfillDropped } = theatrRowsPipeline(FEED, TODAY);
  const n = theatrNotices(entries, { picked: 35, failedScreenshots: 6, unreadable: 1, feedDates, backfillDropped }).join(' ');
  for (const re of [/first 30 screenshots/, /couldn\u2019t be read/, /didn\u2019t look like/, /84\/100/, /when you logged/, /several shows at once/, /watchlist/]) {
    assert.match(n, re);
  }
  // Every reaction-only show in the fixture is undated (backfill day), so
  // none goes to To Be Rated and that line must not claim otherwise.
  assert.doesNotMatch(n, /To Be Rated/);
  const dated = theatrRowsToEntries([row({ date: '2024-01-01' })]);
  assert.match(theatrNotices(dated, { picked: 1, failedScreenshots: 0, unreadable: 0 }).join(' '), /To Be Rated/);
  assert.equal(theatrNotices([], { picked: 3, failedScreenshots: 0, unreadable: 0 }).length, 0);
});
