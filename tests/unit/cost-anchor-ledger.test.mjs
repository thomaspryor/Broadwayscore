import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateLedger, evaluateLedger, loadLedger, MIN_PAIRS_PER_ERA } = require('../../scripts/lib/cost-anchor-ledger');
const { carry } = require('../../scripts/lib/cost-for-week');

// All decision logic comes from the production module. Synthetic records here
// exercise rejection and coverage boundaries, never masquerade as research.
const fixture = (overrides = {}) => ({
  show: 'synthetic-production', era: '2010-2019', kind: 'running-cost', currency: 'USD', costBasis: 'fixed expenses',
  asOfA: '2016-01-01', amountA: 500000,
  sourceA: { url: 'https://playbill.com/article/synthetic-a', sourceType: 'trade', publisher: 'Synthetic trade',
    reportedAt: '2016-01-02', dateBasis: 'reported-current', note: 'Synthetic contemporaneous fixed expenses.' },
  asOfB: '2017-01-01', amountB: 520000,
  sourceB: { url: 'https://playbill.com/article/synthetic-b', sourceType: 'trade', publisher: 'Synthetic trade',
    reportedAt: '2017-01-02', dateBasis: 'reported-current', note: 'Synthetic later fixed expenses.' },
  ...overrides,
});

describe('BRO-5018 cost-anchor ledger', () => {
  it('validates the real ledger shape and both sources of every pair', (t) => {
    const ledger = loadLedger();
    assert.deepEqual(validateLedger(ledger), []);
    assert.ok(ledger.pairs.length > 0, 'retain the researched evidence');
    const report = evaluateLedger(ledger);
    for (const [era, row] of Object.entries(report.byEra)) {
      t.diagnostic(`${era}: ${row.pairs}/${MIN_PAIRS_PER_ERA}, missing ${row.missing}; median absolute error ${row.medianAbsError}`);
    }
    t.diagnostic(`coverageReady=${report.coverageReady}; schema validity is not completion of BRO-5018`);
  });

  it('holds out the later real figure and uses the same carry function as costForWeek', () => {
    const ledger = loadLedger();
    const report = evaluateLedger(ledger);
    for (const [i, row] of report.pairs.entries()) {
      const pair = ledger.pairs[i];
      assert.equal(row.predicted, Math.round(carry(pair.amountA, pair.asOfA, pair.asOfB)));
      assert.equal(row.error, carry(pair.amountA, pair.asOfA, pair.asOfB) / pair.amountB - 1);
    }
    assert.equal(ledger.pairs.find((p) => p.show === 'hamilton').sourceB.reportedAt, '2018-04-25');
    assert.equal(ledger.pairs.find((p) => p.show === 'hamilton').asOfB, '2017-01-31');
    assert.equal(ledger.pairs.find((p) => p.show === 'good-night-and-good-luck-2025').asOfB, '2025-06-08');
  });

  it('rejects nonqualifying tiers, relabeled forums and malformed URLs on either side', () => {
    for (const side of ['A', 'B']) {
      for (const sourceType of ['reddit-standard', 'industry-estimate', 'gpt', undefined]) {
        const pair = fixture();
        pair[`source${side}`].sourceType = sourceType;
        assert.match(validateLedger({ pairs: [pair] }).join('\n'), /sourceType/);
      }
      for (const url of ['https://reddit.com/r/Broadway', 'https://forum.broadwayworld.com/thread/synthetic', 'javascript:alert(1)', '/article', 'https://user:password@playbill.com/article']) {
        const pair = fixture();
        pair[`source${side}`].url = url;
        assert.ok(validateLedger({ pairs: [pair] }).length, url);
      }
    }
  });

  it('requires SEC provenance and named producer confirmation', () => {
    const pair = fixture();
    pair.sourceA.sourceType = 'sec';
    assert.match(validateLedger({ pairs: [pair] }).join('\n'), /sec.gov/);
    pair.sourceA.url = 'https://www.sec.gov/Archives/synthetic.xml';
    pair.sourceB.sourceType = 'producer-confirmed';
    assert.match(validateLedger({ pairs: [pair] }).join('\n'), /confirmedBy/);
    pair.sourceB.confirmedBy = 'Synthetic producer';
    assert.deepEqual(validateLedger({ pairs: [pair] }), []);
  });

  it('rejects bad dates, reversed pairs, bounds, mixed kinds and nonfinite amounts', () => {
    for (const patch of [
      { asOfA: '2016-02-30' }, { asOfB: '2015-01-01' }, { asOfB: '2016-01-01' },
      { asOfA: '2016' }, { asOfA: '2016-02-01' }, // later than its source publication
      { era: '2020+' }, { kind: 'break-even' }, { currency: 'GBP' }, { costBasis: '' },
      { boundA: 'min' }, { boundB: 'min' }, { amountA: Infinity }, { amountB: 0 },
      { amountA: '500000' }, { amountB: NaN }, { sourceA: null },
    ]) assert.ok(validateLedger({ pairs: [fixture(patch)] }).length, JSON.stringify(patch));
    assert.ok(validateLedger(null).length);
    assert.ok(validateLedger({ pairs: [null] }).length);
  });

  it('rejects duplicate pairs even when a second citation is supplied', () => {
    const a = fixture();
    const b = fixture();
    b.sourceB.url = 'https://playbill.com/article/another-citation';
    assert.match(validateLedger({ pairs: [a, b] }).join('\n'), /duplicate/);
    assert.throws(() => evaluateLedger({ pairs: [a, b] }), /Invalid cost-anchor ledger/);
  });

  it('requires ten pairs in EACH era, not thirty in aggregate', () => {
    const modern = Array.from({ length: 30 }, (_, i) => fixture({ show: `synthetic-${i}`, era: '2020+',
      asOfA: '2021-01-01', asOfB: '2022-01-01',
      sourceA: { ...fixture().sourceA, reportedAt: '2021-01-02' },
      sourceB: { ...fixture().sourceB, reportedAt: '2022-01-02' } }));
    const report = evaluateLedger({ pairs: modern });
    assert.equal(report.coverageReady, false);
    assert.equal(report.byEra['pre-2010'].missing, 10);
    assert.equal(report.byEra['2010-2019'].medianAbsError, null);
    const all = ['2008', '2016', '2021'].flatMap((year, era) => Array.from({ length: 10 }, (_, i) => fixture({
      show: `synthetic-${year}-${i}`, era: ['pre-2010', '2010-2019', '2020+'][era],
      asOfA: `${year}-01-01`, asOfB: `${year}-12-01`,
      sourceA: { ...fixture().sourceA, reportedAt: `${year}-01-02` },
      sourceB: { ...fixture().sourceB, reportedAt: `${year}-12-02` },
    })));
    assert.equal(evaluateLedger({ pairs: all }).coverageReady, true);
    assert.equal(evaluateLedger({ pairs: all }).indexPass, true);
    const poorIndexFit = all.map((pair) => pair.era === '2020+' ? { ...pair, amountB: pair.amountB * 2 } : pair);
    assert.equal(evaluateLedger({ pairs: poorIndexFit }).coverageReady, true);
    assert.equal(evaluateLedger({ pairs: poorIndexFit }).indexPass, false);
    assert.equal(evaluateLedger({ pairs: all.slice(1) }).coverageReady, false);
    assert.equal(evaluateLedger({ pairs: [] }).medianAbsError, null);
    assert.equal(evaluateLedger({ pairs: [] }).indexPass, false);
  });

  it('counts cross-era pairs once and keeps capitalization errors separate', () => {
    const crossing = fixture({ asOfA: '2009-12-31', era: 'pre-2010', kind: 'capitalization' });
    const report = evaluateLedger({ pairs: [crossing] });
    assert.equal(report.byEra['pre-2010'].pairs, 1);
    assert.equal(report.byEra['2010-2019'].pairs, 0);
    assert.equal(report.byEra['pre-2010'].byKind['running-cost'].medianAbsError, null);
    assert.ok(report.byEra['pre-2010'].byKind.capitalization.medianAbsError > 0);
  });
});
