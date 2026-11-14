import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildAffiliateReportHtml, formatUsd } = require('./affiliate-email.js');

const base = {
  window: { days: 7, startDate: '2026-10-19', endDate: '2026-10-25' },
  impact: { skipped: true, reason: 'test' },
  errors: [],
  totals: { commission: 0, conversions: 0, revenue: 0 },
  updatedAt: '2026-10-26T13:00:00Z',
};

test('platform card: paid rows in the table, unpaid sellers in one line', () => {
  const html = buildAffiliateReportHtml({ ...base, perPlatform: [
    { platform: 'TodayTix', affiliate: true, clicks: 305, conversions: 21, conversionRate: 0.069, commission: 119.65, epc: 0.392 },
    { platform: '<Box>', affiliate: false, clicks: 12 },
  ] });
  assert.match(html, />TodayTix</);
  assert.match(html, /12 clicks went to sellers with no affiliate program: &lt;Box&gt; 12\./);
  assert.match(html, /<th[^>]*>Platform<\/th>/);
});

test('platform card: no header-only table when every seller is unpaid', () => {
  const html = buildAffiliateReportHtml({ ...base, perPlatform: [
    { platform: 'Telecharge', affiliate: false, clicks: 20 },
    { platform: 'SeatPlan', affiliate: false, clicks: 10 },
  ] });
  assert.match(html, /30 clicks went to sellers with no affiliate program/);
  assert.doesNotMatch(html, /<th[^>]*>Platform<\/th>/);
  assert.doesNotMatch(html, /EPC = earnings per click/);
});

test('money over $1,000 gets a thousands separator', () => {
  const html = buildAffiliateReportHtml({ ...base, totals: { commission: 1234.5, conversions: 2, revenue: 4557.79 } });
  assert.match(html, /\$1,234\.50/);
  assert.match(html, /\$4,557\.79 attributed sales/);
});

test('formatUsd: sign before the symbol, dash for NaN/Infinity, no negative zero', () => {
  assert.equal(formatUsd(-12.34), '-$12.34');
  assert.equal(formatUsd(-0.001), '$0.00');
  assert.equal(formatUsd(NaN), '—');
  assert.equal(formatUsd(Infinity), '—');
  assert.equal(formatUsd(null), '—');
  assert.equal(formatUsd(4557.79), '$4,557.79');
});
