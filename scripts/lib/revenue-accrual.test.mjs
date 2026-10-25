import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { computeAffiliateAccrual, priorMonthOf, daysInPriorMonth } = require('./revenue-accrual.js');

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
