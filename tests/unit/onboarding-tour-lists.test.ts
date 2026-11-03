/**
 * Quiz onboarding lists for touring cities (BRO-6734): a touring-city pick
 * must get the tours that played there and the tours booked there, never New
 * York's lists. Calls the real exported functions (CLAUDE.md rule 15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cityLists, isLetterboxed, nationalTopTours, stopDates, SEEN_MIN, WANT_MIN, type TourIn } from '../../scripts/lib/onboarding-tour-lists';

const today = '2026-11-03';
const windowStart = '2016-11-03';
const art: Record<string, { poster: string; showId: string; days: number }> = {
  Hamilton: { poster: '/p/ham.webp', showId: 'hamilton-2015', days: 3000 },
  Wicked: { poster: '/p/wicked.webp', showId: 'wicked-2003', days: 3500 },
  Beetlejuice: { poster: '/p/bj.webp', showId: 'beetlejuice-2019', days: 900 },
  SIX: { poster: '/p/six.webp', showId: 'six-2021', days: 1500 },
  Iceboy: { poster: '/p/iceboy.webp', showId: 'iceboy-2026', days: 50 },
};
const stop = (city: string, start: string, end: string, venue = 'Opera House') => ({ city, start, end, venue });
const tours: TourIn[] = [
  { id: 'hamilton-tour-2024', title: 'Hamilton', status: 'open', score: 87, stops: [stop('Boston, MA', '2025-01-01', '2025-02-01'), stop('Denver, CO', '2027-01-01', '2027-01-20')] },
  { id: 'wicked-tour-2022', title: 'Wicked', status: 'open', score: 80, stops: [stop('Boston, MA', '2026-10-20', '2026-11-15'), stop('Abilene, TX', '2027-03-01', '2027-03-05')] },
  { id: 'beetlejuice-tour-2022', title: 'Beetlejuice', status: 'closed', score: 70, stops: [stop('Boston, MA', '2023-05-01', '2023-05-10')] },
  { id: 'beetlejuice-tour-2026', title: 'Beetlejuice', status: 'open', score: 72, stops: [stop('Boston, MA', '2027-02-09', '2027-02-21', 'Wang Theatre')] },
  { id: 'six-tour-2022', title: 'SIX', status: 'open', score: 75, stops: [stop('Denver, CO', '2024-01-01', '2024-01-10')] },
  { id: 'iceboy-tour-2026', title: 'Iceboy', status: 'open', score: 60, stops: [stop('Boston, MA', '2026-01-01', '2026-01-09')] },
];
const base = {
  tours, today, windowStart,
  art: (t: string) => art[t] ?? null,
  badPoster: (p: string) => p === '/p/iceboy.webp',
};

test('Seen: tours that already played the city, biggest first; future stops and padded posters left out', () => {
  const { seen } = cityLists({ ...base, cityName: 'Boston, MA' });
  assert.deepEqual(seen.map(r => r.title), ['Wicked', 'Hamilton', 'Beetlejuice']);
  // Beetlejuice's 2027 stop has not happened, so only the 2022 tour is a production you could have seen.
  const bj = seen.find(r => r.title === 'Beetlejuice')!;
  assert.deepEqual(bj.productions.map(p => p.showId), ['beetlejuice-tour-2022']);
  assert.equal(bj.productions[0].label, 'The tour in 2023');
  // Tour rows use the tour's id (what the diary saves) and the Broadway art.
  assert.equal(seen[1].showId, 'hamilton-tour-2024');
  assert.equal(seen[1].broadwayId, 'hamilton-2015');
});

test('Seen tops up to two full rows from the national list, never past it', () => {
  const topUp = nationalTopTours(base);
  assert.ok(topUp.every(r => r.showId.includes('-tour-')), 'top-up rows are tours');
  const { seen } = cityLists({ ...base, cityName: 'Abilene, TX', topUp });
  assert.ok(seen.length <= SEEN_MIN);
  assert.deepEqual(new Set(seen.map(r => r.title)).size, seen.length, 'no title twice');
});

test('Chicago keeps a row for its local hits', () => {
  const local = Array.from({ length: 6 }, (_, i) => ({ title: `Local ${i}`, showId: `local-${i}`, poster: `/p/l${i}.webp`, days: 10, score: null, productions: [{ showId: `local-${i}`, opened: '2024-01-01', closed: '2024-02-01' }] }));
  const { seen } = cityLists({ ...base, cityName: 'Boston, MA', localSeen: local });
  assert.deepEqual(seen.slice(0, 3).map(r => r.title), ['Wicked', 'Hamilton', 'Beetlejuice']);
  assert.ok(seen.some(r => r.title === 'Local 0'));
});

test('Want: stops still to come in the city, soonest first, with dates and venue', () => {
  const { want, stops } = cityLists({ ...base, cityName: 'Boston, MA' });
  assert.deepEqual(want.slice(0, 2).map(w => w.showId), ['wicked-tour-2022', 'beetlejuice-tour-2026']);
  assert.equal(want[1].note, 'Feb 9 to 21, 2027 · Wang Theatre');
  assert.ok(want.every(w => w.category === 'tour'));
  assert.equal(stops, 5, 'every engagement in the window counts, including the padded-poster one');
});

test('Want tops a small city up to two rows with tours on the road, labelled', () => {
  const { want } = cityLists({ ...base, cityName: 'Abilene, TX' });
  assert.equal(want[0].showId, 'wicked-tour-2022');
  const extra = want.slice(1);
  assert.ok(want.length <= WANT_MIN);
  assert.ok(extra.length > 0 && extra.every(w => w.note === 'On tour, not booked in Abilene yet'));
});

test('stopDates never uses an en dash', () => {
  assert.equal(stopDates('2027-03-03', '2027-03-15'), 'Mar 3 to 15, 2027');
  assert.equal(stopDates('2027-03-28', '2027-04-04'), 'Mar 28 to Apr 4, 2027');
  assert.equal(stopDates('2026-12-30', '2027-01-04'), 'Dec 30, 2026 to Jan 4, 2027');
  assert.equal(stopDates('2027-05-12', '2027-05-12'), 'May 12, 2027');
});

test('isLetterboxed: wide art between two blurred bands is flagged, a full poster is not', () => {
  const w = 40, h = 60;
  const img = (bandRows: number) => {
    const g = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const inBand = y < bandRows || y >= h - bandRows;
      // Blurred band: smooth vertical shading. Picture: busy checkerboard.
      g[y * w + x] = inBand ? 60 + y : ((x + y) % 2 ? 200 : 20);
    }
    return g;
  };
  assert.equal(isLetterboxed(img(18), w, h), true, 'landscape art: 30% bands');
  assert.equal(isLetterboxed(img(6), w, h), false, 'square art: thin bands read fine');
  assert.equal(isLetterboxed(img(0), w, h), false, 'a real poster');
});
