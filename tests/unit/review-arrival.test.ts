// BRO-7376: opening-night "reviews still arriving" decision layer. Real functions, no copies (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  morningCount, expectedFromCounts, expectedForShow, reviewArrivalPhase, splitRegularOutlets, buildReviewArrival, toArrivalView,
  arrivalWindowEndMs, pressNightEmbargoMs, arrivalText, MORNING_SHARE, type ExpectedCount, type HistoryShow,
} from '../../src/lib/review-arrival';

const OPEN = '2026-11-15';
const exp = (expected: number): ExpectedCount => ({ expected, expectedHigh: expected + 10, median: expected, low: expected - 3, high: expected + 3, n: 10 });
const at = (iso: string) => new Date(iso);
const base = { openingDate: OPEN, category: 'broadway', expected: exp(30) };

test('status ends at 9am ET the morning after opening, EST and EDT', () => {
  assert.equal(new Date(arrivalWindowEndMs('2026-11-10')!).toISOString(), '2026-11-11T14:00:00.000Z'); // EST
  assert.equal(new Date(arrivalWindowEndMs('2026-10-29')!).toISOString(), '2026-10-30T13:00:00.000Z'); // EDT
  assert.equal(arrivalWindowEndMs(null), null);
});

test('morningCount: share of reviews dated opening day or next day, ignores later and undated', () => {
  const d = ['2026-11-15', '2026-11-15', '2026-11-16', '2026-11-16', '2026-11-18', '2026-12-30', null];
  assert.equal(morningCount(d, OPEN), Math.round(4 * MORNING_SHARE));
  assert.equal(morningCount(d, null), 0);
});

test('expectedFromCounts: conservative, 25th percentile rounded DOWN to 5, min 5, null with no history', () => {
  assert.equal(expectedFromCounts([]), null);
  assert.equal(expectedFromCounts([0, 0]), null);
  const e = expectedFromCounts([18, 19, 22, 22, 24, 24, 26, 17, 5, 18])!;
  assert.equal(e.low, 18);
  assert.equal(e.expected, 15);
  assert.equal(e.high, 24);
  assert.equal(e.expectedHigh, 25);
  assert.equal(expectedFromCounts([3, 4, 6])!.expected, 5);
  assert.ok(expectedFromCounts([30, 31, 32, 33])!.expected <= 30);
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
  assert.ok(e.median >= 8 && e.median <= 35);
  assert.equal(expectedForShow({ id: 'x', category: 'off-broadway', openingDate: OPEN }, history), null);
});

test('phase: hidden before opening-day noon, after the window, off-Broadway, with no expectation', () => {
  const i = { ...base, reviewCount: 0, scoreShowing: false };
  assert.equal(reviewArrivalPhase({ ...i, now: at('2026-11-15T10:00:00Z') }), null);
  assert.equal(reviewArrivalPhase({ ...i, now: at('2026-11-15T15:00:00Z') }), null); // 10am ET opening day, before noon
  assert.equal(reviewArrivalPhase({ ...i, now: at('2026-11-15T17:30:00Z') }), 'waiting'); // after noon ET
  assert.equal(reviewArrivalPhase({ ...i, now: at('2026-11-19T12:00:00Z') }), null);
  assert.equal(reviewArrivalPhase({ ...i, now: at('2026-11-15T20:00:00Z'), category: 'off-broadway' }), null);
  assert.equal(reviewArrivalPhase({ ...i, now: at('2026-11-15T20:00:00Z'), expected: null }), null);
});

test('phase: waiting, below-minimum, early; hidden once the count reaches the estimate or 9am ET passes', () => {
  const now = at('2026-11-16T06:00:00Z');
  assert.equal(reviewArrivalPhase({ ...base, now, reviewCount: 0, scoreShowing: false }), 'waiting');
  assert.equal(reviewArrivalPhase({ ...base, now, reviewCount: 3, scoreShowing: false }), 'below-minimum');
  assert.equal(reviewArrivalPhase({ ...base, now, reviewCount: 8, scoreShowing: true }), 'early');
  assert.equal(reviewArrivalPhase({ ...base, now, reviewCount: 29, scoreShowing: true }), 'early');
  assert.equal(reviewArrivalPhase({ ...base, now, reviewCount: 30, scoreShowing: true }), null);
  assert.equal(reviewArrivalPhase({ ...base, now: at('2026-11-16T14:01:00Z'), reviewCount: 8, scoreShowing: true }), null);
  assert.equal(reviewArrivalPhase({ ...base, now: at('2026-11-16T13:59:00Z'), reviewCount: 8, scoreShowing: true }), 'early');
});

test('splitRegularOutlets is case-insensitive and keeps order', () => {
  const regular = [{ id: 'nytimes', name: 'NYT' }, { id: 'vulture', name: 'Vulture' }, { id: 'variety', name: 'Variety' }];
  const s = splitRegularOutlets(regular, ['NYTimes', 'variety']);
  assert.deepEqual(s.inNow.map((o) => o.id), ['nytimes', 'variety']);
  assert.deepEqual(s.stillToCome.map((o) => o.id), ['vulture']);
});

test('buildReviewArrival returns null when hidden and a full payload when shown', () => {
  assert.equal(buildReviewArrival({ ...base, now: at('2026-11-25T00:00:00Z'), reviewCount: 8, scoreShowing: true }), null);
  const a = buildReviewArrival({
    ...base, now: at('2026-11-16T06:00:00Z'), reviewCount: 8, scoreShowing: true,
    regular: [{ id: 'nytimes', name: 'NYT' }, { id: 'vulture', name: 'Vulture' }], haveOutletIds: ['nytimes'],
  })!;
  assert.equal(a.phase, 'early');
  assert.equal(a.expected, 30);
  assert.equal(a.regularIn.length, 1);
  assert.equal(a.regularToCome[0].name, 'Vulture');
  assert.ok(a.hoursLeft > 0 && a.hoursLeft < 12);
});

test('arrivalText: owner wording with a range, no bar, no em dash', () => {
  const r = { expected: 15, expectedHigh: 25 };
  assert.equal(arrivalText({ phase: 'waiting', reviewCount: 0, ...r }), 'Reviews tonight, expect 15 to 25');
  assert.equal(arrivalText({ phase: 'early', reviewCount: 8, ...r }), '8 reviews so far, expect 15 to 25');
  assert.equal(arrivalText({ phase: 'below-minimum', reviewCount: 1, ...r }), '1 review so far, expect 15 to 25');
  assert.equal(arrivalText({ phase: 'early', reviewCount: 8, expected: 20, expectedHigh: 20 }), '8 reviews so far, expect about 20');
  assert.ok(!arrivalText({ phase: 'early', reviewCount: 8, ...r }).includes('\u2014'));
});

test('toArrivalView sends only the rendered fields plus the end time', () => {
  const now = at('2026-11-16T06:00:00Z');
  const a = buildReviewArrival({ ...base, now, reviewCount: 8, scoreShowing: true })!;
  const v = toArrivalView(a, now);
  assert.deepEqual(Object.keys(v).sort(), ['endsAt', 'expected', 'expectedHigh', 'phase', 'reviewCount']);
  assert.equal(v.endsAt, arrivalWindowEndMs(base.openingDate));
});
