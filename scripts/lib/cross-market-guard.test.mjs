import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classifyReverseCrossMarket } = require('./cross-market-guard.js');

test('isDualMarket outlet is always skipped (legit by definition)', () => {
  // guardian/FT/telegraph: London Tier 1 but isDualMarket — must not flag on Broadway.
  assert.equal(
    classifyReverseCrossMarket({ region: 'london', isDualMarket: true, isTier12: true, isBroadway: true }).level,
    'skip'
  );
  assert.equal(
    classifyReverseCrossMarket({ region: 'london', isDualMarket: true, isTier12: false, isBroadway: false }).level,
    'skip'
  );
});

test('non-London outlet is skipped regardless of category/tier', () => {
  assert.equal(
    classifyReverseCrossMarket({ region: 'us', isDualMarket: false, isTier12: false, isBroadway: true }).level,
    'skip'
  );
  assert.equal(
    classifyReverseCrossMarket({ region: null, isDualMarket: false, isTier12: true, isBroadway: true }).level,
    'skip'
  );
});

test('Tier 3 London outlet on Broadway is ADVISORY, not error (the plays-to-see / Arts Desk class)', () => {
  // This is the regression that matters: pre-2026-06-15 this returned a hard error
  // and turned CI red. It must now be advisory so it does not block the build.
  const v = classifyReverseCrossMarket({ region: 'london', isDualMarket: false, isTier12: false, isBroadway: true });
  assert.equal(v.level, 'advisory');
  assert.match(v.reason, /isDualMarket candidate/);
});

test('untiered London outlet on Broadway is advisory (isTier12 false covers tier null)', () => {
  assert.equal(
    classifyReverseCrossMarket({ region: 'london', isDualMarket: false, isTier12: false, isBroadway: true }).level,
    'advisory'
  );
});

test('Tier 1/2 London prestige outlet on Broadway is a hard ERROR (genuine contamination)', () => {
  // Evening Standard / Times UK never legitimately cover mainstage Broadway.
  const v = classifyReverseCrossMarket({ region: 'london', isDualMarket: false, isTier12: true, isBroadway: true });
  assert.equal(v.level, 'error');
});

test('London outlet on off-Broadway/other is a tolerated WARNING (opera transmissions, transfers)', () => {
  // The Arts Desk reviewing a Met opera cinema transmission (off-Broadway category).
  assert.equal(
    classifyReverseCrossMarket({ region: 'london', isDualMarket: false, isTier12: false, isBroadway: false }).level,
    'warning'
  );
  // Even a Tier 1/2 London outlet on off-Broadway is only a warning, not an error.
  assert.equal(
    classifyReverseCrossMarket({ region: 'london', isDualMarket: false, isTier12: true, isBroadway: false }).level,
    'warning'
  );
});
