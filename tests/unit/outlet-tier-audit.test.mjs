// TESTS-VS-DERIVED-DATA-EXEMPT: synthetic fixtures only; no hardcoded show/critic facts.
/**
 * Unit tests for scripts/lib/outlet-tier-audit.js (BRO-4907 outlet tier audit).
 * Run: node --test tests/unit/outlet-tier-audit.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';

const require = createRequire(import.meta.url);
const {
  yearOf,
  median,
  corpusYearTotals,
  computeOutletStats,
  resolveCurrentTier,
  applyProposals,
  loadScorerWithTiers,
  simulateImpact,
  MIN_CORPUS_YEAR_TOTAL,
} = require('../../scripts/lib/outlet-tier-audit');

const rev = (outletId, publishDate, extra = {}) => ({ outletId, publishDate, showId: 's1', ...extra });

function fillYear(rows, year, n, outletId = 'filler') {
  for (let i = 0; i < n; i++) rows.push(rev(outletId, `${year}-06-01`));
}

describe('yearOf / median', () => {
  it('parses ISO dates and rejects junk', () => {
    assert.strictEqual(yearOf('2018-03-04'), 2018);
    assert.strictEqual(yearOf('2018-13-04'), null);
    assert.strictEqual(yearOf(''), null);
    assert.strictEqual(yearOf(undefined), null);
  });
  it('median handles odd, even, empty', () => {
    assert.strictEqual(median([3, 1, 2]), 2);
    assert.strictEqual(median([1, 2, 3, 4]), 2.5);
    assert.strictEqual(median([]), null);
  });
});

describe('computeOutletStats normalization', () => {
  it('a constant share reads the same whether the corpus is small or large', () => {
    const rows = [];
    // 2016: corpus 1000, outlet A has 50 (5%). 2026: corpus 5000, A has 250 (5%).
    fillYear(rows, 2016, 950);
    fillYear(rows, 2016, 50, 'a');
    fillYear(rows, 2026, 4750);
    fillYear(rows, 2026, 250, 'a');
    const a = computeOutletStats(rows).get('a');
    // span 2016..2026 includes zero years 2017-2025, but those years have no
    // corpus rows (< MIN_CORPUS_YEAR_TOTAL) so they are skipped.
    assert.ok(Math.abs(a.normalizedShare - 0.05) < 1e-9);
    assert.strictEqual(a.total, 300);
    assert.strictEqual(a.activeYears, 2);
    assert.strictEqual(a.meanPerYear, 150);
  });

  it('recent-heavy outlet does not outrank a steady one on normalized share', () => {
    const rows = [];
    for (const y of [2016, 2017, 2018]) {
      fillYear(rows, y, 900);
      fillYear(rows, y, 100, 'steady'); // 10% each year
    }
    fillYear(rows, 2026, 5000);
    fillYear(rows, 2026, 400, 'recent'); // 400 raw, ~7.4%
    const s = computeOutletStats(rows);
    assert.ok(s.get('recent').total > s.get('steady').total);
    assert.ok(s.get('steady').normalizedShare > s.get('recent').normalizedShare);
  });

  it('counts zero years inside the span and skips thin corpus years', () => {
    const rows = [];
    fillYear(rows, 2016, 990);
    fillYear(rows, 2016, 10, 'gap');
    fillYear(rows, 2017, 1000); // gap outlet absent: share 0
    fillYear(rows, 2018, 990);
    fillYear(rows, 2018, 10, 'gap');
    rows.push(rev('gap', '1988-05-01')); // thin year: skipped from share
    fillYear(rows, 1988, 5);
    const g = computeOutletStats(rows).get('gap');
    assert.ok(Math.abs(g.normalizedShare - (0.01 + 0 + 0.01) / 3) < 1e-9);
    assert.ok(MIN_CORPUS_YEAR_TOTAL > 6);
  });

  it('undated reviews count in totals only; months in span include zeros', () => {
    const rows = [rev('m', '2018-01-10'), rev('m', '2018-01-20'), rev('m', '2018-04-01'), rev('m', null), rev('m', '')];
    const m = computeOutletStats(rows).get('m');
    assert.strictEqual(m.total, 5);
    assert.strictEqual(m.dated, 3);
    assert.strictEqual(m.undated, 2);
    // months Jan..Apr = [2,0,0,1] → median 0.5
    assert.strictEqual(m.medianPerMonth, 0.5);
    assert.strictEqual(m.first, '2018-01-10');
    assert.strictEqual(m.last, '2018-04-01');
  });

  it('splits counts by market and baseline/recent windows', () => {
    const rows = [
      rev('x', '2016-01-01', { showId: 'ny' }),
      rev('x', '2023-01-01', { showId: 'ldn' }),
      rev('y', '2016-01-01', { showId: 'ny' }),
    ];
    const x = computeOutletStats(rows, { categoryByShow: { ny: 'broadway', ldn: 'west-end' } }).get('x');
    assert.strictEqual(x.nycReviews, 1);
    assert.strictEqual(x.londonReviews, 1);
    assert.strictEqual(x.share2015_19, 0.5);
    assert.strictEqual(x.share2022plus, 1);
    assert.deepStrictEqual(corpusYearTotals(rows), { 2016: 2, 2023: 1 });
  });
});

describe('resolveCurrentTier precedence', () => {
  const config = { cfg: { tier: 2, tiers: { london: 1 } } };
  const registry = { cfg: { tier: 4 }, reg: { tier: 4 } };
  it('config beats registry beats default', () => {
    assert.deepStrictEqual(resolveCurrentTier('cfg', config, registry), { nyc: 2, london: 1, source: 'config' });
    assert.deepStrictEqual(resolveCurrentTier('reg', config, registry), { nyc: 4, london: 4, source: 'registry' });
    assert.deepStrictEqual(resolveCurrentTier('none', config, registry), { nyc: 3, london: 3, source: 'default' });
  });
});

describe('applyProposals + scorer swap', () => {
  const tiersPath = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'src', 'config', 'outlet-tiers.json');
  const realTiers = JSON.parse(fs.readFileSync(tiersPath, 'utf8'));

  it('does not mutate the input config', () => {
    const cfg = { a: { tier: 3, name: 'A' } };
    const next = applyProposals(cfg, [{ outletId: 'a', nyc: 2, london: 2 }, { outletId: 'b', nyc: 4, london: 3 }]);
    assert.strictEqual(cfg.a.tier, 3);
    assert.strictEqual(cfg.b, undefined);
    assert.strictEqual(next.a.tier, 2);
    assert.deepStrictEqual(next.b.tiers, { nyc: 4, london: 3 });
  });

  it('moving an outlet up pulls the score toward its review, file untouched', () => {
    const before = fs.readFileSync(tiersPath, 'utf8');
    const cfg = { hi: { tier: 1, name: 'Hi' }, lo: { tier: 4, name: 'Lo' } };
    const reviews = [
      { showId: 's', outletId: 'hi', criticName: 'Critic Hi', assignedScore: 90, publishDate: '2020-01-01', contentTier: 'complete' },
      { showId: 's', outletId: 'lo', criticName: 'Critic Lo', assignedScore: 30, publishDate: '2020-01-01', contentTier: 'complete' },
    ];
    const base = loadScorerWithTiers(cfg)(reviews, {}, 'broadway');
    const moved = simulateImpact({
      reviews, shows: [{ id: 's', category: 'broadway' }], registry: {}, tiersConfig: cfg,
      proposals: [{ outletId: 'lo', nyc: 1, london: 1 }],
    });
    assert.strictEqual(moved.length, 1);
    assert.strictEqual(moved[0].before, base.s);
    assert.ok(moved[0].after < moved[0].before);
    assert.strictEqual(fs.readFileSync(tiersPath, 'utf8'), before);
  });

  it('restores the real scorer after a swap', () => {
    loadScorerWithTiers({});
    const { computeCriticScore } = require('../../scripts/lib/compute-critic-score');
    const anyT1 = Object.keys(realTiers).find(k => realTiers[k].tier === 1 && !realTiers[k].tiers);
    const anyT4 = Object.keys(realTiers).find(k => realTiers[k].tier === 4 && !realTiers[k].tiers);
    const r = computeCriticScore([
      { outletId: anyT1, criticName: 'X', assignedScore: 90, publishDate: '2020-01-01' },
      { outletId: anyT4, criticName: 'Y', assignedScore: 30, publishDate: '2020-01-01' },
    ], {}, 'broadway');
    // With real tiers (1.0 vs 0.2) the score sits near 90, not the 60 midpoint
    // an empty config (both default T3) would give.
    assert.ok(r.s > 75, `got ${r.s}`);
  });
});
