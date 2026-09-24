import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TM = require('./traffic-metrics.js');
const { pageName, sourceName, isOwnTooling, isDirect } = require('./traffic-report-human.js');
const naming = { pageName: (p) => pageName(p), sourceName, isOwnTooling, isDirect };

// A synthetic store: `perDay` visits every day from `from` to `to`, 2 pageviews per visit.
function store(from, to, perDay = (d) => 100, extra = {}) {
  const daily = [];
  for (let d = from; d <= to; d = TM.addDays(d, 1)) daily.push({ date: d, sessions: perDay(d), pageviews: perDay(d) * 2 });
  return { startDate: from, endDate: to, daily, channelDaily: [], weeklyVisitors: [], monthlyVisitors: [], ...extra };
}
const ph = { landing: [], referringDomain: [], country: [] };

test('WoW, 4-week average, MTD and MoM from a stored history', () => {
  // Wed 2026-09-23 run; last full week = Sep 14-20.
  const h = store('2026-03-09', '2026-09-23', (d) => (d >= '2026-09-14' && d <= '2026-09-20' ? 150 : 100), {
    weeklyVisitors: [{ week: '2026-09-07', visitors: 500 }, { week: '2026-09-14', visitors: 600 }],
  });
  const m = TM.computeTrafficMetrics({ history: h, ph, startDate: '2026-06-22', endDate: '2026-09-23', currentWeek: '2026-09-21', naming });
  assert.equal(m.week.start, '2026-09-14');
  assert.equal(m.week.visits, 1050);
  assert.equal(m.week.prevVisits, 700);
  assert.equal(m.week.wowPct, 50);
  assert.equal(m.week.avg4, 700);
  assert.equal(m.week.visitors, 600);
  assert.equal(m.week.visitorsWowPct, 20);
  assert.equal(m.week.pagesPerVisit, 2);
  // MTD through yesterday (Sep 22): 22 days, 7 of them at 150.
  assert.equal(m.mtd.days, 22);
  assert.equal(m.mtd.visits, 15 * 100 + 7 * 150);
  assert.equal(m.mtd.prevVisits, 2200);
  assert.equal(m.lastMonth.month, '2026-08');
  assert.equal(m.lastMonth.visits, 3100);
  assert.equal(m.lastMonth.prevVisits, 3100);
  assert.equal(m.lastMonth.momPct, 0);
});

test('YoY is "not yet" until a full same-week-last-year exists, then real', () => {
  const early = TM.computeTrafficMetrics({ history: store('2026-03-09', '2026-09-23', () => 0 || 100), ph, startDate: '2026-06-22', endDate: '2026-09-23', currentWeek: '2026-09-21', naming });
  assert.equal(early.yoy.available, false);
  // History starting mid-week (first rows Fri 2026-03-13): first full week Mon 2026-03-16, +364 days.
  const h = store('2026-03-09', '2027-03-24', (d) => (d < '2026-03-13' ? 0 : 100));
  const notQuite = TM.computeTrafficMetrics({ history: h, ph, startDate: '2026-12-21', endDate: '2027-03-17', currentWeek: '2027-03-15', naming });
  assert.equal(notQuite.yoy.available, false);
  assert.equal(notQuite.yoy.availableFrom, '2027-03-15');
  assert.equal(TM.buildTiles(notQuite)[2].lines[0], 'Available from March 2027');
  const real = TM.computeTrafficMetrics({ history: h, ph, startDate: '2026-12-28', endDate: '2027-03-24', currentWeek: '2027-03-22', naming });
  assert.equal(real.yoy.available, true);
  assert.equal(real.yoy.lastYearWeek, '2026-03-16');
  assert.equal(real.yoy.lastYearVisits, 700);
  assert.equal(real.yoy.pct, 0);
});

test('without history, the 13-week rows drive visits and unknowns stay null (never a partial sum)', () => {
  const rows = [];
  for (let d = '2026-06-22'; d <= '2026-09-23'; d = TM.addDays(d, 1)) rows.push({ date: d, key: 'Organic Search', sessions: 10 }, { date: d, key: 'Direct', sessions: 5 });
  const m = TM.computeTrafficMetrics({ history: null, ph: { ...ph, channelType: rows }, startDate: '2026-06-22', endDate: '2026-09-23', currentWeek: '2026-09-21', naming });
  assert.equal(m.hasHistory, false);
  assert.equal(m.week.visits, 105);
  assert.equal(m.week.visitors, null);
  assert.equal(m.week.pagesPerVisit, null);
  // June started before the window: the month before August (July) is fine, June is not.
  assert.equal(m.lastMonth.prevVisits, 31 * 15);
  assert.equal(m.lastMonth.lastYearVisits, null);
  assert.equal(m.yoy.availableFrom, '2027-03-15'); // from TRACKING_START, not the window start
  const tiles = TM.buildTiles(m);
  assert.equal(tiles.length, 9);
  assert.equal(tiles[3].value, '—');
});

