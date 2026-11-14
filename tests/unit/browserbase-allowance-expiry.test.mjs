// BRO-6872: a Browserbase caller allowance warns 14 days ahead, keeps warning once it has ended, and its card closes
// only when the entry is extended or deleted. Real helper and real alert runner, injected router.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const caps = require('../../scripts/lib/browserbase-caps.js');
const { runAllowanceExpiryAlerts, ALLOWANCE_KEY_PREFIX } = require('../../scripts/check-provider-spend.js');

const allowances = { a: { sessionsPerDay: 8, until: '2026-12-01T00:00:00Z' } };
const at = (iso) => caps.expiringCallerAllowances({ now: new Date(iso), allowances });

test('outside the window: nothing', () => {
  assert.deepEqual(at('2026-11-16T23:59:00Z'), []);
});

test('inside the window, including exactly 14 days ahead', () => {
  assert.deepEqual(at('2026-11-17T00:00:00Z'), [{ caller: 'a', until: '2026-12-01T00:00:00Z', daysLeft: 14, expired: false }]);
  assert.deepEqual(at('2026-11-30T12:00:00Z'), [{ caller: 'a', until: '2026-12-01T00:00:00Z', daysLeft: 1, expired: false }]);
});

test('an allowance that has ended but is still listed keeps being reported', () => {
  assert.deepEqual(at('2026-12-01T00:00:00Z'), [{ caller: 'a', until: '2026-12-01T00:00:00Z', daysLeft: 0, expired: true }]);
  assert.deepEqual(at('2027-03-01T00:00:00Z').map((e) => e.expired), [true]);
});

test('the real allowances do not end within 14 days of this change', () => {
  assert.deepEqual(caps.expiringCallerAllowances({ now: new Date('2026-11-04T12:00:00Z') }), []);
  assert.equal(caps.callerAllowance('opening-night-lane', { now: new Date('2026-11-19T23:00:00Z'), env: {} }), 8, "Much Ado's opening night is covered");
});

function router(open = {}) {
  const routed = []; const resolved = [];
  return {
    routed, resolved,
    routeAlert: async (o) => { routed.push(o); return { action: 'auto', linearIdentifier: 'BRO-1', dispatchOk: true }; },
    resolveCondition: (key) => { resolved.push(key); return true; },
    loadLedger: () => ({ conditions: open }),
  };
}

test('an expiring and an ended allowance each file a card with a VERIFY line; the ended one is an error', async () => {
  const r = router();
  await runAllowanceExpiryAlerts({ router: r, expiring: [
    { caller: 'a', until: '2026-12-01T00:00:00Z', daysLeft: 5, expired: false },
    { caller: 'b', until: '2026-11-01T00:00:00Z', daysLeft: 0, expired: true },
  ] });
  assert.deepEqual(r.routed.map((o) => o.conditionKey), [`${ALLOWANCE_KEY_PREFIX}a`, `${ALLOWANCE_KEY_PREFIX}b`]);
  assert.deepEqual(r.routed.map((o) => o.severity), ['warning', 'error']);
  assert.ok(r.routed.every((o) => /^VERIFY: node --test tests\/live\//.test(o.verify.line)));
  assert.deepEqual(r.resolved, []);
});

test('a deleted or extended entry closes its open card; other alert families are left alone', async () => {
  const r = router({
    [`${ALLOWANCE_KEY_PREFIX}gone`]: { status: 'open' },
    [`${ALLOWANCE_KEY_PREFIX}still`]: { status: 'open' },
    [`${ALLOWANCE_KEY_PREFIX}old`]: { status: 'resolved' },
    'provider-spend:overspend': { status: 'open' },
  });
  await runAllowanceExpiryAlerts({ router: r, expiring: [{ caller: 'still', until: '2026-12-01T00:00:00Z', daysLeft: 3, expired: false }] });
  assert.deepEqual(r.resolved, [`${ALLOWANCE_KEY_PREFIX}gone`]);
});
