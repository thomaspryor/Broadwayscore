// BRO-7944 class guard: a wrongProduction/wrongShow flag neutralised by a permanent
// human override must not count as "in effect" (497 files were hidden as 'invalid').
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isEffectivelyWrongProductionOrShow } = require('./content-quality');
const { retierStaleWrongContentTier } = require('./stale-wrong-content-tier');

const text = Array.from({ length: 400 }, (_, i) => `word${i}`).join(' ') + '.';
const base = () => ({ fullText: text, contentTier: 'invalid', contentTierReason: 'Wrong production', tierReason: 'Wrong production' });

test('every override field neutralises its flag', () => {
  assert.equal(isEffectivelyWrongProductionOrShow({ wrongProduction: true }).effectivelyWrongProduction, true);
  assert.equal(isEffectivelyWrongProductionOrShow({ wrongProduction: true, wrongProductionOverride: true }).effectivelyWrongProduction, false);
  assert.equal(isEffectivelyWrongProductionOrShow({ wrongShow: true }).effectivelyWrongShow, true);
  assert.equal(isEffectivelyWrongProductionOrShow({ wrongShow: true, wrongShowOverride: true }).effectivelyWrongShow, false);
});

test('retier lifts invalid when flag is still true but overridden', () => {
  const r = { ...base(), wrongProduction: true, wrongProductionOverride: true };
  assert.ok(retierStaleWrongContentTier(r).includes('contentTier'));
  assert.notEqual(r.contentTier, 'invalid');
});

test('retier lifts wrongShow + wrongShowOverride', () => {
  const r = { ...base(), contentTierReason: 'Wrong show', tierReason: 'Wrong show', wrongShow: true, wrongShowOverride: true };
  assert.ok(retierStaleWrongContentTier(r).length);
  assert.notEqual(r.contentTier, 'invalid');
});

test('retier still refuses a live flag with no override', () => {
  const r = { ...base(), wrongProduction: true };
  assert.deepEqual(retierStaleWrongContentTier(r), []);
  assert.equal(r.contentTier, 'invalid');
});
