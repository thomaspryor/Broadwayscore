/**
 * BRO-6877: src/lib/data-showtimes reads the past-week archive for dates
 * before the live window, and only when the caller passes it.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scheduledShowtime,
  isKnownDarkForSlot,
  onlyPerformanceSlot,
  needsScheduleHistory,
  getScheduleCurrentMonday,
} from '../../src/lib/data-showtimes';
import type { ShowSchedule } from '../../src/lib/data-types';
import history from '../../data/show-schedule-history.json';

const archive = (history as unknown as { shows: Record<string, ShowSchedule> }).shows;

test('a covered past date resolves from the archive only when it is passed', () => {
  const om = archive['oh-mary-2024'];
  assert.ok(om, 'Oh, Mary! is archived');
  assert.equal(scheduledShowtime('oh-mary-2024', '2026-05-16', 'matinee'), null, 'without the archive: unknown');
  assert.equal(scheduledShowtime('oh-mary-2024', '2026-05-16', 'matinee', om), '17:00');
  assert.equal(scheduledShowtime('oh-mary-2024', '2026-05-16', 'evening', om), '20:30');
  assert.equal(isKnownDarkForSlot('oh-mary-2024', '2026-05-11', 'evening', om), true, 'Monday dark night');
  assert.equal(isKnownDarkForSlot('oh-mary-2024', '2026-05-11', 'evening'), false, 'no archive, no dark claim');
  assert.equal(onlyPerformanceSlot('oh-mary-2024', '2026-05-12', om), 'evening');
});

test('a date before the archive still has no time', () => {
  const om = archive['oh-mary-2024'];
  assert.equal(scheduledShowtime('oh-mary-2024', '2026-02-14', 'evening', om), null);
  assert.equal(isKnownDarkForSlot('oh-mary-2024', '2026-02-14', 'evening', om), false);
});

test('needsScheduleHistory: only started weeks the live file lacks', () => {
  const m = getScheduleCurrentMonday();
  const iso = `${m.slice(0, 4)}-${m.slice(4, 6)}-${m.slice(6, 8)}`;
  assert.equal(needsScheduleHistory('oh-mary-2024', iso), false, 'this week is live for a running show');
  assert.equal(needsScheduleHistory('not-a-live-show', iso), true, 'a show gone from the live file this week');
  assert.equal(needsScheduleHistory('oh-mary-2024', '2026-05-16'), true);
  assert.equal(needsScheduleHistory('oh-mary-2024', '2099-01-01'), false, 'future dates never fetch');
  assert.equal(needsScheduleHistory('oh-mary-2024', ''), false);
});
