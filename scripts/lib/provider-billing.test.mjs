// Fixture tests for the pure billing parsers. Fixtures are captured from the
// real provider responses on 2026-07-30 (the session that built this layer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseBdZoneCost, parseBdBalance, countBbSessionsOnDay, bbPayloadCoversDay, sumBbMinutesOnDay, parseSbUsage, sbCostReportFields, parseSdAccount, sbUsageFields,
} = require('./provider-billing.js');

test('parseBdZoneCost sums cost and reqs_* across customers', () => {
  const fixture = {
    hl_9b2d5c61: { custom: { cost: 77.84, bw: 5647514139, range: { from: '15-Jul-2026', to: '30-Jul-2026' }, reqs_serp: 51893, gbs: 0.0000892 } },
  };
  assert.deepEqual(parseBdZoneCost(fixture), { cost: 77.84, reqs: 51893 });
});

test('parseBdZoneCost handles multiple reqs_* keys', () => {
  const fixture = { c1: { custom: { cost: 1.5, reqs_unblocker: 100, reqs_serp: 24 } } };
  assert.deepEqual(parseBdZoneCost(fixture), { cost: 1.5, reqs: 124 });
});

test('parseBdZoneCost: empty object is a real $0 day, garbage is null', () => {
  assert.deepEqual(parseBdZoneCost({}), { cost: 0, reqs: 0 });
  assert.equal(parseBdZoneCost(null), null);
  assert.equal(parseBdZoneCost({ oops: 'string' }), null);
});

test('parseBdBalance', () => {
  assert.deepEqual(
    parseBdBalance({ balance: 36.13, credit: 0, prepayment: 0, pending_costs: 278.48 }),
    { balance: 36.13, pendingCosts: 278.48 },
  );
  assert.equal(parseBdBalance({}), null);
});

test('countBbSessionsOnDay counts only the requested UTC day', () => {
  const sessions = [
    { createdAt: '2026-07-30T23:57:47.785646+00:00' },
    { createdAt: '2026-07-30T00:01:00+00:00' },
    { createdAt: '2026-07-29T23:59:59+00:00' },
    { noCreatedAt: true },
  ];
  assert.equal(countBbSessionsOnDay(sessions, '2026-07-30'), 2);
  assert.equal(countBbSessionsOnDay({ data: sessions }, '2026-07-30'), 2);
  assert.equal(countBbSessionsOnDay({ nonsense: true }, '2026-07-30'), null);
});

test('Browserbase truncation guard (BRO-3010): a list that does not reach back before the day is unknown, never an undercount', () => {
  const full = [
    { createdAt: '2026-07-30T10:00:00+00:00', startedAt: '2026-07-30T10:00:00+00:00', endedAt: '2026-07-30T10:01:00+00:00' },
    { createdAt: '2026-07-28T09:00:00+00:00' },
  ];
  assert.equal(bbPayloadCoversDay(full, '2026-07-30'), true);
  assert.equal(countBbSessionsOnDay(full, '2026-07-30'), 1);
  assert.equal(sumBbMinutesOnDay(full, '2026-07-30'), 1);
  // Oldest session is inside the target day: the server may have cut the list.
  const truncated = [
    { createdAt: '2026-07-30T23:00:00+00:00' },
    { createdAt: '2026-07-30T05:00:00+00:00' },
  ];
  assert.equal(bbPayloadCoversDay(truncated, '2026-07-30'), false);
  assert.equal(countBbSessionsOnDay(truncated, '2026-07-30'), null);
  assert.equal(sumBbMinutesOnDay({ data: truncated }, '2026-07-30'), null);
  // A session starting exactly at midnight does not prove the day is complete.
  assert.equal(bbPayloadCoversDay([{ createdAt: '2026-07-30T00:00:00+00:00' }], '2026-07-30'), false);
  // Empty list is complete (no sessions ever); no parseable timestamps is not.
  assert.equal(countBbSessionsOnDay([], '2026-07-30'), 0);
  assert.equal(bbPayloadCoversDay([{ noCreatedAt: true }], '2026-07-30'), false);
  assert.equal(bbPayloadCoversDay(full, 'garbage'), false);
});

