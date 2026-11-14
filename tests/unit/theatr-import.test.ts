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
  overlapBatches,
  stitchBatchRows,
  effectiveRating,
  reactionCounts,
  DEFAULT_REACTION_RATINGS,
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
  const { entries, feedDates, backfillDropped } = theatrRowsPipeline([FEED], TODAY);
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
  const { entries, feedDates, backfillDropped } = theatrRowsPipeline([FEED], TODAY);
  const n = theatrNotices(entries, { picked: 35, failedScreenshots: 6, unreadable: 1, feedDates, backfillDropped }).join(' ');
  for (const re of [/first 30 screenshots/, /couldn\u2019t be read/, /didn\u2019t look like/, /score you wrote/, /when you logged/, /several shows at once/]) {
    assert.match(n, re);
  }
  // Every seen show in the fixture has a score or a reaction, so none is
  // certain to stay unrated: no watchlist line.
  assert.doesNotMatch(n, /watchlist/);
  const bare = theatrRowsToEntries([row({})]);
  assert.match(theatrNotices(bare, { picked: 1, failedScreenshots: 0, unreadable: 0 }).join(' '), /no date, reaction or score/);
  assert.equal(theatrNotices([], { picked: 3, failedScreenshots: 0, unreadable: 0 }).length, 0);
});

// Batch boundaries (code review, 2026-10-11): the next batch re-sends the
// previous batch's last screenshot as context, so its first rows repeat.

test('overlapBatches repeats each batch\'s last screenshot as the next one\'s context', () => {
  assert.deepEqual(overlapBatches([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], 6), [[0, 1, 2, 3, 4, 5], [5, 6, 7, 8, 9, 10], [10, 11]]);
  assert.deepEqual(overlapBatches([0, 1, 2], 6), [[0, 1, 2]]);
  assert.deepEqual(overlapBatches([], 6), []);
  // 30 screenshots stay within the per-hour call cap (15).
  assert.ok(overlapBatches(Array.from({ length: 30 }, (_, i) => i), 6).length <= 6);
});

test('repeated context rows do not shift the year of the rest of the feed', () => {
  const { entries } = theatrRowsPipeline([
    [row({ title: 'X', monthDay: '10-05' }), row({ title: 'Y', monthDay: '10-01' })],
    [row({ title: 'X', monthDay: '10-05' }), row({ title: 'Y', monthDay: '10-01' }), row({ title: 'Z', monthDay: '09-20' })],
  ], TODAY);
  assert.deepEqual(entries.map(e => [e.title, e.date]), [['X', '2026-10-05'], ['Y', '2026-10-01'], ['Z', '2026-09-20']]);
});

test('a context row with its header cropped neither takes the wrong date nor fakes a backfill', () => {
  const { entries, backfillDropped } = theatrRowsPipeline([
    [row({ title: 'X', monthDay: '10-05' }), row({ title: 'Y', monthDay: '10-01' })],
    [row({ title: 'X' }), row({ title: 'Y', monthDay: '10-01' }), row({ title: 'Z', monthDay: '09-20' })],
  ], TODAY);
  assert.equal(backfillDropped, 0);
  assert.deepEqual(entries.map(e => [e.title, e.date]), [['X', '2026-10-05'], ['Y', '2026-10-01'], ['Z', '2026-09-20']]);
});

test('a two-show day stays dated even when one show repeats at a batch boundary', () => {
  const { entries } = theatrRowsPipeline([
    [row({ title: 'A', monthDay: '09-01' }), row({ title: 'B', monthDay: '09-01' })],
    [row({ title: 'B', monthDay: '09-01' }), row({ title: 'C', monthDay: '08-01' })],
  ], TODAY);
  assert.deepEqual(entries.map(e => e.date), ['2026-09-01', '2026-09-01', '2026-08-01']);
});

