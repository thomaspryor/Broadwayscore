/**
 * Shared Plans view model (src/lib/shared-plans/view-model.ts, BRO-4481).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSharedPlansView, plansSummary, plansTitle } from '../../src/lib/shared-plans/view-model';
import { decodeEventParams, encodeEventParams } from '../../src/lib/calendar';
import type { PlanShow } from '../../src/lib/shared-plans/resolve';

function show(id: string, extra: Partial<PlanShow> = {}): PlanShow {
  return {
    id, title: id.toUpperCase(), href: `/show/${id}`, posterUrl: null, venue: 'Venue', category: 'broadway', status: 'open',
    bookability: { status: 'open' }, calendar: { id, title: id.toUpperCase(), slug: id, category: 'broadway', venue: 'Venue', theaterAddress: '1 Main St' },
    ...extra,
  };
}

const NOW = Date.parse('2026-10-10T16:00:00Z');

test('builds booked rows with date label and all-day calendar links', () => {
  const shows = new Map([['wicked', show('wicked')], ['hamlet', show('hamlet')]]);
  const v = buildSharedPlansView({
    name: 'Tom', showBooked: true, showUnbooked: true,
    entries: [
      { show_id: 'wicked', planned_date: '2026-10-18', logged: false },
      { show_id: 'hamlet', planned_date: null, logged: false },
    ],
  }, shows, NOW);
  assert.equal(v.name, 'Tom');
  assert.deepEqual(v.counts, { booked: 1, unbooked: 1 });
  const b = v.booked[0];
  assert.equal(b.dateLabel, 'Oct 18', 'My Shows Upcoming grid label');
  // The event round-trips through the .ics URL codec AddToCalendarButtons uses.
  const ev = decodeEventParams(encodeEventParams(b.event!))!;
  assert.equal(ev.date, '2026-10-18');
  assert.equal(ev.time, null, 'all-day when the owner picked no showtime');
  assert.deepEqual(ev.companions, ['Tom']);
  assert.equal(ev.title, 'WICKED', 'no extra emoji or "(with …)" in the title');
  assert.equal(v.unbooked[0].id, 'hamlet');
});

test('date label is stable in any process timezone', () => {
  const prev = process.env.TZ;
  try {
    for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
      process.env.TZ = tz;
      const v = buildSharedPlansView({
        name: 'Tom', showBooked: true, showUnbooked: true,
        entries: [{ show_id: 'wicked', planned_date: '2026-10-18', logged: false }],
      }, new Map([['wicked', show('wicked')]]), NOW);
      assert.equal(v.booked[0].dateLabel, 'Oct 18', tz);
    }
  } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
});

test('plansTitle handles names ending in s', () => {
  assert.equal(plansTitle('Tom'), 'Tom’s theater plans');
  assert.equal(plansTitle('Chris'), 'Chris’ theater plans');
  assert.equal(plansTitle('  Bea '), 'Bea’s theater plans');
});

test('plansSummary leaves out empty sections', () => {
  assert.equal(plansSummary({ booked: 3, unbooked: 7 }), '3 upcoming · 7 not yet booked');
  assert.equal(plansSummary({ booked: 0, unbooked: 2 }), '2 not yet booked');
  assert.equal(plansSummary({ booked: 1, unbooked: 0 }), '1 upcoming');
  assert.equal(plansSummary({ booked: 0, unbooked: 0 }), 'Nothing planned right now');
});

test('booked row with a curtain time gets a timed event for the show runtime (owner 2026-11-01)', () => {
  const shows = new Map([['wicked', show('wicked', {
    calendar: { id: 'wicked', title: 'WICKED', slug: 'wicked', category: 'broadway', venue: 'Venue', theaterAddress: '1 Main St', runtime: '2h 45m' },
  })]]);
  const v = buildSharedPlansView({
    name: 'Tom', showBooked: true, showUnbooked: true,
    entries: [{ show_id: 'wicked', planned_date: '2026-10-18', curtain_time: '14:00:00', logged: false }],
  }, shows, NOW);
  const ev = decodeEventParams(encodeEventParams(v.booked[0].event!))!;
  assert.equal(ev.time, '14:00', 'the matinee the owner picked, not all-day');
  assert.equal(ev.tz, 'America/New_York');
  assert.ok(ev.durationMin >= 165, `runtime-based duration, got ${ev.durationMin}`);
});

test('booked row without a curtain time (or from the old RPC) stays all-day', () => {
  const shows = new Map([['wicked', show('wicked')]]);
  for (const entry of [
    { show_id: 'wicked', planned_date: '2026-10-18', curtain_time: null, logged: false },
    { show_id: 'wicked', planned_date: '2026-10-18', logged: false },
  ]) {
    const v = buildSharedPlansView({ name: 'Tom', showBooked: true, showUnbooked: true, entries: [entry] }, shows, NOW);
    assert.equal(decodeEventParams(encodeEventParams(v.booked[0].event!))!.time, null);
  }
});
