import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const H = require('./traffic-history.js');

test('chunk grids: days any-aligned, weeks Monday-aligned, months calendar-aligned', () => {
  const d = H.dayChunks('2026-03-09', '2026-09-23');
  assert.equal(d[0].startDate, '2026-03-09');
  assert.equal(d.at(-1).endDate, '2026-09-23');
  for (let i = 1; i < d.length; i++) assert.equal(d[i].startDate > d[i - 1].endDate, true);
  const w = H.weekChunks('2026-03-11', '2026-09-23');
  for (const c of w) assert.equal(new Date(c.startDate + 'T00:00:00Z').getUTCDay(), 1);
  const m = H.monthChunks('2026-03-15', '2026-09-23');
  assert.deepEqual(m.map((c) => c.startDate), ['2026-03-01', '2026-06-01', '2026-09-01']);
  assert.equal(m[0].endDate, '2026-05-31');
  assert.equal(m.at(-1).endDate, '2026-09-23');
});

test('refresh starts at the floor for an empty store, else 6 weeks back on a Monday', () => {
  assert.equal(H.refreshStart(null, '2026-09-23'), H.TRACKING_FLOOR);
  assert.equal(H.refreshStart({ endDate: '2026-09-23' }, '2026-09-30'), '2026-08-10');
  // a store that went stale for months refreshes from its own end, closing the gap
  assert.equal(H.refreshStart({ endDate: '2026-05-01' }, '2026-09-30'), '2026-03-16');
});

// Fake PostHog: answers each chunk by grouping synthetic rows; one session
// starts Sunday 23:50 on a chunk's last day and is returned by the NEXT chunk too.
function fakePh() {
  const calls = [];
  const phQuery = async (q) => {
    calls.push(q);
    const from = q.match(/toDateTime\('(\d{4}-\d{2}-\d{2})/)[1];
    if (/toStartOfMonth/.test(q)) return [[from.slice(0, 8) + '01', 1000]];
    if (/toStartOfWeek/.test(q)) return [[from, 300]];
    if (/channel_type/.test(q)) return [[from, 'Organic Search', 5], [from, null, 1]];
    // daily: a row for the chunk's first day, plus the previous day (boundary spill) and an epoch row
    return [['1970-01-01', 9, 9], [addDay(from, -1), 7, 7], [from, 10, 20]];
  };
  return { phQuery, calls };
}
function addDay(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
const withRetry = (fn) => fn();

test('fetchSeries keeps only buckets inside each chunk (no double count at edges, no epoch rows)', async () => {
  const { phQuery } = fakePh();
  const rows = await H.fetchSeries('daily', { from: '2026-03-09', to: '2026-09-23', phQuery, withRetry, where: '1=1' });
  const dates = rows.map((r) => r.date);
  assert.equal(new Set(dates).size, dates.length);
  assert.ok(dates.every((x) => x >= '2026-03-09'));
  const ch = await H.fetchSeries('channelDaily', { from: '2026-09-01', to: '2026-09-23', phQuery, withRetry, where: '1=1' });
  assert.deepEqual(ch.map((r) => r.key), ['Organic Search', '(unknown)']);
});

test('refreshHistory merges a full refresh and keeps older buckets', async () => {
  const { phQuery, calls } = fakePh();
  const old = {
    startDate: '2026-03-09', endDate: '2026-09-16',
    daily: [{ date: '2026-03-10', sessions: 1, pageviews: 1 }, { date: '2026-08-20', sessions: 2, pageviews: 2 }],
    channelDaily: [{ date: '2026-03-10', key: 'Direct', sessions: 1 }],
    weeklyVisitors: [{ week: '2026-03-09', visitors: 11 }, { week: '2026-08-10', visitors: 99 }],
    monthlyVisitors: [{ month: '2026-03', visitors: 50 }, { month: '2026-08', visitors: 999 }],
  };
  const r = await H.refreshHistory({ store: old, endDate: '2026-09-23', phQuery, withRetry, where: '1=1' });
  assert.equal(r.refreshed, true);
  assert.equal(r.from, '2026-08-03');
  assert.equal(r.store.startDate, '2026-03-09');
  assert.equal(r.store.endDate, '2026-09-23');
  assert.ok(r.store.daily.some((x) => x.date === '2026-03-10'));
  assert.equal(r.store.daily.some((x) => x.date === '2026-08-20'), false); // replaced by the refresh
  assert.deepEqual(r.store.weeklyVisitors.map((x) => x.week), ['2026-03-09', '2026-08-03']);
  // month grid restarts on the 1st of the refresh month: August is re-queried whole
  assert.deepEqual(r.store.monthlyVisitors, [{ month: '2026-03', visitors: 50 }, { month: '2026-08', visitors: 1000 }]);
  assert.ok(calls.every((q) => /LIMIT 100000/.test(q)));
});

test('a failed series leaves the store untouched and names the failure', async () => {
  const { phQuery } = fakePh();
  const flaky = async (q) => { if (/toStartOfWeek/.test(q)) throw new Error('PostHog API 504: timeout'); return phQuery(q); };
  const old = { startDate: '2026-03-09', endDate: '2026-09-16', daily: [], channelDaily: [], weeklyVisitors: [], monthlyVisitors: [] };
  const r = await H.refreshHistory({ store: old, endDate: '2026-09-23', phQuery: flaky, withRetry, where: '1=1' });
  assert.equal(r.refreshed, false);
  assert.equal(r.store, old);
  assert.match(r.errors.weeklyVisitors, /504/);
  assert.throws(() => H.mergeHistory(old, { daily: [] }, { from: '2026-09-01', monthFrom: '2026-09-01', endDate: '2026-09-23' }), /partial merge/);
});

test('time budget skips the remaining series instead of running past the job timeout', async () => {
  const { phQuery } = fakePh();
  let t = 0;
  const r = await H.refreshHistory({ store: null, endDate: '2026-09-23', phQuery, withRetry, where: '1=1', timeBudgetMs: 1000, now: () => (t += 600) });
  assert.equal(r.refreshed, false);
  assert.match(Object.values(r.errors).join(' '), /time budget/);
});
