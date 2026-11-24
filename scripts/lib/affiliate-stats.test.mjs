import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildWindow, pacificMidnight, clampDays } = require('./affiliate-stats.js');

test('pacificMidnight: PDT and PST offsets', () => {
  assert.equal(pacificMidnight(new Date('2026-10-26T17:30:00Z')).toISOString(), '2026-10-26T07:00:00.000Z');
  assert.equal(pacificMidnight(new Date('2026-12-07T13:00:00Z')).toISOString(), '2026-12-07T08:00:00.000Z');
  // 03:00 UTC Monday is still Sunday evening in Pacific time
  assert.equal(pacificMidnight(new Date('2026-10-27T03:00:00Z')).toISOString(), '2026-10-26T07:00:00.000Z');
});

test('pacificMidnight: DST-change days use the offset in force at midnight', () => {
  // 2026-11-01: PDT -> PST at 02:00; midnight is still PDT (07:00Z)
  assert.equal(pacificMidnight(new Date('2026-11-01T20:00:00Z')).toISOString(), '2026-11-01T07:00:00.000Z');
  // 2026-03-08: PST -> PDT at 02:00; midnight is still PST (08:00Z)
  assert.equal(pacificMidnight(new Date('2026-03-08T20:00:00Z')).toISOString(), '2026-03-08T08:00:00.000Z');
});

test('buildWindow completeDays: last 7 whole Pacific days, send time irrelevant', () => {
  // The 2026-10-26 email: a rolling window started 10-19 mid-morning and
  // dropped two 10-19 orders that the baseline line counted.
  for (const sentAt of ['2026-10-26T13:00:00Z', '2026-10-26T17:30:00Z', '2026-10-27T06:59:00Z']) {
    const w = buildWindow(7, { completeDays: true, now: new Date(sentAt) });
    assert.equal(w.start.toISOString(), '2026-10-19T07:00:00.000Z', sentAt);
    assert.equal(w.end.toISOString(), '2026-10-26T07:00:00.000Z', sentAt);
    assert.equal(w.endBuffered.getTime(), w.end.getTime(), 'no buffer past the last whole day');
    assert.equal(w.startDate, '2026-10-19');
    assert.equal(w.endDate, '2026-10-25');
  }
});

test('buildWindow completeDays: spans a DST change without losing a day', () => {
  const w = buildWindow(7, { completeDays: true, now: new Date('2026-11-02T15:00:00Z') });
  assert.equal(w.start.toISOString(), '2026-10-26T07:00:00.000Z');
  assert.equal(w.end.toISOString(), '2026-11-02T08:00:00.000Z');
  assert.equal(w.startDate, '2026-10-26');
  assert.equal(w.endDate, '2026-11-01');
});

test('buildWindow completeDays: prior week chains onto the current one', () => {
  const cur = buildWindow(7, { completeDays: true, now: new Date('2026-10-26T13:00:00Z') });
  const prior = buildWindow(7, { completeDays: true, now: cur.start });
  assert.equal(prior.end.getTime(), cur.start.getTime());
  assert.equal(prior.startDate, '2026-10-12');
  assert.equal(prior.endDate, '2026-10-18');
});

test('buildWindow rolling (dashboard default) is unchanged', () => {
  const now = new Date('2026-10-26T17:30:00Z');
  const w = buildWindow(7, { now });
  assert.equal(w.end.getTime(), now.getTime());
  assert.equal(w.start.toISOString(), '2026-10-19T17:30:00.000Z');
  assert.equal(w.endBuffered.toISOString(), '2026-10-27T17:30:00.000Z');
});

test('clampDays keeps the buffered Impact range within its 45-day cap', () => {
  assert.equal(clampDays(45), 44);
  assert.equal(clampDays(30), 30);
  assert.equal(clampDays(0), 7);
  const w = buildWindow(clampDays(45), { now: new Date('2026-10-26T00:00:00Z') });
  assert.ok((w.endBuffered - w.start) / 86400000 <= 45);
});

test('every PostHog query applies the shared Real Users filter', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./affiliate-stats.js', import.meta.url), 'utf8');
  const queries = (src.match(/FROM events/g) || []).length;
  assert.ok(queries >= 3);
  assert.equal((src.match(/\$\{REAL_USERS_WHERE\}/g) || []).length, queries,
    'a query on events is missing ${REAL_USERS_WHERE}, so bots/owner leak into the funnel');
});

// BRO-8220: the 2026-11-22 Impact 503 hit the weekly report's baseline fetch,
// which had no retry, so the report went out with a PARTIAL DATA banner and
// no context box. With retry:true a single transient failure is retried.
async function runWithFlakyImpact({ retry, failStatus }) {
  const saved = { fetch: globalThis.fetch, env: { ...process.env } };
  process.env.IMPACT_ACCOUNT_SID = 'sid';
  process.env.IMPACT_AUTH_TOKEN = 'tok';
  for (const k of ['POSTHOG_PERSONAL_API_KEY', 'POSTHOG_PROJECT_ID', 'PARTNERIZE_APP_KEY', 'PARTNERIZE_USER_API_KEY']) delete process.env[k];
  let dailyCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (/Reports\//.test(u)) {
      dailyCalls += 1;
      if (dailyCalls === 1) return { ok: false, status: failStatus, text: async () => '<html>Service Unavailable</html>' };
      return json(200, { Records: [{ date_display: 'Nov 10, 2026', Clicks: '10', Actions: '1', Action_Cost: '5', Sale_zzzAmount: '50' }] });
    }
    if (/Actions\.json/.test(u)) return json(200, { Actions: [] });
    throw new Error(`unexpected fetch ${u}`);
  };
  const slept = [];
  try {
    const { getAffiliateStats } = require('./affiliate-stats.js');
    const stats = await getAffiliateStats({
      days: 7, includeWoW: true, completeDays: true, now: new Date('2026-11-23T15:00:00Z'),
      retry, sleep: async (ms) => { slept.push(ms); },
    });
    return { stats, dailyCalls, slept };
  } finally {
    globalThis.fetch = saved.fetch;
    process.env = saved.env;
  }
}

test('weekly report: one Impact 503 on the baseline fetch is retried, context stays complete', async () => {
  const { stats, dailyCalls, slept } = await runWithFlakyImpact({ retry: true, failStatus: 503 });
  assert.equal(dailyCalls, 2);
  assert.deepEqual(slept, [15000]);
  assert.ok(stats.context, 'context box present');
  assert.notEqual(stats.context.partial, true, 'a retried 503 must not mark the report partial');
  assert.ok(stats.context.baseline, 'baseline comparison computed');
  assert.ok(!(stats.errors || []).some((e) => e.provider === 'impact-baseline'));
});

test('dashboard default (retry off) keeps single-attempt behaviour: 503 marks context partial', async () => {
  const { stats, dailyCalls, slept } = await runWithFlakyImpact({ retry: false, failStatus: 503 });
  assert.equal(dailyCalls, 1);
  assert.deepEqual(slept, []);
  assert.equal(stats.context.partial, true);
});

test('an auth failure is never retried, even with retry on', async () => {
  const { stats, dailyCalls, slept } = await runWithFlakyImpact({ retry: true, failStatus: 401 });
  assert.equal(dailyCalls, 1);
  assert.deepEqual(slept, []);
  assert.equal(stats.context.partial, true);
});
