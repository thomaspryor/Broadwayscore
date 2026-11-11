/**
 * BRO-7369 A, B, C-gap: earlier-production critic inputs. require()s the real modules.
 * Run: node --test tests/unit/review-forecast-v2-earlier-critics.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RF = require('../../scripts/lib/review-forecast.js');
const EC = require('../../scripts/lib/review-forecast-v2-earlier-critics.js');

const target = { id: 'T', title: 'Hadestown', category: 'broadway', openingDate: '2019-04-17', previewsStartDate: '2019-03-22' };
const prior = { id: 'P', title: 'Hadestown', category: 'off-broadway', openingDate: '2016-07-01', score: 80, rc: 15 };
const day = (s) => RF.toDay(s);
const rv = (d, score, w = 0.8, t1 = false) => ({ day: day(d), score, w, t1 });
const ctx = (extra = {}) => ({ pool: [prior], reviewsByShow: new Map([['P', [rv('2016-07-05', 90, 0.8, true), rv('2016-07-06', 70, 0.48, false)]]]), earlierAudience: {}, ...extra });

test('earlier production: only off-Broadway / West End markets, opened by the cutoff, latest wins', () => {
  assert.equal(EC.findEarlier(target, ctx(), '2019-03-21').id, 'P');
  assert.equal(EC.findEarlier(target, { pool: [{ ...prior, category: 'regional' }] }, '2019-03-21'), null);
  assert.equal(EC.findEarlier(target, { pool: [{ ...prior, openingDate: '2019-03-22' }] }, '2019-03-21'), null, 'opened on the first preview day or later is not earlier');
  const newer = { ...prior, id: 'Q', openingDate: '2017-05-01' };
  assert.equal(EC.findEarlier(target, { pool: [prior, newer] }, '2019-03-21').id, 'Q');
});

test('features: count-shrunk gap, tier-weighted and T1-only gaps, audience-minus-critics gap', () => {
  const f = EC.buildEarlierCriticsFeatures(target, ctx({ earlierAudience: { T: { n: 90, mean: 91.5, newest: '2019-01-01' } } }), 70);
  assert.equal(f.x.ecHas, 1);
  assert.ok(Math.abs(f.x.ecGap - (15 / 20) * 10) < 1e-9);
  const wMean = (0.8 * 90 + 0.48 * 70) / 1.28;
  assert.ok(Math.abs(f.x.ecWGap - (2 / 7) * (wMean - 70)) < 1e-9);
  assert.equal(f.x.ecT1Has, 1); assert.ok(Math.abs(f.x.ecT1Gap - (1 / 6) * 20) < 1e-9);
  assert.equal(f.x.eaGapHas, 1); assert.ok(Math.abs(f.x.eaCritGap - ((90 * 91.5 + 850) / 100 - 80)) < 1e-9);
  const none = EC.buildEarlierCriticsFeatures(target, { pool: [], reviewsByShow: new Map() }, 70);
  assert.ok(EC.EC_FEATURE_NAMES.every((k) => none.x[k] === 0)); assert.equal(none.has.earlierCritics, false);
});

test('reviews dated after the cutoff never feed the target (perturbation)', () => {
  const base = EC.buildEarlierCriticsFeatures(target, ctx(), 70);
  const noisy = ctx(); noisy.reviewsByShow.get('P').push(rv('2019-03-22', 1, 9, true), rv('2019-04-30', 1, 9, true));
  assert.deepEqual(EC.buildEarlierCriticsFeatures(target, noisy, 70).x, base.x);
});

test('leakage guard: red on a late or undated source, green on a valid one', () => {
  const ok = EC.buildEarlierCriticsFeatures(target, ctx(), 70);
  assert.equal(EC.assertNoLeakageEarlierCritics(target, ok.provenance), true);
  for (const d of ['2019-03-22', '2019-05-01', null, 'junk']) {
    assert.throws(() => EC.assertNoLeakageEarlierCritics(target, [{ kind: 'earlier-critics', ref: 'P', date: d }]), /LEAKAGE\(earlier-critics\)/, `${d} must throw`);
  }
});
