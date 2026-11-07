// BRO-5849 step 3: comparables fallback for a missing capitalization.
// Real modules via require() (CLAUDE.md §15); real shows/grosses from data/.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const cc = require('../../scripts/lib/cap-comparables');
const { classifyTier } = require('../../scripts/lib/model-return-v2');
const { calculateRecoupment } = require('../../scripts/lib/recoupment-model');
const { modelInputBasis } = require('../../scripts/lib/model-input-basis');
const { liveModelRun } = require('../../scripts/lib/model-drift');
const { makeGrossesLookup } = require('../../scripts/lib/grosses-lookup');

const d = (year, capitalization, type = 'musical', isRevival = false) => ({ year, type, isRevival, capitalization });
const POOL = [d(2020, 10e6), d(2021, 12e6), d(2022, 14e6), d(2022, 16e6), d(2023, 30e6)];

describe('capitalizationComparable', () => {
  it('is the pool median, with P10 and P90 as its range', () => {
    const r = cc.capitalizationComparable(POOL, 2022, 'musical', false);
    assert.strictEqual(r.n, 5);
    assert.strictEqual(r.value, 14e6);
    assert.ok(r.low <= r.value && r.value <= r.high);
    assert.strictEqual(r.low, Math.round(cc.percentile([10e6, 12e6, 14e6, 16e6, 30e6], 0.1)));
  });

  it('needs three comparables of the same type, else null', () => {
    assert.strictEqual(cc.capitalizationComparable(POOL, 2022, 'play', false), null);
    assert.strictEqual(cc.capitalizationComparable(POOL.slice(0, 2), 2022, 'musical', false), null);
  });

  it('agrees with estimateCapitalization (the season totals use the same pool)', () => {
    assert.strictEqual(cc.estimateCapitalization(POOL, 2022, 'musical', false), 14e6);
  });
});

describe('isDisclosedCapitalization', () => {
  it('leaves out our own estimates and unfigured records', () => {
    assert.strictEqual(cc.isDisclosedCapitalization({ capitalization: 5e6 }), true);
    assert.strictEqual(cc.isDisclosedCapitalization({ capitalization: 5e6, isEstimate: { capitalization: true } }), false);
    assert.strictEqual(cc.isDisclosedCapitalization({ capitalization: 5e6, capitalizationSource: 'Estimate: inferred from Form D' }), false);
    assert.strictEqual(cc.isDisclosedCapitalization({}), false);
  });
});

describe('optsWithCapEstimate', () => {
  const est = { value: 9e6, low: 5e6, high: 14e6, n: 6 };
  const opts = { capComparables: true, capEstimator: () => est };
  it('adds the estimate only for a record with no capitalization and the opt on', () => {
    assert.deepStrictEqual(cc.optsWithCapEstimate(opts, {}, {}).capEstimate, est);
    assert.strictEqual(cc.optsWithCapEstimate(opts, {}, { capitalization: 1e6 }).capEstimate, undefined);
    assert.strictEqual(cc.optsWithCapEstimate({ capEstimator: () => est }, {}, {}).capEstimate, undefined);
    assert.strictEqual(cc.optsWithCapEstimate({}, {}, {}).capEstimate, undefined);
  });
});