test('sumBbMinutesOnDay (BRO-3240): sums real duration for the requested day, skips sessions missing timestamps', () => {
  const sessions = [
    // 2 min session, in-day
    { createdAt: '2026-07-30T10:00:00.000+00:00', startedAt: '2026-07-30T10:00:00.000+00:00', endedAt: '2026-07-30T10:02:00.000+00:00' },
    // 30s session, in-day
    { createdAt: '2026-07-30T11:00:00.000+00:00', startedAt: '2026-07-30T11:00:00.000+00:00', endedAt: '2026-07-30T11:00:30.000+00:00' },
    // created the day before — excluded
    { createdAt: '2026-07-29T23:59:00.000+00:00', startedAt: '2026-07-29T23:59:00.000+00:00', endedAt: '2026-07-30T00:01:00.000+00:00' },
    // in-day but still running (no endedAt) — excluded, not zero
    { createdAt: '2026-07-30T12:00:00.000+00:00', startedAt: '2026-07-30T12:00:00.000+00:00' },
  ];
  assert.equal(sumBbMinutesOnDay(sessions, '2026-07-30'), 2.5);
  assert.equal(sumBbMinutesOnDay({ data: sessions }, '2026-07-30'), 2.5);
  assert.equal(sumBbMinutesOnDay({ nonsense: true }, '2026-07-30'), null);
  assert.equal(sumBbMinutesOnDay([], '2026-07-30'), 0);
});

test('parseSbUsage (real 2026-07-30 exhausted-cycle fixture)', () => {
  const fixture = {
    max_api_credit: 1000000, used_api_credit: 1000012, max_concurrency: 100,
    current_concurrency: 0, renewal_subscription_date: '2026-08-05T18:40:36.521772',
  };
  assert.deepEqual(parseSbUsage(fixture), { cycleUsed: 1000012, cap: 1000000, renewalDate: '2026-08-05' });
  assert.equal(parseSbUsage({}), null);
});

test('sbUsageFields passes values through untouched so callers keep their own defaults (BRO-3010)', () => {
  const fixture = { max_api_credit: 1000000, used_api_credit: 1000012, renewal_subscription_date: '2026-08-05T18:40:36.521772' };
  const f = sbUsageFields(fixture);
  assert.equal(f.used, fixture.used_api_credit);
  assert.equal(f.max, fixture.max_api_credit);
  assert.equal(f.renewalAt, fixture.renewal_subscription_date);
  // absent fields stay undefined (not 0/null), so `x || 0` / `Number(x) || 0`
  // at each call site behaves exactly as it did on the raw payload
  assert.deepEqual(sbUsageFields({}), { used: undefined, max: undefined, renewalAt: undefined });
  assert.deepEqual(sbUsageFields(null), { used: undefined, max: undefined, renewalAt: undefined });
  assert.deepEqual(sbUsageFields({ used_api_credit: '12' }), { used: '12', max: undefined, renewalAt: undefined });
});

test('parseSdAccount', () => {
  assert.deepEqual(
    parseSdAccount({ requestUsed: 189655, requestLimit: 1000000, validity: 26, pack: 'standard' }),
    { cycleUsed: 189655, limit: 1000000, daysToRenewal: 26 },
  );
  assert.equal(parseSdAccount({ pack: 'standard' }), null);
});

test('sbCostReportFields (BRO-3010): the cost-report line the python one-liner used to compute', () => {
  const now = new Date('2026-10-17T05:00:00Z');
  const json = { max_api_credit: 1000000, used_api_credit: 412345, renewal_subscription_date: '2026-11-04T18:40:36.521772' };
  // days_left = floor(17.79) = 17, elapsed 14, projected 412345/14*31 = 913050
  assert.deepEqual(sbCostReportFields(json, now), { reportLine: '41.2|91|412345|1000000|913050', renewalLabel: 'Nov 04' });
  assert.deepEqual(sbCostReportFields({}, now), { reportLine: '0.0|0|0|1|0', renewalLabel: 'unknown' });
  assert.throws(() => sbCostReportFields({ used_api_credit: '5' }, now));
  assert.throws(() => sbCostReportFields({ used_api_credit: 5, max_api_credit: 10, renewal_subscription_date: 'soon' }, now));
});
