import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  checkHandoffBreak,
  checkBotDivergence,
  checkPayoutAnomaly,
  checkDeadMan,
  checkZeroConversionCeiling,
  findOutlierDays,
  findRepeatBuyers,
  baselineComparison,
} = require('./affiliate-anomaly.js');
const { runChecks, isTransientFetchError, fetchWithOneRetry } = require('../check-affiliate-health.js');

// ── REAL July–August 2026 data (the incident that motivated this monitor) ──
// Impact partner_performance_by_day + PostHog daily ticket_click (real-users
// lens), captured live during the 2026-08-03 investigation of the -77.6% WoW
// report. The acceptance bar (plan-review structure finding): the monitor
// must stay QUIET on this real, healthy-but-soft period — the whole point is
// that this "drop" was NOT a breakage.
const REAL_IMPACT_DAILY = [
  ['2026-07-20', 26, 2, 25.09, 765.77], ['2026-07-21', 18, 8, 18.76, 1240.10],
  ['2026-07-22', 28, 0, 0, 0],          ['2026-07-23', 19, 3, 9.01, 544.22],
  ['2026-07-24', 35, 11, 89.07, 3169.79], ['2026-07-25', 23, 0, 0, 0],
  ['2026-07-26', 34, 1, 0.48, 47.96],   ['2026-07-27', 22, 1, 0.33, 33.00],
  ['2026-07-28', 22, 1, 1.94, 194.00],  ['2026-07-29', 34, 1, 0.00, 91.69],
  ['2026-07-30', 23, 1, 0.35, 35.40],   ['2026-07-31', 89, 2, 26.26, 557.68],
  ['2026-08-01', 62, 1, 3.00, 60.00],   ['2026-08-02', 60, 0, 0, 0],
].map(([date, clicks, conversions, payout, sales]) => ({ date, clicks, conversions, payout, sales }));

const REAL_POSTHOG_DAILY = [
  ['2026-07-20', 51, 45], ['2026-07-21', 39, 26], ['2026-07-22', 48, 41],
  ['2026-07-23', 30, 22], ['2026-07-24', 49, 48], ['2026-07-25', 35, 32],
  ['2026-07-26', 41, 38], ['2026-07-27', 45, 40], ['2026-07-28', 35, 29],
  ['2026-07-29', 38, 34], ['2026-07-30', 29, 24], ['2026-07-31', 29, 26],
  ['2026-08-01', 35, 33], ['2026-08-02', 34, 32],
].map(([date, clicks, ttClicks]) => ({ date, clicks, ttClicks }));

// The 11 real 2026-07-24 conversions — 6 of them one buyer (sub 019f8a47).
const REAL_JUL24_ACTIONS = [
  ['019f91b5', 246.0, 2.46], ['019f7c10', 89.22, 4.46], ['019f4c07', 23.1, 0.23],
  ['019f8a47', 186.42, 9.32], ['019f9517', 597.0, 29.85], ['019f8a47', 260.99, 2.61],
  ['019f8a47', 154.47, 1.54], ['019f8a47', 616.0, 6.16], ['019f8a47', 63.92, 0.64],
  ['019f8c90', 321.0, 16.05], ['019f8a47', 340.89, 3.41],
].map(([SubId1, Amount, Payout]) => ({ EventDate: '2026-07-24T12:00:00-07:00', SubId1, Amount, Payout }));

const REAL_POST_DROP_ACTIONS = [
  ['2026-07-27', 33.0, 0.33], ['2026-07-28', 194.0, 1.94], ['2026-07-29', 91.69, 0.0],
  ['2026-07-30', 35.4, 0.35], ['2026-07-31', 40.4, 0.4], ['2026-07-31', 517.28, 25.86],
  ['2026-08-01', 60.0, 3.0],
].map(([d, Amount, Payout]) => ({ EventDate: `${d}T12:00:00-07:00`, SubId1: `sub-${d}-${Amount}`, Amount, Payout }));

function toFixture() {
  return { impactDaily: REAL_IMPACT_DAILY, posthogDaily: REAL_POSTHOG_DAILY, actions: REAL_POST_DROP_ACTIONS, errors: [] };
}

test('REPLAY: the real -77.6% WoW week trips NO critical check (it was not a breakage)', () => {
  const checks = runChecks({ ...toFixture(), asOf: '2026-08-02' });
  const criticals = checks.filter((c) => c.verdict === 'critical');
  assert.deepEqual(criticals.map((c) => c.key), [], JSON.stringify(criticals, null, 2));
});

