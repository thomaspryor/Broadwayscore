import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { MARKET_PAGE_BUDGETS, HUB_PAGE_BUDGETS, CORE_PAGE_BUDGETS, measureHtml, evaluateBudget } = require('./page-weight.js');

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
  const routes = [...MARKET_PAGE_BUDGETS, ...HUB_PAGE_BUDGETS, ...CORE_PAGE_BUDGETS].map(b => b.route);
  assert.strictEqual(new Set(routes).size, routes.length, 'no route budgeted twice');
});

test('core page budgets cover the homepage and a show page (BRO-6278)', () => {
  assert.deepStrictEqual(CORE_PAGE_BUDGETS.map(b => b.route), ['/', '/show/hamilton-2015/']);
  const home = CORE_PAGE_BUDGETS[0];
  // Pre-trim the homepage was 662,757 bytes; a re-inlined shelf payload must trip the budget.
  assert.strictEqual(evaluateBudget(home, 'x'.repeat(662_757)).violations.length, 1);
  assert.deepStrictEqual(evaluateBudget(home, 'x'.repeat(324_535)).violations, []);
});

test('/off-broadway budget stays tight after BRO-6325 (closed shows out of ItemList JSON-LD)', () => {
  const ob = MARKET_PAGE_BUDGETS.find(b => b.route === '/off-broadway');
  assert.ok(ob.maxBytes <= 700_000, `expected <=700000, got ${ob.maxBytes}`);
});
