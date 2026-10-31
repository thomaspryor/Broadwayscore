// BRO-5849: guesses fill model gaps but never count as disclosed facts.
// Real functions via require() (CLAUDE.md §15); real data for the counts.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const { makeCapEstimator, isDisclosedCapitalization, optsWithCapEstimate, MIN_AVERAGE_SAMPLE } = require('../../scripts/lib/cap-comparables');
const { decidedByGuess, canResizeByModel } = require('../../scripts/lib/model-input-basis');

const mkShow = (id, year, extra = {}) => ({ id, slug: id, type: 'musical', isRevival: false, openingDate: `${year}-10-15`, ...extra });

describe('selection and fallback (fixtures)', () => {
  const shows = [];
  const comm = {};
  for (let i = 0; i < 4; i++) { shows.push(mkShow(`d${i}`, 2015 + (i % 2))); comm[`d${i}`] = { capitalization: (10 + i) * 1e6 }; }
  // Estimated and ceiling-style figures must not feed the pool.
  shows.push(mkShow('est', 2015)); comm.est = { capitalization: 99e6, isEstimate: { capitalization: true } };
  shows.push(mkShow('target', 2015)); comm.target = {};
  const estimator = makeCapEstimator(shows, comm);

  it('a record with no capitalization gets a comparables figure from disclosed shows only', () => {
    const e = estimator(shows.find((s) => s.id === 'target'), comm.target);
    assert.ok(e && e.n >= MIN_AVERAGE_SAMPLE);
    assert.ok(e.value <= 13e6, `estimate ${e.value} must ignore the $99M estimated figure`);
  });

  it('optsWithCapEstimate fills only a record without its own figure', () => {
    const opts = { capComparables: true, capEstimator: estimator };
    assert.ok(optsWithCapEstimate(opts, shows[5], comm.target).capEstimate);
    assert.strictEqual(optsWithCapEstimate(opts, shows[0], comm.d0), opts);
    assert.strictEqual(optsWithCapEstimate({}, shows[5], comm.target).capEstimate, undefined);
  });

  it('a comparables or estimate basis marks a guess and blocks model loss resizes', () => {
    assert.strictEqual(decidedByGuess({ modelInputBasis: [{ input: 'capitalization', basis: 'comparables' }] }), true);
    assert.strictEqual(canResizeByModel({ modelInputBasis: [{ input: 'capitalization', basis: 'comparables' }] }), false);
    assert.strictEqual(decidedByGuess({ modelInputBasis: [{ input: 'capitalization', basis: 'ceiling' }] }), false);
  });
});

describe('real data: disclosed counts ignore estimates', () => {
  const file = path.join(ROOT, 'data', 'commercial.json');
  const entries = Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')).shows || {});

  it('no disclosed capitalization is flagged an estimate', () => {
    const bad = entries.filter(([, c]) => isDisclosedCapitalization(c) && c.isEstimate?.capitalization === true);
    assert.deepStrictEqual(bad.map(([k]) => k), []);
  });

  it('a stored comparables figure never sits on a record that also has a capitalization', () => {
    const bad = entries.filter(([, c]) => c.modelCapitalizationEstimate && c.capitalization);
    assert.deepStrictEqual(bad.map(([k]) => k), []);
  });

  it('reports the counts (ai-estimated is reported, not gated)', () => {
    const disclosed = entries.filter(([, c]) => isDisclosedCapitalization(c)).length;
    const aiEstimated = entries.filter(([, c]) => c.modelMethod === 'ai-estimated').length;
    console.log(`# commercial records ${entries.length}, disclosed capitalization ${disclosed}, ai-estimated ${aiEstimated}`);
    assert.ok(disclosed > 0 && disclosed <= entries.length);
  });
});