test('REPLAY: the 7/24 outlier day and its 6-order buyer get annotated (report context)', () => {
  const weekActions = [...REAL_JUL24_ACTIONS, ...REAL_POST_DROP_ACTIONS.slice(0, 1)];
  const outliers = findOutlierDays(weekActions, { share: 0.4 });
  assert.equal(outliers.length, 1);
  assert.equal(outliers[0].day, '2026-07-24');
  assert.ok(outliers[0].shareOfWindow > 0.9);
  const buyers = findRepeatBuyers(REAL_JUL24_ACTIONS, { minConversions: 3 });
  assert.equal(buyers.length, 1);
  assert.equal(buyers[0].subId1, '019f8a47');
  assert.equal(buyers[0].conversions, 6);
});

test('REPLAY: the real 7/29 $0-payout action counts toward (but alone does not trip) payout anomaly', () => {
  const res = checkPayoutAnomaly({ actions: REAL_POST_DROP_ACTIONS, asOf: '2026-08-02', days: 7 });
  assert.equal(res.zeroPayoutCount, 1);
  assert.equal(res.verdict, 'healthy'); // one $0 payout is tolerated; two is not
});

test('payout anomaly trips on multiple $0-payout conversions', () => {
  const actions = [
    ...REAL_POST_DROP_ACTIONS,
    { EventDate: '2026-08-01T10:00:00-07:00', SubId1: 'z2', Amount: 120, Payout: 0 },
  ];
  const res = checkPayoutAnomaly({ actions, asOf: '2026-08-02', days: 7 });
  assert.equal(res.verdict, 'anomalous');
});

test('payout anomaly trips on a collapsed take-rate (contract change shape)', () => {
  const actions = Array.from({ length: 5 }, (_, i) => ({
    EventDate: `2026-08-0${i + 1}T10:00:00-07:00`, SubId1: `s${i}`, Amount: 200, Payout: 0.5,
  }));
  const res = checkPayoutAnomaly({ actions, asOf: '2026-08-05', days: 7, maxZeroPayout: 99 });
  assert.equal(res.verdict, 'anomalous');
  assert.ok(res.reason.includes('take-rate'));
});

test('handoff break: site clicks flowing, Impact recording almost nothing', () => {
  const posthog = new Map(REAL_POSTHOG_DAILY.map((r) => [r.date, r.ttClicks]));
  const impact = new Map(REAL_IMPACT_DAILY.map((r) => [r.date, 2])); // redirect chain dead
  const res = checkHandoffBreak({ impactClicksByDay: impact, posthogTTClicksByDay: posthog, asOf: '2026-08-02' });
  assert.equal(res.verdict, 'broken');
});

test('handoff break: a SINGLE all-zero Impact day fires even when the 3d ratio looks fine (Codex finding)', () => {
  const posthog = new Map([['2026-07-31', 40], ['2026-08-01', 40], ['2026-08-02', 40]]);
  const impact = new Map([['2026-07-31', 25], ['2026-08-01', 25], ['2026-08-02', 0]]);
  const res = checkHandoffBreak({ impactClicksByDay: impact, posthogTTClicksByDay: posthog, asOf: '2026-08-02' });
  assert.equal(res.verdict, 'broken');
  assert.equal(res.zeroDay, '2026-08-02');
  // ...but a low-traffic zero day stays quiet (Poisson noise, not an outage)
  const quiet = new Map([['2026-07-31', 40], ['2026-08-01', 40], ['2026-08-02', 5]]);
  const res2 = checkHandoffBreak({ impactClicksByDay: impact, posthogTTClicksByDay: quiet, asOf: '2026-08-02' });
  assert.equal(res2.zeroDay === '2026-08-02' && quiet.get('2026-08-02') < 15, false);
});

test('bot divergence trips when Impact clicks dwarf real clicks', () => {
  const posthog = new Map([['2026-08-01', 10], ['2026-08-02', 10], ['2026-07-31', 10]]);
  const impact = new Map([['2026-08-01', 90], ['2026-08-02', 80], ['2026-07-31', 85]]);
  const res = checkBotDivergence({ impactClicksByDay: impact, posthogTTClicksByDay: posthog, asOf: '2026-08-02' });
  assert.equal(res.verdict, 'diverged');
});

