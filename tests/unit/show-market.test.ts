import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isOperaShow,
  getEffectiveMarket,
  getEffectiveMarketLabel,
  getOperaDurationSuffix,
  OPERA_DURATION_SUFFIX,
  OPERA_MARKET_LABEL,
} from '../../src/lib/show-market';

test('isOperaShow recognizes type: opera', () => {
  assert.equal(isOperaShow({ type: 'opera' }), true);
  assert.equal(isOperaShow({ type: 'opera', category: 'off-broadway' }), true);
});

test('isOperaShow rejects non-opera types', () => {
  assert.equal(isOperaShow({ type: 'musical' }), false);
  assert.equal(isOperaShow({ type: 'play' }), false);
  assert.equal(isOperaShow({ type: 'special' }), false);
  assert.equal(isOperaShow({}), false);
  assert.equal(isOperaShow(null), false);
  assert.equal(isOperaShow(undefined), false);
});

test('getEffectiveMarket collapses opera to first-class market', () => {
  assert.equal(getEffectiveMarket({ type: 'opera', category: 'off-broadway' }), 'opera');
});

test('getEffectiveMarket returns category for non-opera shows', () => {
  assert.equal(getEffectiveMarket({ type: 'musical', category: 'broadway' }), 'broadway');
  assert.equal(getEffectiveMarket({ type: 'play', category: 'off-broadway' }), 'off-broadway');
  assert.equal(getEffectiveMarket({ type: 'musical', category: 'west-end' }), 'west-end');
  assert.equal(getEffectiveMarket({ type: 'play', category: 'off-west-end' }), 'off-west-end');
});

test('getEffectiveMarket defaults to broadway when category missing', () => {
  assert.equal(getEffectiveMarket({ type: 'musical' }), 'broadway');
  assert.equal(getEffectiveMarket({}), 'broadway');
  assert.equal(getEffectiveMarket(null), 'broadway');
});

test('getEffectiveMarketLabel renders human-readable labels', () => {
  assert.equal(getEffectiveMarketLabel({ type: 'opera' }), 'Met Opera');
  assert.equal(getEffectiveMarketLabel({ type: 'musical', category: 'broadway' }), 'Broadway');
  assert.equal(getEffectiveMarketLabel({ type: 'play', category: 'off-broadway' }), 'Off-Broadway');
  assert.equal(getEffectiveMarketLabel({ type: 'musical', category: 'west-end' }), 'West End');
  assert.equal(getEffectiveMarketLabel({ type: 'play', category: 'off-west-end' }), 'Off-West End');
});

test('getOperaDurationSuffix returns "at the Met" only for opera', () => {
  assert.equal(getOperaDurationSuffix({ type: 'opera' }), OPERA_DURATION_SUFFIX);
  assert.equal(getOperaDurationSuffix({ type: 'opera' }), 'at the Met');
  assert.equal(getOperaDurationSuffix({ type: 'musical' }), null);
  assert.equal(getOperaDurationSuffix({ type: 'play', category: 'off-broadway' }), null);
  assert.equal(getOperaDurationSuffix(null), null);
});

test('constants are exported correctly', () => {
  assert.equal(OPERA_DURATION_SUFFIX, 'at the Met');
  assert.equal(OPERA_MARKET_LABEL, 'Met Opera');
});

test('Royal Opera House shows get house-aware labels (BRO-6766)', async () => {
  const m = await import('../../src/lib/show-market');
  const roh = { type: 'opera', venue: 'Royal Opera House', category: 'off-west-end' };
  const met = { type: 'opera', venue: 'Metropolitan Opera House', category: 'off-broadway' };
  assert.equal(m.getOperaMarketLabel(roh), 'Royal Opera House');
  assert.equal(m.getOperaMarketLabel(met), 'Met Opera');
  assert.equal(m.getOperaDurationSuffix(roh), 'at the Royal Opera House');
  assert.equal(m.getOperaDurationSuffix(met), 'at the Met');
  assert.equal(m.getOperaDurationSuffix({ type: 'musical', venue: 'Royal Opera House' }), null);
  assert.equal(m.getEffectiveMarketLabel(roh), 'Royal Opera House');
  assert.equal(m.isRoyalOperaVenue('Royal Ballet and Opera'), true);
  assert.equal(m.isRoyalOperaVenue('Metropolitan Opera House'), false);
});