test('a stale store does not report missing days as zero traffic', () => {
  // Store ends Sep 10; the run is Sep 23 — last week is not covered.
  const m = TM.computeTrafficMetrics({ history: store('2026-03-09', '2026-09-10'), ph, startDate: '2026-06-22', endDate: '2026-09-23', currentWeek: '2026-09-21', naming });
  assert.equal(m.week.visits, null);
  assert.equal(m.mtd.visits, null);
});

test('top page / referrer / country: named, merged, direct and own tooling excluded', () => {
  const p = {
    landing: [{ date: '2026-09-15', key: '/', sessions: 40 }, { date: '2026-09-15', key: '/show/hamilton', sessions: 30 }, { date: '2026-09-22', key: '/show/hamilton', sessions: 999 }],
    referringDomain: [
      { date: '2026-09-15', key: '$direct', sessions: 500 },
      { date: '2026-09-15', key: 'www.reddit.com', sessions: 20 }, { date: '2026-09-16', key: 'com.reddit.frontpage', sessions: 25 },
      { date: '2026-09-16', key: 'www.google.com', sessions: 30 }, { date: '2026-09-16', key: 'broadwayscorecard.com', sessions: 90 },
    ],
    country: [{ date: '2026-09-15', key: 'United States', sessions: 60 }, { date: '2026-09-15', key: '(unknown)', sessions: 99 }],
  };
  const m = TM.computeTrafficMetrics({ history: null, ph: p, startDate: '2026-06-22', endDate: '2026-09-23', currentWeek: '2026-09-21', naming });
  assert.deepEqual(m.top.pages.map((x) => [x.name, x.visits]), [['the homepage', 40], ['Hamilton page', 30]]);
  assert.deepEqual(m.top.referrers[0], { key: 'Reddit', visits: 45 });
  assert.equal(m.top.referrers.some((r) => r.key === 'Direct' || /broadwayscorecard/.test(r.key)), false);
  assert.deepEqual(m.top.countries, [{ key: 'United States', visits: 60 }]);
});

test('charts: 13 weekly points, search line from channel rows; URLs stay under 8KB', () => {
  const h = store('2026-03-09', '2026-09-23', () => 100, { channelDaily: [{ date: '2026-09-15', key: 'Organic Search', sessions: 7 }] });
  const cfg = TM.weeklyChartConfig({ history: h, ph, startDate: '2026-06-22', endDate: '2026-09-23', currentWeek: '2026-09-21' });
  assert.equal(cfg.data.labels.length, 13);
  assert.equal(cfg.data.datasets[0].data.at(-1), 700);
  assert.equal(cfg.data.datasets[1].data.at(-1), 7);
  const pages = Array.from({ length: 12 }, (_, i) => ({ name: `the Show Number ${i} With A Very Long Title Indeed page`, visits: 100 - i }));
  const bar = TM.topPagesChartConfig(pages, { weekStart: '2026-09-14' });
  assert.equal(bar.data.labels.length, 8);
  assert.ok(bar.data.labels.every((l) => l.length <= 34));
  assert.ok(TM.chartUrl(cfg).length < 8000 && TM.chartUrl(bar).length < 8000);
});

test('dashboard payload: weeks only where tracked, channel groups, current month partial', () => {
  const h = store('2026-03-09', '2026-09-23', (d) => (d < '2026-03-13' ? 0 : 100), {
    channelDaily: [{ date: '2026-09-15', key: 'Organic Search', sessions: 60 }, { date: '2026-09-15', key: 'AI', sessions: 3 }, { date: '2026-09-15', key: 'Weird', sessions: 1 }],
    monthlyVisitors: [{ month: '2026-08', visitors: 2000 }],
  });
  const ctx = { history: h, ph, startDate: '2026-06-22', endDate: '2026-09-23', currentWeek: '2026-09-21' };
  const metrics = TM.computeTrafficMetrics({ ...ctx, naming });
  const d = TM.buildDashboardData({ ...ctx, naming, metrics, generatedAt: 'x' });
  assert.equal(d.weeks[0].week, '2026-03-09'); // partial first week kept, flagged
  assert.equal(d.weeks[0].partialStart, true);
  assert.equal(d.weeks.at(-1).week, '2026-09-14');
  assert.deepEqual(d.weeks.at(-1).channels, { Search: 60, 'AI assistants': 3, Other: 1 });
  assert.equal(d.months[0].month, '2026-03');
  assert.equal(d.months.at(-1).partial, true);
  assert.equal(d.months.find((m) => m.month === '2026-08').visitors, 2000);
});
