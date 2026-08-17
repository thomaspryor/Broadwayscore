/**
 * Unit tests for the showtime-picker default resolution (src/lib/data-showtimes)
 * and the watchlist-entry → PerformanceEvent glue (src/lib/calendar-event).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveShowtimeDefault,
  mondayOfWeekYyyymmdd,
  weekdayIndexMonFirst,
} from '../../src/lib/data-showtimes';
import { buildPlannedShowEvent } from '../../src/lib/calendar-event';
import { addDaysToYyyymmdd } from '../../src/lib/calendar';
import scheduleData from '../../data/show-schedules.json';

test('mondayOfWeekYyyymmdd finds the Monday for any day of the week', () => {
  assert.equal(mondayOfWeekYyyymmdd('2026-08-10'), '20260810', 'a Monday maps to itself');
  assert.equal(mondayOfWeekYyyymmdd('2026-08-16'), '20260810', 'a Sunday maps back to the same week\'s Monday');
  assert.equal(mondayOfWeekYyyymmdd('2026-08-17'), '20260817', 'the next Monday starts a new week');
});

test('weekdayIndexMonFirst matches WeekSchedule\'s Mon=0..Sun=6 order', () => {
  assert.equal(weekdayIndexMonFirst('2026-08-10'), 0, 'Monday');
  assert.equal(weekdayIndexMonFirst('2026-08-12'), 2, 'Wednesday');
  assert.equal(weekdayIndexMonFirst('2026-08-15'), 5, 'Saturday');
  assert.equal(weekdayIndexMonFirst('2026-08-16'), 6, 'Sunday');
});

test('resolveShowtimeDefault falls back to a generic time for an unknown show', () => {
  assert.equal(resolveShowtimeDefault('not-a-real-show-id', '2026-09-14', 'matinee'), '14:00');
  assert.equal(resolveShowtimeDefault('not-a-real-show-id', '2026-09-14', 'evening'), '19:00');
});

test('resolveShowtimeDefault falls back to a generic time for a date outside the covered weeks', () => {
  // bwayrush only publishes a few weeks out — a date years away can never be covered.
  const anyShowId = Object.keys((scheduleData as { shows: Record<string, unknown> }).shows)[0];
  assert.equal(resolveShowtimeDefault(anyShowId, '2031-01-06', 'matinee'), '14:00');
  assert.equal(resolveShowtimeDefault(anyShowId, '2031-01-06', 'evening'), '19:00');
});

test('resolveShowtimeDefault reads the real scheduled time when the date IS covered', () => {
  // Cross-checks against whatever the schedule data currently contains rather
  // than a hardcoded clock time, so this doesn't flake as bwayrush data rolls
  // forward week to week.
  const shows = (scheduleData as { shows: Record<string, { weeks: Record<string, { m: string | null; e: string | null }[]> }> }).shows;
  let found: { showId: string; date: string; slot: 'matinee' | 'evening'; time: string } | null = null;
  outer:
  for (const [showId, sched] of Object.entries(shows)) {
    for (const [monday, week] of Object.entries(sched.weeks)) {
      for (let i = 0; i < 7; i++) {
        const day = week[i];
        if (day.e) { found = { showId, date: addDaysToYyyymmdd(monday, i), slot: 'evening', time: day.e }; break outer; }
        if (day.m) { found = { showId, date: addDaysToYyyymmdd(monday, i), slot: 'matinee', time: day.m }; break outer; }
      }
    }
  }
  assert.ok(found, 'expected at least one scheduled performance in show-schedules.json');
  assert.equal(resolveShowtimeDefault(found!.showId, found!.date, found!.slot), found!.time);
});

const SHOW = {
  id: 'wicked-2003',
  title: 'Wicked',
  slug: 'wicked',
  category: 'broadway',
  venue: 'Gershwin Theatre',
  theaterAddress: '222 W 51st St, New York, NY 10019',
  runtimeMin: 165,
};

test('buildPlannedShowEvent is null without both a date and a curtain time', () => {
  assert.equal(buildPlannedShowEvent(SHOW, { planned_date: null, curtain_time: null }), null);
  assert.equal(buildPlannedShowEvent(SHOW, { planned_date: '2026-09-11', curtain_time: null }), null);
  // A curtain time with no date shouldn't happen (useWatchlist clears both
  // together), but the builder must fail closed if it ever does.
  assert.equal(buildPlannedShowEvent(SHOW, { planned_date: null, curtain_time: '20:00:00' }), null);
});

test('buildPlannedShowEvent resolves market timezone, duration, and location from the show', () => {
  const ev = buildPlannedShowEvent(SHOW, { planned_date: '2026-09-11', curtain_time: '20:00:00' });
  assert.deepEqual(ev, {
    showId: 'wicked-2003',
    title: 'Wicked',
    date: '2026-09-11',
    time: '20:00',
    tz: 'America/New_York',
    durationMin: 180, // 165 runtimeMin + 15 CURTAIN_BUFFER_MIN
    location: '222 W 51st St, New York, NY 10019',
    showUrl: 'https://broadwayscorecard.com/show/wicked',
  });
});

test('buildPlannedShowEvent falls back to venue when there is no theaterAddress, and to the parsed runtime default when there is no runtimeMin', () => {
  const ev = buildPlannedShowEvent(
    { id: 'x-1', title: 'X', slug: 'x', category: 'west-end', venue: 'Some Theatre', runtime: '2h 30m' },
    { planned_date: '2026-09-11', curtain_time: '19:30:00' },
  );
  assert.equal(ev!.location, 'Some Theatre');
  assert.equal(ev!.tz, 'Europe/London');
  assert.equal(ev!.durationMin, 165); // 150 parsed + 15 buffer
});

test('buildPlannedShowEvent routes diary-only shows to /diary-show', () => {
  const ev = buildPlannedShowEvent(
    { id: 'diary-1', title: 'Regional Thing', slug: 'diary-1', diaryOnly: true },
    { planned_date: '2026-09-11', curtain_time: '19:00:00' },
  );
  assert.equal(ev!.showUrl, 'https://broadwayscorecard.com/diary-show/diary-1');
});