test('stitch fills what the first copy lacked from the context copy', () => {
  const [kept] = stitchBatchRows([
    [row({ title: 'Six', monthDay: null })],
    [row({ title: 'Six', monthDay: '03-10', score: 84, rating: 4, review: 'r' })],
  ]);
  assert.deepEqual([kept.monthDay, kept.rating, kept.review], ['03-10', 4, 'r']);
});

test('a viewing that lost its date to a backfill day never folds into another viewing', () => {
  const { entries } = theatrRowsPipeline([[
    row({ title: 'A', monthDay: '10-01' }),
    row({ title: 'B', monthDay: '10-01' }),
    row({ title: 'Hamilton', monthDay: '10-01', score: 90, rating: 4.5, review: 'old' }),
    row({ title: 'Hamilton', monthDay: '06-01' }),
  ]], TODAY);
  const ham = entries.filter(e => e.title === 'Hamilton');
  assert.equal(ham.length, 2);
  assert.deepEqual(ham.map(e => [e.date, e.rating, e.reviewText]), [[null, 4.5, 'old'], ['2026-06-01', null, null]]);
});

// Reactions → stars: the user's choice in the preview (owner, 2026-10-11:
// "normal users don't give shows a score out of 100").

test('a seen show keeps its reaction; a written score stays the rating', () => {
  const [liked, scored] = theatrRowsToEntries([
    row({ title: 'A', reaction: 'recommend' }),
    row({ title: 'B', reaction: 'dislike', score: 84, rating: 4 }),
  ]);
  assert.deepEqual([liked.rating, liked.reaction], [null, 'recommend']);
  assert.deepEqual([scored.rating, scored.reaction], [4, 'dislike']);
});

test('effectiveRating: written score, else the reaction setting, else none', () => {
  assert.equal(effectiveRating(4.5, 'dislike', DEFAULT_REACTION_RATINGS), 4.5);
  assert.equal(effectiveRating(null, 'recommend', DEFAULT_REACTION_RATINGS), 4);
  assert.equal(effectiveRating(null, 'mixed', DEFAULT_REACTION_RATINGS), 3);
  assert.equal(effectiveRating(null, 'dislike', DEFAULT_REACTION_RATINGS), 2);
  assert.equal(effectiveRating(null, 'recommend', { ...DEFAULT_REACTION_RATINGS, recommend: null }), null);
  assert.equal(effectiveRating(null, undefined, DEFAULT_REACTION_RATINGS), null);
});

test('reactionCounts counts only reaction-rated rows, per reaction', () => {
  assert.deepEqual(reactionCounts([
    { reaction: 'recommend', scoreRating: null },
    { reaction: 'recommend', scoreRating: null },
    { reaction: 'dislike', scoreRating: 4 },
    { scoreRating: null },
  ]), { recommend: 2 });
});

test('reviews cut off between screenshots are counted, unless another copy had the whole review', () => {
  const { entries, reviewsCutOff } = theatrRowsPipeline([
    [
      row({ title: 'A', monthDay: '10-05', score: 68, rating: 3.5, reviewCutOff: true }),
      row({ title: 'B', monthDay: '10-03', reviewCutOff: true }),
    ],
    [
      // Context screenshot: B again, this time with the whole review.
      row({ title: 'B', monthDay: '10-03', review: 'Full text.' }),
      row({ title: 'C', monthDay: '10-01', reaction: 'recommend', reviewCutOff: true }),
      row({ title: 'D', list: 'interested', screen: 'collection', reviewCutOff: true }),
    ],
  ], TODAY);
  assert.equal(reviewsCutOff, 2);
  assert.equal(entries.find((e) => e.title === 'B')?.reviewText, 'Full text.');
  const n = theatrNotices(entries, { picked: 2, failedScreenshots: 0, unreadable: 0, reviewsCutOff }).join(' ');
  assert.match(n, /2 review\(s\) were cut off between screenshots/);
  assert.doesNotMatch(theatrNotices(entries, { picked: 2, failedScreenshots: 0, unreadable: 0 }).join(' '), /cut off/);
});
