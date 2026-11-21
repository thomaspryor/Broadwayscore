/**
 * Page-weight budgets scale with catalog size, not per-show bloat
 * (tests/e2e/helpers/page-weight.ts). /west-end went red on main 2026-09-29
 * from West End shows being added, not from a regression.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countFlightSlugs,
  MAX_CATALOG_SCALE,
  measurePageWeight,
  scaleBudgetForCatalog,
} from '../e2e/helpers/page-weight';

function flightPage(slugs: string[], padPerShow: number): string {
  const rows = slugs.map((s) => `{\\"slug\\":\\"${s}\\",\\"blob\\":\\"${'x'.repeat(padPerShow)}\\"}`).join(',');
  return `<html><script>self.__next_f.push([1,"[${rows}]"])</script></html>`;
}

const slugs = (n: number) => Array.from({ length: n }, (_, i) => `show-${i}-2026`);
const baselineHtml = flightPage(slugs(100), 1000);
const base = measurePageWeight(baselineHtml);
const budget = { documentBytes: Math.ceil(base.documentBytes * 1.1), rscBytes: Math.ceil(base.rscBytes * 1.1), baselineItems: 100 };

test('countFlightSlugs counts distinct escaped slugs in the flight payload', () => {
  assert.equal(countFlightSlugs(baselineHtml), 100);
  assert.equal(countFlightSlugs(flightPage([...slugs(3), ...slugs(3)], 10)), 3);
  assert.equal(countFlightSlugs('<html>no flight</html>'), 0);
});

test('catalog growth at the same per-show weight stays within the scaled budget', () => {
  const html = flightPage(slugs(130), 1000);
  const m = measurePageWeight(html);
  assert.ok(m.documentBytes > budget.documentBytes, 'fixture must exceed the unscaled budget to prove scaling matters');
  const scaled = scaleBudgetForCatalog('/west-end', budget, countFlightSlugs(html));
  assert.equal(scaled.outgrown, null);
  assert.ok(m.documentBytes <= scaled.documentBytes);
  assert.ok(m.rscBytes <= scaled.rscBytes);
});

test('per-show bloat (#419 shape) still fails: bytes grow, slug count does not', () => {
  const html = flightPage(slugs(100), 2000);
  const m = measurePageWeight(html);
  const scaled = scaleBudgetForCatalog('/west-end', budget, countFlightSlugs(html));
  assert.equal(scaled.scale, 1);
  assert.ok(m.documentBytes > scaled.documentBytes);
});

test('a shrinking catalog never loosens the budget; growth past the cap reports outgrown', () => {
  assert.equal(scaleBudgetForCatalog('/x', budget, 50).scale, 1);
  const over = scaleBudgetForCatalog('/x', budget, Math.ceil(100 * MAX_CATALOG_SCALE) + 1);
  assert.equal(over.scale, MAX_CATALOG_SCALE);
  assert.match(over.outgrown ?? '', /re-derive/);
});

test('a budget without baselineItems is never scaled', () => {
  const fixed = { documentBytes: 1000, rscBytes: 500 };
  assert.deepEqual(scaleBudgetForCatalog('/guide', fixed, 999), { documentBytes: 1000, rscBytes: 500, scale: 1, outgrown: null });
});
