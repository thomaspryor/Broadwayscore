// Fixture tests for the pure billing parsers. Fixtures are captured from the
// real provider responses on 2026-07-30 (the session that built this layer).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  parseBdZoneCost, parseBdBalance, countBbSessionsOnDay, parseSbUsage, parseSdAccount,
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
  assert.equal(countBbSessionsOnDay({ data: sessions }, '2026-07-29'), 1);
  assert.equal(countBbSessionsOnDay({ nonsense: true }, '2026-07-30'), null);
});

test('parseSbUsage (real 2026-07-30 exhausted-cycle fixture)', () => {
  const fixture = {
    max_api_credit: 1000000, used_api_credit: 1000012, max_concurrency: 100,
    current_concurrency: 0, renewal_subscription_date: '2026-08-05T18:40:36.521772',
  };
  assert.deepEqual(parseSbUsage(fixture), { cycleUsed: 1000012, cap: 1000000, renewalDate: '2026-08-05' });
  assert.equal(parseSbUsage({}), null);
});

test('parseSdAccount', () => {
  assert.deepEqual(
    parseSdAccount({ requestUsed: 189655, requestLimit: 1000000, validity: 26, pack: 'standard' }),
    { cycleUsed: 189655, limit: 1000000, daysToRenewal: 26 },
  );
  assert.equal(parseSdAccount({ pack: 'standard' }), null);
});
