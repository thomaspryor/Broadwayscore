import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { computeAffiliateAccrual, priorMonthOf, daysInPriorMonth, monthsNeedingFinalization, monthRange, applyMonthFinalizations } = require('./revenue-accrual.js');

// ---- BRO-8273: a missed finalization window must self-heal ----
const aff = (month, status, amountUsd = 100) => ({ month, sourceKey: 'affiliate', source: 'Affiliate commissions', amountUsd, status });

test('the 2026-09 gap: Jun/Jul realized, Aug pending, no Sep, run on 2026-11-25 → Aug and Sep need finalizing', () => {
  const ledger = [aff('2026-06', 'realized'), aff('2026-07', 'realized'), aff('2026-08', 'pending'), aff('2026-10', 'realized'), aff('2026-11', 'pending')];
  assert.deepEqual(monthsNeedingFinalization({ todayIso: '2026-11-25', ledger }), ['2026-08', '2026-09']);
});

test('monthsNeedingFinalization: nothing before the first row, current month excluded, capped to most recent', () => {
  assert.deepEqual(monthsNeedingFinalization({ todayIso: '2026-11-25', ledger: [] }), []);
  assert.deepEqual(monthsNeedingFinalization({ todayIso: '2026-11-25', ledger: [aff('2026-11', 'pending')] }), []);
  const capped = monthsNeedingFinalization({ todayIso: '2027-03-02', ledger: [aff('2026-01', 'realized')], maxMonths: 3 });
  assert.deepEqual(capped, ['2026-12', '2027-01', '2027-02']);
});

test('applyMonthFinalizations inserts the missing month, realizes the pending one, leaves other sources alone', () => {
  const ledger = [aff('2026-08', 'pending', 5), { month: '2026-09', sourceKey: 'buymeacoffee', source: 'BMC', amountUsd: 9, status: 'pending' }];
  const { ledger: out } = applyMonthFinalizations(ledger, [{ month: '2026-08', commission: 321.456 }, { month: '2026-09', commission: 88.1 }, { month: '2026-10', commission: 1 }], '2026-11-25');
  const get = (m, k) => out.find((r) => r.month === m && r.sourceKey === k);
  assert.equal(get('2026-08', 'affiliate').status, 'realized');
  assert.equal(get('2026-08', 'affiliate').amountUsd, 321.46);
  assert.equal(get('2026-09', 'affiliate').amountUsd, 88.1);
  assert.equal(get('2026-09', 'buymeacoffee').status, 'pending');
  assert.deepEqual(monthsNeedingFinalization({ todayIso: '2026-11-25', ledger: out }), []);
});

test('monthRange is first-of-month to last second, under the 45-day Impact cap', () => {
  for (let m = 1; m <= 12; m++) {
    const { start, end } = monthRange(`2026-${String(m).padStart(2, '0')}`);
    assert.ok((end - start) / 86400000 < 32);
    assert.equal(start.getUTCDate(), 1);
  }
});

test('mid-month run upserts a pending MTD row only', () => {
  const { ledger, changes } = computeAffiliateAccrual({
    todayIso: '2026-07-20', mtdCommission: 412.345, ledger: [],
  });
  assert.equal(ledger.length, 1);
  assert.deepEqual(changes.map((c) => c.action), ['inserted']);
  assert.equal(ledger[0].month, '2026-07');
  assert.equal(ledger[0].amountUsd, 412.35); // rounded
  assert.equal(ledger[0].status, 'pending');
});

test('early-month run finalizes prior month as (window − MTD) and keeps MTD pending', () => {
  const existing = [
    { month: '2026-06', sourceKey: 'affiliate', source: 'Affiliate commissions', amountUsd: 700, status: 'pending' },
  ];
  const { ledger } = computeAffiliateAccrual({
    todayIso: '2026-07-03', mtdCommission: 55.5, priorWindowCommission: 857.27, ledger: existing,
  });
  const june = ledger.find((r) => r.month === '2026-06');
  const july = ledger.find((r) => r.month === '2026-07');
  assert.equal(june.status, 'realized');
  assert.equal(june.amountUsd, 801.77); // 857.27 − 55.50
  assert.equal(july.status, 'pending');
  assert.equal(july.amountUsd, 55.5);
});

test('realized month is never downgraded back to pending, other sources untouched', () => {
  const existing = [
    { month: '2026-07', sourceKey: 'affiliate', source: 'Affiliate commissions', amountUsd: 900, status: 'realized' },
    { month: '2026-07', sourceKey: 'buymeacoffee', source: 'Buy Me A Coffee', amountUsd: 27.7, status: 'pending' },
  ];
  const { ledger, changes } = computeAffiliateAccrual({
    todayIso: '2026-07-20', mtdCommission: 850, ledger: existing,
  });
  const aff = ledger.find((r) => r.sourceKey === 'affiliate');
  assert.equal(aff.status, 'realized');
  assert.equal(aff.amountUsd, 900); // untouched
  assert.equal(changes[0].action, 'kept-realized');
  const bmac = ledger.find((r) => r.sourceKey === 'buymeacoffee');
  assert.deepEqual(bmac, existing[1]); // never touched
});

test('prior amount floors at zero (window smaller than MTD can only be API noise)', () => {
  const { ledger } = computeAffiliateAccrual({
    todayIso: '2026-03-02', mtdCommission: 100, priorWindowCommission: 80, ledger: [],
  });
  assert.equal(ledger.find((r) => r.month === '2026-02').amountUsd, 0);
});

test('month helpers handle year boundary and leap purposes', () => {
  assert.equal(priorMonthOf('2026-01-05'), '2025-12');
  assert.equal(daysInPriorMonth('2026-03-05'), 28); // Feb 2026
  assert.equal(daysInPriorMonth('2026-01-05'), 31); // Dec 2025
});
