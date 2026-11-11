// BRO-7376: opening-night "reviews still arriving" decision layer. Real functions, no copies (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  windowCount, expectedFromCounts, expectedForShow, reviewArrivalPhase, splitRegularOutlets, buildReviewArrival,
  arrivalWindowEndMs, pressNightEmbargoMs, ARRIVAL_WINDOW_HOURS, type ExpectedCount, type HistoryShow,
} from '../../src/lib/review-arrival';

const OPEN = '2026-11-15';
const exp = (expected: number): ExpectedCount => ({ expected, median: expected, low: expected - 3, high: expected + 3, n: 10 });
const at = (iso: string) => new Date(iso);
const base = { openingDate: OPEN, category: 'broadway', expected: exp(30) };

test('window is 72h after the press-night embargo', () => {
  assert.equal(arrivalWindowEndMs(OPEN)! - pressNightEmbargoMs(OPEN)!, ARRIVAL_WINDOW_HOURS * 3600000);
});

test('windowCount keeps reviews up to 3 days after opening, drops later ones, keeps undated', () => {
  assert.equal(windowCount(['2026-11-15', '2026-11-16', '2026-11-18', '2026-11-19', '2026-12-30', null], OPEN), 4);
});

test('expectedFromCounts: median rounded to 5, ignores zeros, null with no history', () => {
  assert.equal(expectedFromCounts([]), null);
  assert.equal(expectedFromCounts([0, 0]), null);
  const e = expectedFromCounts([19, 23, 27, 32, 33])!;
  assert.equal(e.median, 27);
  assert.equal(e.expected, 25);
  assert.equal(e.n, 5);
});

function h(id: string, openingDate: string, n: number, category = 'broadway'): HistoryShow {
  return { id, category, openingDate, reviewDates: Array.from({ length: n }, () => openingDate) };
}

test('expectedForShow uses only earlier Broadway openings, latest 10, never itself', () => {
  const history = [
    ...Array.from({ length: 12 }, (_, i) => h(`old${i}`, `2026-0${1 + (i % 9)}-01`, 10)),
    h('recent-a', '2026-11-01', 40), h('recent-b', '2026-11-02', 40), h('future', '2026-12-01', 99),
    h('offb', '2026-11-03', 5, 'off-broadway'), h('self', OPEN, 77),
  ];
  const e = expectedForShow({ id: 'self', category: 'broadway', openingDate: OPEN }, history)!;
  assert.equal(e.n, 10);
  assert.ok(e.median >= 10 && e.median <= 40);
  assert.equal(expectedForShow({ id: 'x', category: 'off-broadway', openingDate: OPEN }, history), null);
});

test('phase: hidden before opening-day noon, after the window, off-Broadway, with no expectation', () => {
  const i = { ...base, reviewCount: 0, scoreShowing: false };
  assert.equal(reviewArrivalPhase({ ...i, now: at('2026-11-15T10:00:00Z') }), null);
  assert.equal(reviewArrivalPhase({ ...i, now: at('2026-11-19T12:00:00Z') }), null);
  assert.equal(reviewArrivalPhase({ ...i, now: at('2026-11-15T20:00:00Z'), category: 'off-broadway' }), null);
  assert.equal(reviewArrivalPhase({ ...i, now: at('2026-11-15T20:00:00Z'), expected: null }), null);
});

test('phase: waiting, below-minimum, early, nearly-complete, then settled (hidden)', () => {
  const now = at('2026-11-16T06:00:00Z');
  assert.equal(reviewArrivalPhase({ ...base, now, reviewCount: 0, scoreShowing: false }), 'waiting');
  assert.equal(reviewArrivalPhase({ ...base, now, reviewCount: 3, scoreShowing: false }), 'below-minimum');
  assert.equal(reviewArrivalPhase({ ...base, now, reviewCount: 8, scoreShowing: true }), 'early');
  assert.equal(reviewArrivalPhase({ ...base, now, reviewCount: 24, scoreShowing: true }), 'nearly-complete');
  assert.equal(reviewArrivalPhase({ ...base, now: at('2026-11-20T00:00:00Z'), reviewCount: 30, scoreShowing: true }), null);
});

test('splitRegularOutlets is case-insensitive and keeps order', () => {
  const regular = [{ id: 'nytimes', name: 'NYT' }, { id: 'vulture', name: 'Vulture' }, { id: 'variety', name: 'Variety' }];
  const s = splitRegularOutlets(regular, ['NYTimes', 'variety']);
  assert.deepEqual(s.inNow.map((o) => o.id), ['nytimes', 'variety']);
  assert.deepEqual(s.stillToCome.map((o) => o.id), ['vulture']);
});

test('buildReviewArrival returns null when hidden and a full payload when shown', () => {
  assert.equal(buildReviewArrival({ ...base, now: at('2026-11-25T00:00:00Z'), reviewCount: 30, scoreShowing: true }), null);
  const a = buildReviewArrival({
    ...base, now: at('2026-11-16T06:00:00Z'), reviewCount: 8, scoreShowing: true,
    regular: [{ id: 'nytimes', name: 'NYT' }, { id: 'vulture', name: 'Vulture' }], haveOutletIds: ['nytimes'],
  })!;
  assert.equal(a.phase, 'early');
  assert.equal(a.expected, 30);
  assert.equal(a.regularIn.length, 1);
  assert.equal(a.regularToCome[0].name, 'Vulture');
  assert.ok(a.hoursLeft > 0 && a.hoursLeft < ARRIVAL_WINDOW_HOURS);
});
