import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import {
  fetchTrendingShowPages, fetchPopularShowPages, rankTrendingShowPages as exportedRank,
} from '../../scripts/newsletter/popular-pages.mjs';

const require = createRequire(import.meta.url);
const { rankTrendingShowPages } = require('../../scripts/lib/newsletter-trending.js');

function row(slug, channel, range, views) {
  return {
    dimensionValues: [slug, channel, range].map(value => ({ value })),
    metricValues: [{ value: String(views) }],
  };
}

// Simulated week: Hamilton's spike is overwhelmingly Direct; the other
// shows have growth from search, referrals, and email.
const mixedWeek = [
  row('/show/hamilton', 'Direct', 'thisWeek', 1000),
  row('/show/hamilton', 'Direct', 'priorWeek', 10),
  row('/show/hamilton', 'Organic Search', 'thisWeek', 20),
  row('/show/hamilton', 'Organic Search', 'priorWeek', 20),
  row('/show/hadestown', 'Organic Search', 'thisWeek', 90),
  row('/show/hadestown', 'Organic Search', 'priorWeek', 30),
  row('/show/wicked', 'Organic Search', 'thisWeek', 40),
  row('/show/wicked', 'Organic Search', 'priorWeek', 20),
  row('/show/wicked', 'Referral', 'thisWeek', 20),
  row('/show/wicked', 'Referral', 'priorWeek', 10),
  row('/show/cabaret', 'Email', 'thisWeek', 45),
  row('/show/cabaret', 'Email', 'priorWeek', 30),
];

test('simulated before/after Trending list drops the Direct-heavy show', () => {
  const before = rankTrendingShowPages(mixedWeek, { excludeDirect: false, limit: 3 });
  const after = rankTrendingShowPages(mixedWeek, { limit: 3 });
  assert.deepEqual(before.map(r => r.slug), ['hamilton', 'hadestown', 'wicked']);
  assert.equal(before[0].views, 1020);
  assert.equal(before[0].growth, 34);
  assert.deepEqual(after, [
    { slug: 'hadestown', views: 90, prior: 30, growth: 3 },
    { slug: 'wicked', views: 60, prior: 30, growth: 2 },
    { slug: 'cabaret', views: 45, prior: 30, growth: 1.5 },
  ]);
});

test('Direct is removed from both weeks before aggregation and growth', () => {
  assert.deepEqual(rankTrendingShowPages([
    row('/show/hadestown', 'Organic Search', 'thisWeek', 90),
    row('/show/hadestown/', 'Referral', 'thisWeek', 30),
    row('/show/hadestown', 'Organic Search', 'priorWeek', 30),
    row('/show/hadestown/', 'Referral', 'priorWeek', 10),
    row('/show/hadestown', 'Direct', 'thisWeek', 500),
    row('/show/hadestown', 'Direct', 'priorWeek', 1000),
    row('/show/direct-only', 'Direct', 'thisWeek', 2000),
  ]), [{ slug: 'hadestown', views: 120, prior: 40, growth: 3 }]);
});

test('existing volume, growth and prior floors still apply after filtering', () => {
  assert.deepEqual(rankTrendingShowPages([
    row('/show/too-small', 'Referral', 'thisWeek', 29),
    row('/show/too-small', 'Direct', 'thisWeek', 1000),
    row('/show/flat', 'Organic Search', 'thisWeek', 100),
    row('/show/flat', 'Organic Search', 'priorWeek', 100),
    row('/show/new-show', 'Email', 'date_range_0', 30),
    row('/show/new-show', 'Email', 'date_range_1', 0),
    row('/show/boundary', 'Referral', 'thisWeek', 30),
    row('/show/boundary', 'Referral', 'priorWeek', 20),
  ]), [
    { slug: 'new-show', views: 30, prior: 0, growth: 6 },
    { slug: 'boundary', views: 30, prior: 20, growth: 1.5 },
  ]);
});

