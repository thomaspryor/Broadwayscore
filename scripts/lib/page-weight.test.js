'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { MARKET_PAGE_BUDGETS, HUB_PAGE_BUDGETS, measureHtml, evaluateBudget } = require('./page-weight.js');

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

test('hub page budgets stay under Googlebot\'s 2MB read limit (BRO-5968)', () => {
  assert.ok(HUB_PAGE_BUDGETS.some(b => b.route === '/browse/best-broadway-shows-all-time'));
  for (const b of HUB_PAGE_BUDGETS) { assert.ok(b.maxBytes < 2_000_000, `${b.route} budget must stay under 2MB`); }
  const routes = [...MARKET_PAGE_BUDGETS, ...HUB_PAGE_BUDGETS].map(b => b.route);
  assert.strictEqual(new Set(routes).size, routes.length, 'no route budgeted twice');
});
