// Unit test for the P&L rollup module (require the real module — Rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { computeFinanceStats, recentMonths } = require('./finance-stats.js');

const expenses = [
  { date: '2026-05-10', vendorKey: 'anthropic', vendor: 'Anthropic', category: 'llm', kind: 'usage-recharge', amountUsd: 500, businessPct: 100, amountBusiness: 500 },
  { date: '2026-06-10', vendorKey: 'anthropic', vendor: 'Anthropic', category: 'llm', kind: 'usage-recharge', amountUsd: 1000, businessPct: 100, amountBusiness: 1000 },
  { date: '2026-06-15', vendorKey: 'scrapingbee', vendor: 'ScrapingBee', category: 'scraping', kind: 'subscription', amountUsd: 99.99, businessPct: 100, amountBusiness: 99.99 },
  { date: '2026-06-20', vendorKey: 'x-premium', vendor: 'X Premium', category: 'other', kind: 'subscription', amountUsd: 8, businessPct: 50, amountBusiness: 4 },
];
const revenue = [
  { month: '2026-05', sourceKey: 'affiliate', source: 'Affiliate', amountUsd: 200, status: 'realized' },
  { month: '2026-06', sourceKey: 'affiliate', source: 'Affiliate', amountUsd: 300, status: 'realized' },
  { month: '2026-06', sourceKey: 'buymeacoffee', source: 'Buy Me A Coffee', amountUsd: 15, status: 'pending' },
];

test('recentMonths enumerates trailing months across a year boundary', () => {
  assert.deepEqual(recentMonths('2026-02', 3), ['2025-12', '2026-01', '2026-02']);
});

test('current-month net = realized revenue − business expense; pending excluded', () => {
  const s = computeFinanceStats({ expenses, revenue, asOfMonth: '2026-06', monthsBack: 3 });
  // Business expense June = 1000 + 99.99 + 4 (X Premium at 50%) = 1103.99
  assert.equal(s.current.expense, 1103.99);
  assert.equal(s.current.revenue, 300);          // pending $15 NOT counted
  assert.equal(s.current.revenuePending, 15);
  assert.equal(s.current.net, round(300 - 1103.99));
});

test('businessPct is respected (X Premium booked at 50% → $4 not $8)', () => {
  const s = computeFinanceStats({ expenses, revenue, asOfMonth: '2026-06', monthsBack: 3 });
  const x = s.byVendor.find((v) => v.vendorKey === 'x-premium');
  assert.equal(x.amount, 4);
});

test('MoM expense delta and category rollup', () => {
  const s = computeFinanceStats({ expenses, revenue, asOfMonth: '2026-06', monthsBack: 3 });
  // May expense 500 → June 1103.99 ⇒ +120.8%
  assert.ok(s.momExpenseDeltaPct > 120 && s.momExpenseDeltaPct < 121);
  const llm = s.byCategory.find((c) => c.category === 'llm');
  assert.equal(llm.amount, 1000);
  assert.equal(s.byCategory[0].category, 'llm'); // sorted desc
});

test('recurring vs usage split by kind', () => {
  const s = computeFinanceStats({ expenses, revenue, asOfMonth: '2026-06', monthsBack: 3 });
  assert.equal(s.recurringVsUsage.recurring, 103.99); // scrapingbee 99.99 + x-premium 4
  assert.equal(s.recurringVsUsage.usage, 1000);       // anthropic
});

test('runway = cashOnHand / trailing-3mo burn when provided', () => {
  const s = computeFinanceStats({ expenses, revenue, asOfMonth: '2026-06', monthsBack: 3, cashOnHand: 2000 });
  // burn = avg(0[Apr], 500[May], 1103.99[Jun]) = 534.66; runway = 2000/534.66 ≈ 3.74
  assert.ok(s.runwayMonths > 3.5 && s.runwayMonths < 4.0);
});

function round(n) { return Math.round(n * 100) / 100; }