test('dead-man fires when BOTH signals are near-zero (correlated failure, pre-mortem case)', () => {
  const dead = new Map([['2026-08-01', 1], ['2026-08-02', 0]]);
  const res = checkDeadMan({ impactClicksByDay: dead, posthogClicksByDay: dead, asOf: '2026-08-02' });
  assert.equal(res.verdict, 'dead');
  // ...and stays quiet when either signal is alive (a normal day)
  const alive = new Map([['2026-08-01', 30], ['2026-08-02', 35]]);
  const res2 = checkDeadMan({ impactClicksByDay: dead, posthogClicksByDay: alive, asOf: '2026-08-02' });
  assert.equal(res2.verdict, 'healthy');
});

test('zero-conversion ceiling: 7 straight zero days fires regardless of clicks', () => {
  const zeros = new Map(
    ['27', '28', '29', '30', '31'].map((d) => [`2026-07-${d}`, 0]).concat([['2026-08-01', 0], ['2026-08-02', 0]])
  );
  assert.equal(checkZeroConversionCeiling({ conversionsByDay: zeros, asOf: '2026-08-02' }).verdict, 'dead');
  zeros.set('2026-07-30', 1);
  assert.equal(checkZeroConversionCeiling({ conversionsByDay: zeros, asOf: '2026-08-02' }).verdict, 'healthy');
});

test('SYNTHETIC: full flatline-with-clicks-flowing scenario goes critical end-to-end', () => {
  // Conversions healthy through 7/24, then dead 9 straight days while clicks flow.
  const impactDaily = REAL_IMPACT_DAILY.map((r) =>
    r.date >= '2026-07-25' ? { ...r, conversions: 0, payout: 0, sales: 0 } : r
  );
  const checks = runChecks({ impactDaily, posthogDaily: REAL_POSTHOG_DAILY, actions: [], errors: [], asOf: '2026-08-02' });
  const flatline = checks.find((c) => c.key === 'affiliate:conversions-flatline');
  assert.equal(flatline.verdict, 'critical', flatline.reason);
  assert.ok(flatline.reason.includes('clicks'));
});

test('SYNTHETIC: missing provider credentials surface as critical auth checks, not healthy zeroes', () => {
  const checks = runChecks({
    impactDaily: [], posthogDaily: REAL_POSTHOG_DAILY, actions: [],
    errors: [{ provider: 'impact', message: 'Impact credentials missing (IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN)' }],
    asOf: '2026-08-02',
  });
  const auth = checks.find((c) => c.key === 'affiliate:provider-auth:impact');
  assert.equal(auth.verdict, 'critical');
  // and no conversion checks pretend to have judged missing data
  assert.ok(!checks.some((c) => c.key === 'affiliate:conversions-flatline'));
});

test('baselineComparison computes window-vs-trailing-baseline per-day deltas', () => {
  const res = baselineComparison(REAL_IMPACT_DAILY, { asOf: '2026-08-02', windowDays: 7, baselineDays: 7 });
  assert.equal(res.window.days, 7);
  assert.equal(res.baseline.days, 7);
  // Current week (~$31.88 payout) vs prior week (~$142) → strongly negative
  assert.ok(res.payoutVsBaselinePct < -50);
});

// ── fetch timeout/retry (2026-08-22 incident: PostHog's 28-day HogQL query
// took >8s once — the Vercel-route-sized default timeout — and paged as a
// false "provider down" while every other check was healthy) ──────────────

test('isTransientFetchError recognizes AbortController timeouts, not real API errors', () => {
  const abortByName = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const abortByMessage = new Error('This operation was aborted');
  assert.equal(isTransientFetchError(abortByName), true);
  assert.equal(isTransientFetchError(abortByMessage), true);
  assert.equal(isTransientFetchError(new Error('PostHog daily clicks error: HTTP 401')), false);
  assert.equal(isTransientFetchError(new Error('Impact credentials missing (IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN)')), false);
});

test('fetchWithOneRetry retries exactly once on a transient abort, then succeeds', async () => {
  let calls = 0;
  const result = await fetchWithOneRetry(() => {
    calls += 1;
    if (calls === 1) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    return Promise.resolve('ok');
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
});

test('fetchWithOneRetry does not retry a non-transient error', async () => {
  let calls = 0;
  await assert.rejects(
    fetchWithOneRetry(() => {
      calls += 1;
      return Promise.reject(new Error('PostHog daily clicks error: HTTP 401'));
    }),
    /HTTP 401/
  );
  assert.equal(calls, 1);
});

test('fetchWithOneRetry surfaces the error if the retry also aborts', async () => {
  let calls = 0;
  await assert.rejects(
    fetchWithOneRetry(() => {
      calls += 1;
      return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    }),
    /aborted/
  );
  assert.equal(calls, 2);
});
