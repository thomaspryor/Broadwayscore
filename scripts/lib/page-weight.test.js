'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MARKET_PAGE_BUDGETS, measureHtml, evaluateBudget } = require('./page-weight.js');

const budget = MARKET_PAGE_BUDGETS[0];

test('measureHtml counts bytes and img tags', () => {
  const m = measureHtml('<div><img src="a"><IMG src="b"><image></div>');
  assert.strictEqual(m.imgs, 2);
  assert.ok(m.bytes > 0);
});

test('page under budget has no violations', () => {
  const r = evaluateBudget(budget, '<img src="a">'.repeat(20));
  assert.deepStrictEqual(r.violations, []);
});

test('too many images is a violation', () => {
  const r = evaluateBudget(budget, '<img src="a">'.repeat(budget.maxImgs + 1));
  assert.strictEqual(r.violations.length, 1);
  assert.match(r.violations[0], /<img>/);
});

test('oversized html is a violation', () => {
  const r = evaluateBudget(budget, 'x'.repeat(budget.maxBytes + 1));
  assert.strictEqual(r.violations.length, 1);
  assert.match(r.violations[0], /bytes/);
});

test('budgets cover the three market pages at the card thresholds', () => {
  assert.deepStrictEqual(MARKET_PAGE_BUDGETS.map(b => b.route), ['/west-end', '/off-broadway', '/off-west-end']);
  for (const b of MARKET_PAGE_BUDGETS) { assert.ok(b.maxBytes <= 1_000_000 && b.maxImgs <= 150); }
});
