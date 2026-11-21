/**
 * Diary Upcoming must include a planned rewatch of an already-rated show.
 * Requires the real module.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectToBeRatedWatchlistEntries, selectUpcomingWatchlistEntries } from '../../src/lib/diary-upcoming';

const TODAY = '2026-10-19';

test('rewatch of a rated show with a future planned date is upcoming', () => {
  const out = selectUpcomingWatchlistEntries(
    [{ show_id: 'oh-mary-2024', planned_date: '2026-11-14' }],
    [{ show_id: 'oh-mary-2024', date_seen: '2026-01-08' }],
    TODAY,
  );
  assert.deepEqual(out.map(e => e.show_id), ['oh-mary-2024']);
});

test('entry already represented by a future-dated review is not duplicated', () => {
  const out = selectUpcomingWatchlistEntries(
    [{ show_id: 'a', planned_date: '2026-11-14' }],
    [{ show_id: 'a', date_seen: '2026-11-14' }],
    TODAY,
  );
  assert.equal(out.length, 0);
});

test('undated and past-dated entries are excluded, rest sorted soonest first', () => {
  const out = selectUpcomingWatchlistEntries(
    [
      { show_id: 'late', planned_date: '2027-01-05' },
      { show_id: 'none', planned_date: null },
      { show_id: 'past', planned_date: '2026-10-01' },
      { show_id: 'soon', planned_date: '2026-10-25' },
    ],
    [],
    TODAY,
  );
  assert.deepEqual(out.map(e => e.show_id), ['soon', 'late']);
});

test('rewatch planned for today is to be rated, not hidden by the older review', () => {
  const wl = [{ show_id: 'oh-mary-2024', planned_date: TODAY }];
  const rv = [{ show_id: 'oh-mary-2024', date_seen: '2026-01-08' }];
  assert.equal(selectUpcomingWatchlistEntries(wl, rv, TODAY).length, 0);
  assert.equal(selectToBeRatedWatchlistEntries(wl, rv, TODAY).length, 1);
});

test('review dated on or after the planned date represents the entry', () => {
  const wl = [{ show_id: 'a', planned_date: '2026-10-10' }];
  assert.equal(selectToBeRatedWatchlistEntries(wl, [{ show_id: 'a', date_seen: '2026-10-10' }], TODAY).length, 0);
  assert.equal(selectToBeRatedWatchlistEntries(wl, [{ show_id: 'a', date_seen: '2026-10-12' }], TODAY).length, 0);
  assert.equal(selectToBeRatedWatchlistEntries(wl, [{ show_id: 'a', date_seen: '2026-01-08' }], TODAY).length, 1);
});

test('an earlier future review does not hide a later separate plan', () => {
  const out = selectUpcomingWatchlistEntries(
    [{ show_id: 'a', planned_date: '2026-11-14' }],
    [{ show_id: 'a', date_seen: '2026-11-01' }],
    TODAY,
  );
  assert.equal(out.length, 1);
});