describe('model fallback on real shows', () => {
  const D = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', f), 'utf8'));
  const shows = Object.values(D('shows.json').shows);
  const commercial = D('commercial.json').shows;
  const L = makeGrossesLookup(D('grosses.json'), D('grosses-history.json'));
  const by = {};
  for (const s of shows) { if (s.slug) by[s.slug] = s; if (s.id) by[s.id] = s; }
  const est = { value: 8e6, low: 4e6, high: 12e6, n: 7 };
  // Real records with no capitalization and a grosses history (the data copy varies; need a few).
  const targets = Object.entries(commercial)
    .map(([k, c]) => [by[k] || by[c.slug], c])
    .filter(([s, c]) => s && !c.capitalization && L.getGrossesAllTime(s.slug || s.id, s.id) && s.openingDate)
    .slice(0, 3);

  it('has real no-capitalization records to test on', () => { assert.ok(targets.length >= 1); });

  it('classifyTier: without an estimate ai-estimated, with one a model tier', () => {
    for (const [s, c] of targets) {
      const all = L.getGrossesAllTime(s.slug || s.id, s.id);
      assert.strictEqual(classifyTier(s, c, all), 'ai-estimated');
      assert.notStrictEqual(classifyTier(s, c, all, { capEstimate: est }), 'ai-estimated');
    }
  });

  it('runs on the estimate, labels it, caps quality below high, and never touches the record', () => {
    for (const [s, c] of targets) {
      const before = JSON.stringify(c);
      const all = L.getGrossesAllTime(s.slug || s.id, s.id);
      const r = calculateRecoupment(s, c, all, L.getWeeklyData(s.slug || s.id, s.id), { capEstimate: est });
      if (r.error) continue; // e.g. a split-run record
      assert.strictEqual(r.capitalization, est.value);
      assert.deepStrictEqual(r.capitalizationEstimate, est);
      assert.notStrictEqual(r.dataQuality, 'high', 'a guessed cap never earns high');
      assert.ok(r.warnings[0].includes('comparables estimate'));
      assert.ok(modelInputBasis(c, r).some((e) => e.input === 'capitalization' && e.basis === 'comparables'));
      assert.strictEqual(JSON.stringify(c), before, 'record is not modified');
    }
  });

  it('a comparables run that also rests on another guess is low (hidden by the display floor)', () => {
    for (const [s, c] of targets) {
      const all = L.getGrossesAllTime(s.slug || s.id, s.id);
      const r = calculateRecoupment(s, c, all, L.getWeeklyData(s.slug || s.id, s.id), { capEstimate: est });
      if (r.error) continue;
      const stacked = modelInputBasis(c, r).some((e) => e.input !== 'capitalization');
      if (stacked) assert.strictEqual(r.dataQuality, 'low', 'two guesses never display');
    }
  });

  it('a record with its own capitalization ignores the estimate', () => {
    const [k, c] = Object.entries(commercial).find(([key, v]) => v.capitalization && by[key] && L.getGrossesAllTime(by[key].slug || by[key].id, by[key].id));
    const s = by[k];
    const all = L.getGrossesAllTime(s.slug || s.id, s.id);
    const weekly = L.getWeeklyData(s.slug || s.id, s.id);
    const a = calculateRecoupment(s, c, all, weekly, {});
    const b = calculateRecoupment(s, c, all, weekly, { capEstimate: est });
    assert.strictEqual(b.capitalizationEstimate, undefined);
    assert.deepStrictEqual(b.recoupmentPctCentral, a.recoupmentPctCentral);
  });

  it('liveModelRun stays ai-estimated unless capComparables is on', () => {
    const [s, c] = targets[0];
    assert.strictEqual(liveModelRun(s, c, L, { capEstimator: () => est }).tier, 'ai-estimated');
    assert.notStrictEqual(liveModelRun(s, c, L, { capComparables: true, capEstimator: () => est }).tier, 'ai-estimated');
  });

  it('makeCapEstimator pools disclosed commercial figures only', () => {
    const f = cc.makeCapEstimator(shows, commercial);
    const [s, c] = targets[0];
    const e = f(s, c);
    if (e) { assert.ok(e.n >= 3 && e.low <= e.value && e.value <= e.high); }
  });
});

describe('leave-one-out backtest (advisory)', () => {
  it('runs on real data and reports estimate accuracy and the model effect', () => {
    const out = JSON.parse(execFileSync('node', ['scripts/backtest-cap-comparables.js', '--json'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 24 }));
    assert.ok(out.capSummary.n >= 20, `needs real rows, got ${out.capSummary.n}`);
    assert.ok(out.capSummary.within2x >= out.capSummary.within25pct);
    assert.ok(out.pctSummary.all.n > 0);
    assert.ok(Number.isInteger(out.flips));
  });
});
