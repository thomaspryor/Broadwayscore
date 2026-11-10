// BRO-7329: quiet review-forecast pilot. Requires the real lib (CLAUDE.md §15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const P = require('../../scripts/lib/review-forecast-pilot.js');
const { classifyPost } = require('../../scripts/lib/reddit-post-filters.js');

const show = { id: 'x', category: 'broadway', type: 'musical', status: 'previews', openingDate: '2026-11-15', previewsStartDate: '2026-10-20' };

test('isPilotTarget: previews or first preview within 60 days, opening strictly in the future', () => {
  assert.equal(P.isPilotTarget(show, '2026-11-10'), true);
  assert.equal(P.isPilotTarget(show, '2026-11-15'), false); // opening day itself is out
  assert.equal(P.isPilotTarget({ ...show, status: 'closed' }, '2026-11-10'), false);
  assert.equal(P.isPilotTarget({ ...show, openingDate: '2026-11-01' }, '2026-11-10'), false); // already opened
  assert.equal(P.isPilotTarget({ ...show, status: 'upcoming', openingDate: '2027-03-01', previewsStartDate: '2027-02-01' }, '2026-11-10'), false);
  assert.equal(P.isPilotTarget({ ...show, status: 'upcoming', openingDate: '2027-01-10', previewsStartDate: '2026-12-20' }, '2026-11-10'), true);
  assert.equal(P.isPilotTarget({ ...show, category: 'off-broadway' }, '2026-11-10'), false);
  assert.equal(P.isPilotTarget({ ...show, type: 'special' }, '2026-11-10'), false);
});

test('leakage: a row dated on or after opening is refused, and the frozen row is the last strictly earlier one', () => {
  const rows = [
    { showId: 'x', recordedAt: '2026-11-12', openingDate: '2026-11-15', forecast: 70 },
    { showId: 'x', recordedAt: '2026-11-14', openingDate: '2026-11-15', forecast: 72 },
    { showId: 'x', recordedAt: '2026-11-15', openingDate: '2026-11-15', forecast: 99 },
    { showId: 'x', recordedAt: '2026-11-20', openingDate: '2026-11-15', forecast: 98 },
  ];
  assert.equal(P.canRecord('2026-11-15', '2026-11-15'), false);
  assert.equal(P.canRecord('2026-11-14', '2026-11-15'), true);
  assert.equal(P.frozenForecastRow(rows, 'x', '2026-11-15').forecast, 72);
  const { append, skipped } = P.selectAppendable([], rows);
  assert.equal(append.length, 2);
  assert.equal(skipped.length, 2);
});

test('idempotent per show and day', () => {
  const existing = [{ showId: 'x', recordedAt: '2026-11-10', openingDate: '2026-11-15' }];
  const { append, skipped } = P.selectAppendable(existing, [
    { showId: 'x', recordedAt: '2026-11-10', openingDate: '2026-11-15' },
    { showId: 'y', recordedAt: '2026-11-10', openingDate: '2026-11-15' },
    { showId: 'y', recordedAt: '2026-11-10', openingDate: '2026-11-15' },
  ]);
  assert.deepEqual(append.map((r) => r.showId), ['y']);
  assert.equal(skipped.length, 2);
});

test('audienceSnapshot is null-safe and totals counts', () => {
  assert.deepEqual(P.audienceSnapshot(null), { combined: null, designation: null, totalCount: 0, sources: {} });
  const a = P.audienceSnapshot({ combinedScore: 86.5, designation: 'Loving It', sources: { showScore: { score: 88, reviewCount: 120 }, mezzanine: { score: 80, reviewCount: 30 }, junk: null } });
  assert.equal(a.combined, 86.5);
  assert.equal(a.totalCount, 150);
  assert.deepEqual(Object.keys(a.sources).sort(), ['mezzanine', 'showScore']);
});

test('redditAggregate: 60-day lead-up window, previews bucket, no future posts', () => {
  const day = (iso) => Date.parse(`${iso}T12:00:00Z`) / 1000;
  const posts = [
    { id: 'a', created_utc: day('2026-09-01'), num_comments: 10, score: 100, upvote_ratio: 0.9 }, // lead-up
    { id: 'b', created_utc: day('2026-10-25'), num_comments: 4, score: 20, upvote_ratio: 0.8 },  // previews
    { id: 'c', created_utc: day('2026-08-01'), num_comments: 99, score: 999, upvote_ratio: 1 },  // before window (previews 10-20, window starts 08-21)
    { id: 'd', created_utc: day('2026-11-11'), num_comments: 99, score: 999, upvote_ratio: 1 },  // after today
    { id: 'a', created_utc: day('2026-09-01'), num_comments: 10, score: 100, upvote_ratio: 0.9 }, // duplicate
  ];
  const r = P.redditAggregate(posts, { previewsStartDate: '2026-10-20', today: '2026-11-10' });
  assert.equal(r.windowStart, '2026-08-21');
  assert.equal(r.windowEnd, '2026-11-10');
  assert.equal(r.leadup.postCount, 1);
  assert.equal(r.leadup.commentCount, 10);
  assert.equal(r.previews.postCount, 1);
  assert.equal(r.previews.meanPostScore, 20);
  assert.equal(P.redditAggregate([], { previewsStartDate: null, today: '2026-11-10' }).available, false);
});

test('grading: only after 14 days, needs a frozen row and a critic score; scoreboard math', () => {
  const frozen = { recordedAt: '2026-11-14', forecast: 72, categoryMean: 70, lo80: 60, hi80: 84, audience: { combined: 86 } };
  assert.equal(P.buildGradeRow({ showId: 'x', openingDate: '2026-11-15', today: '2026-11-28', frozen, criticScore: 75 }), null); // day 13
  assert.equal(P.buildGradeRow({ showId: 'x', openingDate: '2026-11-15', today: '2026-11-29', frozen: null, criticScore: 75 }), null);
  assert.equal(P.buildGradeRow({ showId: 'x', openingDate: '2026-11-15', today: '2026-11-29', frozen, criticScore: null }), null);
  const g = P.buildGradeRow({ showId: 'x', openingDate: '2026-11-15', today: '2026-11-29', frozen, criticScore: 75 });
  assert.equal(g.missForecast, 3);
  assert.equal(g.missCategoryMean, 5);
  assert.equal(g.missPreviewAudience, 11);
  assert.equal(g.inRange80, true);
  const sb = P.scoreboard([g, { ...g, missForecast: 7, missCategoryMean: 1, missPreviewAudience: 3, inRange80: false }]);
  assert.equal(sb.forecast.mae, 5);
  assert.equal(sb.categoryMean.mae, 3);
  assert.equal(sb.range80HitRate, 0.5);
});

test('fitForecaster refuses a thin training set', () => {
  assert.equal(P.fitForecaster([{ season: 2020, x: {}, mu: 70, y: 70 }]), null);
});

test('classifyPost lives in reddit-post-filters (moved from the scraper)', () => {
  assert.equal(classifyPost({ title: 'Just saw Downstate, loved it' }, 'Downstate'), true);
  assert.equal(classifyPost({ title: 'Downstate movie trailer' }, 'Downstate'), false);
});
