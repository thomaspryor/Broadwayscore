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
  computeQualitySignals,
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

describe('resolveCurrentTier parity with the real scorer', () => {
  // Infer the scorer's tier for outlet x: x scores 0, reference T1 outlet scores 100.
  // s = 100 * 1 / (1 + w)  →  w = 100 / s - 1.
  const WEIGHT_TO_TIER = { '1': 1, '0.75': 2, '0.4': 3, '0.2': 4 };
  function scorerTier(cfg, registry, category) {
    const score = loadScorerWithTiers({ ...cfg, ref: { tier: 1 } });
    const r = score([
      { outletId: 'x', criticName: 'A', assignedScore: 0, publishDate: '2020-01-01' },
      { outletId: 'ref', criticName: 'B', assignedScore: 100, publishDate: '2020-01-01' },
    ], registry, category);
    return WEIGHT_TO_TIER[String(Math.round((100 / r.s - 1) * 100) / 100)];
  }
  const cases = [
    ['config only', { x: { tier: 2 } }, {}],
    ['config regional', { x: { tier: 2, tiers: { nyc: 2, london: 1 } } }, {}],
    ['config london-only tiers, no tier: falls to registry', { x: { tiers: { london: 2 } } }, { x: { tier: 4 } }],
    ['registry regional', {}, { x: { tier: 3, tiers: { london: 4 } } }],
    ['nothing: default', {}, {}],
  ];
  for (const [name, cfg, registry] of cases) {
    it(name, () => {
      const got = resolveCurrentTier('x', cfg, registry);
      assert.strictEqual(got.nyc, scorerTier(cfg, registry, 'broadway'), 'nyc');
      assert.strictEqual(got.london, scorerTier(cfg, registry, 'west-end'), 'london');
    });
  }
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

describe('computeQualitySignals', () => {
  const tiers = { top1: 1, top2: 1, top3: 2, blog: 4, mixed: 3 };
  const tierOf = (id) => tiers[id] || 3;
  const r = (showId, outletId, criticName, assignedScore) => ({ showId, outletId, criticName, assignedScore });

  it('pickup counts only shows Show Score lists critics for', () => {
    const reviews = [r('a', 'blog', 'B', 80), r('a', 'blog', 'B2', 80), r('b', 'blog', 'B', 80), r('c', 'blog', 'B', 80), r('d', 'blog', 'B', 80)];
    const showScoreShows = {
      a: { criticReviews: [{ outlet: 'The Blog' }], criticReviewCount: 1 },
      b: { criticReviews: [{ outlet: 'Other' }], criticReviewCount: 1 },
      c: { criticReviews: [] },
      d: { criticReviews: [{ outlet: 'Other' }], criticReviewCount: 9 }, // truncated: skipped
    };
    const s = computeQualitySignals({ reviews, showScoreShows, normalizeOutlet: n => (n === 'The Blog' ? 'blog' : 'other'), tierOf }).get('blog');
    assert.strictEqual(s.showScoreEligible, 2);
    assert.strictEqual(s.showScoreListed, 1);
    assert.strictEqual(s.pickupRate, 0.5);
  });

  it('consensus compares with other outlets at T1/T2 and needs enough peers', () => {
    const reviews = [
      r('a', 'top1', 'X', 60), r('a', 'top2', 'Y', 70), r('a', 'top3', 'Z', 80), r('a', 'blog', 'B', 90),
      r('b', 'top1', 'X', 60), r('b', 'blog', 'B', 10), // only one peer: skipped
    ];
    reviews.push(r('a', 'top1', 'X2', 60)); // duplicate peer row: counted once
    const s = computeQualitySignals({ reviews, tierOf }).get('blog');
    assert.strictEqual(s.consensusN, 1);
    assert.strictEqual(s.consensusBias, 20);
    assert.strictEqual(s.consensusMad, 20);
    // top1 is not its own peer, and the T4 blog is not a peer: 2 left, skipped
    assert.strictEqual(computeQualitySignals({ reviews, tierOf }).get('top1').consensusN, 0);
  });

  it('crossover needs 3+ reviews at a different T1/T2 outlet', () => {
    const reviews = [
      r('a', 'top1', 'Pro', 50), r('b', 'top1', 'Pro', 50), r('c', 'top1', 'Pro', 50),
      r('d', 'mixed', 'Pro', 50), r('e', 'mixed', 'Amateur', 50),
      r('f', 'top2', 'Amateur', 50), r('g', 'top2', 'Amateur', 50), // only 2 at T1: no credit
    ];
    const s = computeQualitySignals({ reviews, tierOf }).get('mixed');
    assert.strictEqual(s.distinctCritics, 2);
    assert.strictEqual(s.crossoverCritics, 1);
    assert.strictEqual(s.crossoverShare, 0.5);
    // a critic's home T1 outlet does not count as crossover for itself
    assert.strictEqual(computeQualitySignals({ reviews, tierOf }).get('top1').crossoverShare, 0);
  });
});