test('empty reports, non-show paths, unknown ranges and invalid counts add no climbers', () => {
  assert.deepEqual(rankTrendingShowPages([]), []);
  assert.deepEqual(rankTrendingShowPages([
    row('/', 'Organic Search', 'thisWeek', 1000),
    row('/show/hamilton/reviews', 'Referral', 'thisWeek', 1000),
    row('/show/hamilton', 'Organic Search', 'unknown', 1000),
    row('/show/wicked', 'Email', 'thisWeek', 'bad'),
    row('/show/wicked', 'Email', 'thisWeek', -50),
    {},
  ]), []);
});

// Stub only the unavailable SDK boundary. Exercise the real fetcher and report
// request, including date-range layout and its call to the shared ranker.
function mockGa4(t, runReport) {
  const originalLoad = Module._load;
  t.mock.method(Module, '_load', function (name, ...args) {
    if (name === '@google-analytics/data') {
      return { BetaAnalyticsDataClient: class { runReport = runReport; } };
    }
    return originalLoad.call(this, name, ...args);
  });
  for (const [key, value] of Object.entries({
    GA4_PROPERTY_ID: '123', GA_SERVICE_ACCOUNT_KEY: 'e30=', GA_KEY_FILE: '',
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

test('newsletter fetcher requests channel rows and uses the shared filtered ranking', async t => {
  assert.equal(exportedRank, rankTrendingShowPages);
  assert.equal(fetchPopularShowPages, fetchTrendingShowPages);
  let calls = 0;
  mockGa4(t, async request => {
    calls++;
    assert.deepEqual(request.dimensions, [
      { name: 'pagePath' }, { name: 'sessionDefaultChannelGroup' },
    ]);
    assert.deepEqual(request.metrics, [{ name: 'screenPageViews' }]);
    assert.equal(request.dimensionFilter.filter.fieldName, 'pagePath');
    assert.equal(request.dimensionFilter.filter.stringFilter.value, '/show/');
    assert.equal(request.dimensionFilter.filter.stringFilter.matchType, 'BEGINS_WITH');
    assert.ok(request.limit > 200, 'channel expansion must not retain the old 200-row cap');
    assert.deepEqual(request.dateRanges, [
      { startDate: '2026-10-10', endDate: '2026-10-17', name: 'thisWeek' },
      { startDate: '2026-10-03', endDate: '2026-10-09', name: 'priorWeek' },
    ]);
    return [{ rows: mixedWeek, rowCount: mixedWeek.length }];
  });
  assert.deepEqual(await fetchPopularShowPages({
    repo: process.cwd(), asOf: '2026-10-17', limit: 2,
  }), [
    { slug: 'hadestown', views: 90, prior: 30, growth: 3 },
    { slug: 'wicked', views: 60, prior: 30, growth: 2 },
  ]);
  assert.equal(calls, 1);
});

test('fetcher rejects a truncated report instead of ranking missing baselines', async t => {
  mockGa4(t, async () => [{ rows: mixedWeek, rowCount: mixedWeek.length + 1 }]);
  const messages = [];
  t.mock.method(process.stderr, 'write', message => { messages.push(message); return true; });
  assert.equal(await fetchTrendingShowPages({ repo: process.cwd() }), null);
  assert.match(messages.join(''), /incomplete show-page channel report/);
});

test('directShareOfShowViews reports the Direct share of this week\'s show-page views only (BRO-2503)', () => {
  const { directShareOfShowViews } = require('../../scripts/lib/newsletter-trending.js');
  const r = directShareOfShowViews([
    row('/show/hamilton', 'Direct', 'thisWeek', 75),
    row('/show/hamilton', 'Organic Search', 'thisWeek', 25),
    row('/show/hamilton', 'Direct', 'priorWeek', 999),
    row('/about', 'Direct', 'thisWeek', 500),
  ]);
  assert.deepEqual(r, { total: 100, direct: 75, share: 0.75 });
  assert.equal(directShareOfShowViews([]).share, null);
});
