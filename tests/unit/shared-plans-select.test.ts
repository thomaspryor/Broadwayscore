/**
 * Shared Plans selection rule (src/lib/shared-plans/select.ts, BRO-4481).
 * Driven by tests/fixtures/shared-plans-parity.json — the same cases the SQL
 * function and the iOS port are tested against.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectSharedPlans, toSharedEntries, venueToday, type PlanShowLike } from '../../src/lib/shared-plans/select';

interface FixtureCase {
  name: string;
  now?: string;
  show: PlanShowLike & { category: string; status: string };
  plannedOffset: number | null;
  reviews: Array<{ seenOffset: number | null }>;
  expected: 'booked' | 'unbooked' | 'excluded';
  sqlIncluded: boolean;
  sqlLogged?: boolean;
}
const fixture = JSON.parse(
  readFileSync(join(__dirname, '..', 'fixtures', 'shared-plans-parity.json'), 'utf-8'),
) as { defaults: { now: string }; cases: FixtureCase[] };

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function bucketFor(c: FixtureCase) {
  const nowMs = Date.parse(c.now ?? fixture.defaults.now);
  const today = venueToday(c.show.category, nowMs);
  const planned = c.plannedOffset === null ? null : addDays(today, c.plannedOffset);
  const reviews = c.reviews.map(r => ({
    show_id: c.show.id,
    date_seen: r.seenOffset === null ? null : addDays(today, r.seenOffset),
  }));
  const entries = toSharedEntries([{ show_id: c.show.id, planned_date: planned }], reviews);
  const out = selectSharedPlans(
    { showBooked: true, showUnbooked: true, entries },
    new Map([[c.show.id, c.show]]),
    nowMs,
  );
  const bucket = out.booked.length ? 'booked' : out.unbooked.length ? 'unbooked' : 'excluded';
  return { bucket, logged: entries[0].logged, out };
}

for (const c of fixture.cases) {
  test(`parity: ${c.name}`, () => {
    const { bucket, logged } = bucketFor(c);
    assert.equal(bucket, c.expected);
    // The TS `logged` rule must match the SQL function's for every row the
    // database returns.
    if (c.sqlIncluded) assert.equal(logged, c.sqlLogged, 'logged flag matches SQL');
  });
}

test('venueToday: 23:30 in New York is still that New York date from anywhere', () => {
  // 2026-10-11T03:30Z = Oct 10, 23:30 in New York = Oct 11, 12:30 in Tokyo.
  assert.equal(venueToday('broadway', Date.parse('2026-10-11T03:30:00Z')), '2026-10-10');
});

test('venueToday: unmapped market falls back to New York', () => {
  assert.equal(venueToday('regional', Date.parse('2026-10-11T02:00:00Z')), '2026-10-10');
  assert.equal(venueToday(null, Date.parse('2026-10-11T02:00:00Z')), '2026-10-10');
});

test('venueToday: West End uses London across the clock change', () => {
  // 00:30Z on 2026-10-25 is 01:30 BST, still Oct 25 in London.
  assert.equal(venueToday('west-end', Date.parse('2026-10-25T00:30:00Z')), '2026-10-25');
  // 23:30Z on 2026-10-25 is 23:30 GMT (clocks went back), still Oct 25.
  assert.equal(venueToday('west-end', Date.parse('2026-10-25T23:30:00Z')), '2026-10-25');
});

test('booked rows sort soonest first; unbooked keep watchlist order', () => {
  const shows = new Map<string, PlanShowLike>([
    ['a', { id: 'a', category: 'broadway', status: 'open' }],
    ['b', { id: 'b', category: 'broadway', status: 'open' }],
    ['c', { id: 'c', category: 'broadway', status: 'open' }],
    ['d', { id: 'd', category: 'broadway', status: 'open' }],
    ['e', { id: 'e', category: 'broadway', status: 'open' }],
  ]);
  const out = selectSharedPlans({
    showBooked: true, showUnbooked: true,
    entries: [
      { show_id: 'a', planned_date: '2026-12-01', logged: false },
      { show_id: 'd', planned_date: null, logged: false },
      { show_id: 'b', planned_date: '2026-10-20', logged: false },
      { show_id: 'e', planned_date: null, logged: false },
      { show_id: 'c', planned_date: '2026-11-05', logged: false },
    ],
  }, shows, Date.parse('2026-10-10T16:00:00Z'));
  assert.deepEqual(out.booked.map(b => b.show.id), ['b', 'c', 'a']);
  assert.deepEqual(out.unbooked.map(u => u.show.id), ['d', 'e']);
  assert.deepEqual(out.counts, { booked: 3, unbooked: 2 });
});

test('section toggles and unknown ids', () => {
  const shows = new Map<string, PlanShowLike>([
    ['a', { id: 'a', category: 'broadway', status: 'open' }],
    ['b', { id: 'b', category: 'broadway', status: 'open' }],
  ]);
  const entries = [
    { show_id: 'a', planned_date: '2026-12-01', logged: false },
    { show_id: 'b', planned_date: null, logged: false },
    { show_id: 'gone-1999', planned_date: null, logged: false },
  ];
  const now = Date.parse('2026-10-10T16:00:00Z');
  assert.deepEqual(selectSharedPlans({ showBooked: false, showUnbooked: true, entries }, shows, now).counts, { booked: 0, unbooked: 1 });
  assert.deepEqual(selectSharedPlans({ showBooked: true, showUnbooked: false, entries }, shows, now).counts, { booked: 1, unbooked: 0 });
});
