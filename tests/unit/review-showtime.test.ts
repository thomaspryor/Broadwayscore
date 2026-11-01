/**
 * BRO-6783: time + seat on diary entries. Pure helpers in src/lib/review-showtime
 * and the new schedule helpers in src/lib/data-showtimes.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShowtimeSeatPatch, normalizeSeat, diaryDetailText, showtimeText } from '../../src/lib/review-showtime';
import { onlyPerformanceSlot, scheduledShowtime, isKnownDarkForSlot } from '../../src/lib/data-showtimes';
import scheduleData from '../../data/show-schedules.json';

const NONE = { time_slot: null, curtain_time: null, seat: null };

test('a rating with no time and no seat sends none of the new columns (pre-migration safe)', () => {
  assert.deepEqual(buildShowtimeSeatPatch(null, NONE), {});
  assert.deepEqual(buildShowtimeSeatPatch({ time_slot: null, curtain_time: null, seat: null }, NONE), {});
});

test('set values are sent; values cleared on edit are sent as null', () => {
  assert.deepEqual(
    buildShowtimeSeatPatch(null, { time_slot: 'evening', curtain_time: '19:00:00', seat: 'A-25' }),
    { time_slot: 'evening', curtain_time: '19:00:00', seat: 'A-25' },
  );
  assert.deepEqual(
    buildShowtimeSeatPatch({ time_slot: 'matinee', curtain_time: '14:00:00', seat: 'C14' }, NONE),
    { time_slot: null, curtain_time: null, seat: null },
  );
  // Seat only: the time columns stay out of the payload.
  assert.deepEqual(buildShowtimeSeatPatch(null, { ...NONE, seat: 'Row J' }), { seat: 'Row J' });
});

test('never sends a curtain_time without a slot (DB constraint)', () => {
  const p = buildShowtimeSeatPatch(null, { time_slot: null, curtain_time: '19:00:00', seat: null });
  assert.equal(p.curtain_time ?? null, null);
});

test('normalizeSeat trims, collapses spaces, caps at 40, empty is null', () => {
  assert.equal(normalizeSeat('  Dress   Circle  C14 '), 'Dress Circle C14');
  assert.equal(normalizeSeat('   '), null);
  assert.equal(normalizeSeat(null), null);
  assert.equal(normalizeSeat('x'.repeat(60))!.length, 40);
});

test('detail text reads like the diary row', () => {
  assert.equal(showtimeText({ time_slot: 'evening', curtain_time: '19:30:00' }), 'Evening · 7:30 PM');
  assert.equal(showtimeText({ time_slot: 'matinee', curtain_time: null }), 'Matinee');
  assert.equal(diaryDetailText({ time_slot: 'custom', curtain_time: '20:00:00', seat: 'A-25' }), '8:00 PM · Seat A-25');
  assert.equal(diaryDetailText({ seat: 'Balcony B3' }), 'Seat Balcony B3');
  assert.equal(diaryDetailText({}), null);
  assert.equal(diaryDetailText(undefined), null);
});

test('onlyPerformanceSlot picks the one show on a single-performance day, else null', () => {
  const shows = (scheduleData as { shows: Record<string, { weeks: Record<string, ({ m: string | null; e: string | null } | null)[]> }> }).shows;
  let single: { id: string; date: string; slot: 'matinee' | 'evening' } | null = null;
  let double: { id: string; date: string } | null = null;
  for (const [id, s] of Object.entries(shows)) {
    for (const [monday, days] of Object.entries(s.weeks)) {
      days.forEach((d, i) => {
        if (!d) return;
        const dt = new Date(+monday.slice(0, 4), +monday.slice(4, 6) - 1, +monday.slice(6, 8) + i);
        const date = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
        if (!single && d.e && d.m === null) single = { id, date, slot: 'evening' };
        if (!double && d.e && d.m) double = { id, date };
      });
    }
  }
  assert.ok(single && double, 'schedule data has both single- and two-show days');
  const sg = single as unknown as { id: string; date: string; slot: 'evening' };
  assert.equal(onlyPerformanceSlot(sg.id, sg.date), 'evening');
  assert.ok(scheduledShowtime(sg.id, sg.date, 'evening'));
  assert.equal(isKnownDarkForSlot(sg.id, sg.date, 'matinee'), true);
  const db = double as unknown as { id: string; date: string };
  assert.equal(onlyPerformanceSlot(db.id, db.date), null);
  // Uncovered date or unknown show: never a guess.
  assert.equal(onlyPerformanceSlot('no-such-show', '2026-11-04'), null);
  assert.equal(scheduledShowtime('no-such-show', '2026-11-04', 'evening'), null);
});
