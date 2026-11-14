// BRO-5677: opts.capMaxHaircut scales a Form D offering ceiling ('maximum'
// capitalization) to a typical actual raise. Shadow only: the timing backtest
// got worse for plays with it on. Tests the real modules (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CAP_MAX_HAIRCUT, MIN_PAIRS, ceilingFromText, raiseCeilingPair, fitCapMaxHaircut, haircutCapitalization } = require('./cap-max-haircut.js');
const { calculateRecoupment, MUSICAL_LIVE_OPTS, PLAY_LIVE_OPTS } = require('./recoupment-model.js');

test('reads the offering ceiling from Form D wording', () => {
  assert.equal(ceilingFromText('SEC Form D/A: total offering amount $7,500,000 ($7,000,000 sold by then).'), 7_500_000);
  assert.equal(ceilingFromText('$20,000,000 sold of a $23,000,000 offering'), 23_000_000);
  assert.equal(ceilingFromText('"Maximum capitalization was $6,000,000/Minimum capitalization was $4,000,000"'), 6_000_000);
  assert.equal(ceilingFromText('Its SEC Form D allowed an offering of up to $3,500,000.'), 3_500_000);
  assert.equal(ceilingFromText('Variety: the show cost $12 million'), null);
  assert.equal(ceilingFromText(null), null);
});

test('pairs a raise with its ceiling', () => {
  assert.deepEqual(raiseCeilingPair({ capitalization: 14_500_000, capitalizationBasis: 'maximum', capitalActual: 11_600_000 }), { raised: 11_600_000, ceiling: 14_500_000, ratio: 0.8 });
  const sold = raiseCeilingPair({ capitalization: 5_400_000, capitalizationBasis: 'sold', capitalizationSource: 'total offering amount $6,000,000 ($5,400,000 sold by then)' });
  assert.equal(sold.ratio, 0.9);
  assert.equal(raiseCeilingPair({ capitalization: 15e6, capitalizationBasis: 'sold', capitalizationSource: 'SEC Form D/A: $15M, fully sold' }).ratio, 1);
});

test('no pair without both numbers, or with a raise above the ceiling', () => {
  assert.equal(raiseCeilingPair({ capitalization: 9e6, capitalizationBasis: 'maximum' }), null);
  assert.equal(raiseCeilingPair({ capitalization: 9e6, capitalizationBasis: 'sold', capitalizationSource: '$9M sold to 40 investors' }), null);
  assert.equal(raiseCeilingPair({ capitalization: 9e6, capitalizationBasis: 'sold', capitalizationSource: 'total offering amount $8,000,000' }), null);
  assert.equal(raiseCeilingPair({ capitalization: 9e6 }), null);
  assert.equal(raiseCeilingPair(null), null);
});

test('fit is the median ratio, and refuses a thin sample', () => {
  const rec = (ratio) => ({ capitalization: ratio * 10e6, capitalizationBasis: 'sold', capitalizationSource: 'total offering amount $10,000,000' });
  const few = Object.fromEntries(Array.from({ length: MIN_PAIRS - 1 }, (_, i) => [`s${i}`, rec(0.9)]));
  assert.equal(fitCapMaxHaircut(few).factor, null);
  assert.equal(fitCapMaxHaircut(few).n, MIN_PAIRS - 1);
  const ratios = [0.7, 0.8, 0.9, 0.92, 0.94, 0.96, 1, 1];
  const fit = fitCapMaxHaircut(Object.fromEntries(ratios.map((r, i) => [`s${i}`, rec(r)])));
  assert.equal(fit.n, 8);
  assert.ok(Math.abs(fit.factor - 0.93) < 1e-9, `factor ${fit.factor}`);
  assert.equal(fitCapMaxHaircut({}).factor, null);
});

test('haircut touches only a ceiling, and only when asked', () => {
  const max = { capitalization: 10e6, capitalizationBasis: 'maximum' };
  assert.deepEqual(haircutCapitalization(max, true), { capitalization: 10e6 * CAP_MAX_HAIRCUT, factor: CAP_MAX_HAIRCUT });
  assert.equal(haircutCapitalization(max, 0.8).capitalization, 8e6);
  for (const off of [undefined, false, 0, 1.5, -1, 'yes']) assert.deepEqual(haircutCapitalization(max, off), { capitalization: 10e6, factor: null });
  assert.equal(haircutCapitalization({ capitalization: 10e6, capitalizationBasis: 'sold' }, true).capitalization, 10e6);
  assert.equal(haircutCapitalization({ capitalization: 10e6 }, true).capitalization, 10e6);
  // Untagged record whose wording says it is a ceiling.
  assert.equal(haircutCapitalization({ capitalization: 10e6, capitalizationSource: 'capitalized for up to $10 million' }, true).factor, CAP_MAX_HAIRCUT);
  assert.equal(haircutCapitalization({ capitalization: null, capitalizationBasis: 'maximum' }, true).capitalization, null);
});

test('the default factor is a plausible haircut', () => {
  assert.ok(CAP_MAX_HAIRCUT > 0.7 && CAP_MAX_HAIRCUT <= 1, `${CAP_MAX_HAIRCUT}`);
});

test('shadow only: not live for musicals or plays', () => {
  assert.equal('capMaxHaircut' in MUSICAL_LIVE_OPTS, false);
  assert.equal('capMaxHaircut' in PLAY_LIVE_OPTS, false);
});

const weekly = {};
for (let i = 0; i < 40; i++) weekly[new Date(Date.UTC(2017, 0, 1 + 7 * i)).toISOString().slice(0, 10)] = { gross: 1_400_000 };
const show = { slug: 'cap-max-fixture', type: 'musical', previewsStartDate: '2016-12-20', openingDate: '2017-01-10', closingDate: '2017-10-01' };

test('model: off by default, so a ceiling record is unchanged', () => {
  const comm = { capitalization: 12e6, capitalizationBasis: 'maximum' };
  assert.deepEqual(calculateRecoupment(show, comm, null, weekly), calculateRecoupment(show, comm, null, weekly, { capMaxHaircut: false }));
});

test('model: the haircut lowers the cap and raises recoupment %, with a warning', () => {
  const comm = { capitalization: 12e6, capitalizationBasis: 'maximum' };
  const off = calculateRecoupment(show, comm, null, weekly);
  const on = calculateRecoupment(show, comm, null, weekly, { capMaxHaircut: true });
  assert.ok(!off.error && !on.error, `${off.error || on.error}`);
  assert.equal(on.capitalization, 12e6 * CAP_MAX_HAIRCUT);
  assert.ok(on.recoupmentPctCentral > off.recoupmentPctCentral, `${on.recoupmentPctCentral} vs ${off.recoupmentPctCentral}`);
  assert.ok(on.warnings.some((w) => /offering ceiling/.test(w)), on.warnings.join(' | '));
  assert.ok(!off.warnings.some((w) => /offering ceiling/.test(w)));
});

test('model: a sold or untagged cap ignores the option', () => {
  for (const comm of [{ capitalization: 12e6, capitalizationBasis: 'sold' }, { capitalization: 12e6 }]) {
    assert.deepEqual(calculateRecoupment(show, comm, null, weekly, { capMaxHaircut: true }), calculateRecoupment(show, comm, null, weekly));
  }
});
