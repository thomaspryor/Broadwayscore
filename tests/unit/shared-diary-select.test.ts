/**
 * Shared Diary selection + view model (BRO-4566): what a friend sees, how it
 * is grouped, and how it is counted. Real functions, fixed clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectSharedDiary, toSharedDiaryEntries, type SharedDiaryPayload } from '../../src/lib/shared-diary/select';
import { buildSharedDiaryView, diarySummary, diaryTitle, type DiaryShow } from '../../src/lib/shared-diary/view-model';

// 2026-10-04 03:00 UTC = Oct 3, 11pm in New York, Oct 4, 4am in London.
const NOW = Date.UTC(2026, 9, 4, 3, 0, 0);

const show = (id: string, category = 'broadway', posterUrl: string | null = `/images/shows/${id}/poster.webp`): DiaryShow =>
  ({ id, category, status: 'open', title: id, href: `/show/${id}`, posterUrl, venue: 'A Theatre' });
const SHOWS = new Map<string, DiaryShow>([
  ['wicked', show('wicked')],
  ['six-we', show('six-we', 'west-end')],
  ['hamilton', show('hamilton', 'broadway', null)],
  ['gypsy', show('gypsy')],
]);

const payload = (entries: SharedDiaryPayload['entries'], showText = false, capped = false): SharedDiaryPayload =>
  ({ name: 'Tom', showText, capped, entries });

test('tonight (venue-local) is a plan, not a diary entry; the day before is seen', () => {
  const sel = selectSharedDiary(payload([
    { show_id: 'wicked', date_seen: '2026-10-03', rating: 4 },  // tonight in NY: not yet seen
    { show_id: 'six-we', date_seen: '2026-10-03', rating: 5 },  // yesterday in London: seen
    { show_id: 'gypsy', date_seen: '2026-10-02', rating: 3 },
  ]), SHOWS, NOW);
  assert.deepEqual(sel.entries.map(e => e.show.id), ['six-we', 'gypsy']);
});

test('undated entries are kept; unknown show ids are dropped', () => {
  const sel = selectSharedDiary(payload([
    { show_id: 'gypsy', date_seen: '2025-01-01', rating: 3 },
    { show_id: 'gone-show', date_seen: '2025-01-01', rating: 3 },
    { show_id: 'hamilton', date_seen: null, rating: 5 },
  ]), SHOWS, NOW);
  assert.deepEqual(sel.entries.map(e => [e.show.id, e.date]), [['gypsy', '2025-01-01'], ['hamilton', null]]);
});

test('notes reach the page only when the owner shares them', () => {
  const entries = [{ show_id: 'gypsy', date_seen: '2025-01-01', rating: 3, text: 'Great' }, { show_id: 'wicked', date_seen: '2024-05-01', rating: 4, text: '   ' }];
  assert.equal(selectSharedDiary(payload(entries, false), SHOWS, NOW).entries[0].text, null);
  const on = selectSharedDiary(payload(entries, true), SHOWS, NOW);
  assert.equal(on.entries[0].text, 'Great');
  assert.equal(on.entries[1].text, null, 'blank note is no note');
  assert.equal(on.withNotes, 1);
});

test('shows seen counts distinct shows (repeat viewings once), as the app does', () => {
  const sel = selectSharedDiary(payload([
    { show_id: 'wicked', date_seen: '2025-03-01', rating: 5 },
    { show_id: 'wicked', date_seen: '2019-03-01', rating: 4 },
    { show_id: 'gypsy', date_seen: null, rating: 3 },
  ]), SHOWS, NOW);
  assert.equal(sel.entries.length, 3);
  assert.equal(sel.showsSeen, 2);
  assert.equal(diarySummary(sel.showsSeen), '2 shows seen');
  assert.equal(diarySummary(1), '1 show seen');
});

test('view model groups by year (newest first), undated last, with pill labels and recent posters', () => {
  const view = buildSharedDiaryView(payload([
    { show_id: 'gypsy', date_seen: '2026-01-01', rating: 3 },
    { show_id: 'wicked', date_seen: '2025-12-31', rating: 4 },
    { show_id: 'six-we', date_seen: '2025-03-02', rating: 5 },
    { show_id: 'hamilton', date_seen: null, rating: 5 },
  ], false, true), SHOWS, NOW);
  assert.deepEqual(view.groups.map(g => [g.year, g.entries.length]), [['2026', 1], ['2025', 2], [null, 1]]);
  assert.equal(view.groups[0].entries[0].dateLabel, 'Jan 1', 'no day shift for a Jan 1 date');
  assert.equal(view.groups[2].entries[0].dateLabel, null);
  assert.deepEqual(view.recentPosters, ['/images/shows/gypsy/poster.webp', '/images/shows/wicked/poster.webp', '/images/shows/six-we/poster.webp']);
  assert.equal(view.capped, true);
});

test('titles', () => {
  assert.equal(diaryTitle('Tom'), 'Tom’s theater diary');
  assert.equal(diaryTitle('Chris '), 'Chris’ theater diary');
});

test('toSharedDiaryEntries orders like get_shared_diary and keeps the owner\'s own notes', () => {
  const entries = toSharedDiaryEntries([
    { id: 'a', show_id: 'gypsy', date_seen: null, rating: 3, review_text: 'n', created_at: '2026-01-01' },
    { id: 'b', show_id: 'wicked', date_seen: '2025-01-01', rating: 4, review_text: '  ', created_at: '2026-01-02' },
    { id: 'c', show_id: 'six-we', date_seen: '2025-06-01', rating: 5, review_text: null, created_at: '2026-01-03' },
  ]);
  assert.deepEqual(entries.map(e => e.show_id), ['six-we', 'wicked', 'gypsy']);
  assert.equal(entries[2].text, 'n');
  assert.ok(!('text' in entries[1]), 'blank owner note becomes no text key');
});

test('out-of-order rows still give one band per year, newest first, undated last', () => {
  const view = buildSharedDiaryView(payload([
    { show_id: 'gypsy', date_seen: null, rating: 3 },
    { show_id: 'wicked', date_seen: '2024-05-01', rating: 4 },
    { show_id: 'hamilton', date_seen: '2025-01-02', rating: 5 },
    { show_id: 'six-we', date_seen: '2024-12-30', rating: 2 },
    { show_id: 'wicked', date_seen: '2025-06-01', rating: 4.5 },
  ]), SHOWS, NOW);
  assert.deepEqual(view.groups.map(g => g.year), ['2025', '2024', null]);
  assert.deepEqual(view.groups[0].entries.map(e => e.date), ['2025-06-01', '2025-01-02']);
  assert.deepEqual(view.groups[1].entries.map(e => e.date), ['2024-12-30', '2024-05-01']);
});

test('release 1: notes never enter the view, even with showText on', async () => {
  const { NOTES_ON_PAGE } = await import('../../src/lib/shared-diary/view-model');
  assert.equal(NOTES_ON_PAGE, false);
  const view = buildSharedDiaryView(payload([{ show_id: 'wicked', date_seen: '2025-01-02', rating: 4, text: 'SECRET' }], true), SHOWS, NOW);
  assert.ok(!JSON.stringify(view).includes('SECRET'));
});

test('ownerDiaryPayload matches get_shared_diary: rows up to UTC today, same order, 1,000 cap', async () => {
  const { ownerDiaryPayload, DIARY_SHARE_CAP } = await import('../../src/lib/shared-diary/select');
  const reviews = Array.from({ length: DIARY_SHARE_CAP + 5 }, (_, i) => ({
    id: `r${i}`, show_id: i % 2 ? 'wicked' : 'gypsy', rating: 4,
    date_seen: new Date(Date.UTC(2020, 0, 1) + i * 86_400_000).toISOString(), created_at: '2020-01-01',
  }));
  reviews.push({ id: 'future', show_id: 'hamilton', rating: 5, date_seen: '2026-10-05T00:00:00Z', created_at: '2026-01-01' });
  reviews.push({ id: 'utc-today', show_id: 'six-we', rating: 5, date_seen: '2026-10-04', created_at: '2026-01-01' });
  const p = ownerDiaryPayload(reviews, NOW);
  assert.equal(p.capped, true);
  assert.equal(p.entries.length, DIARY_SHARE_CAP);
  assert.equal(p.entries[0].show_id, 'six-we', 'UTC today is returned (the page then applies venue-local today)');
  assert.ok(!p.entries.some(e => e.show_id === 'hamilton'), 'future rows are plans');
  assert.ok(p.entries.every(e => e.date_seen === null || e.date_seen.length === 10), 'timestamps trimmed to dates');
  assert.equal(ownerDiaryPayload(reviews.slice(0, 3), NOW).capped, false);
});
