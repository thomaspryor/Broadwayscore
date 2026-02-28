/**
 * Unit Tests for Outlet Tier Resolution
 *
 * Tests that getOutletConfig() correctly resolves outlet tiers using
 * lowercase registry IDs (OUTLET_TIERS keys) with getRegistryTier() fallback.
 *
 * Run with: npx tsx --test tests/unit/outlet-id-mapper.test.mjs
 * Or: node --import tsx --test tests/unit/outlet-id-mapper.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';

let getOutletConfig;
let getRegistryTier;

before(async () => {
  const engineModule = await import('../../src/lib/engine.ts');
  getOutletConfig = engineModule.getOutletConfig;

  const mapperModule = await import('../../src/lib/outlet-id-mapper.ts');
  getRegistryTier = mapperModule.getRegistryTier;
});

describe('getOutletConfig() — Tier Resolution', () => {

  describe('Tier 1 outlets return tier 1', () => {
    const tier1Tests = [
      'nytimes', 'vulture', 'variety', 'hollywood-reporter', 'wsj',
      'guardian', 'timeout', 'washpost', 'ap', 'latimes', 'broadwaynews',
      'newyorker', 'telegraph', 'standard', 'times-uk', 'daily-mail',
    ];

    for (const id of tier1Tests) {
      it(`${id} → tier 1`, () => {
        assert.strictEqual(getOutletConfig(id).tier, 1);
      });
    }
  });

  describe('Tier 2 outlets return tier 2', () => {
    const tier2Tests = [
      'nypost', 'theatermania', 'deadline', 'ew', 'thewrap',
      'indiewire', 'dailybeast', 'observer', 'nytg', 'nysr',
      'theatrely', 'newsday', 'time', 'bloomberg', 'slate',
      'chicagotribune', 'usatoday', 'nydailynews', 'rollingstone',
      'people', 'parade', 'billboard', 'huffpost', 'backstage',
      'village-voice', 'financialtimes', 'whatsonstage', 'thestage',
      'independent', 'timeout-london', 'amny', 'talkinbroadway',
      'ny1', 'nbcny', 'curtainup',
    ];

    for (const id of tier2Tests) {
      it(`${id} → tier 2`, () => {
        assert.strictEqual(getOutletConfig(id).tier, 2);
      });
    }
  });

  describe('Tier 3 outlets return tier 3', () => {
    const tier3Tests = [
      'broadwayworld', 'cititour', 'stageandcinema',
      'frontmezzjunkies', 'the-recs', 'one-minute-critic',
    ];

    for (const id of tier3Tests) {
      it(`${id} → tier 3`, () => {
        assert.strictEqual(getOutletConfig(id).tier, 3);
      });
    }
  });

  describe('Edge cases', () => {
    it('unknown outlets default to tier 3', () => {
      assert.strictEqual(getOutletConfig('unknown-outlet').tier, 3);
    });

    it('preserves original ID in returned config', () => {
      assert.strictEqual(getOutletConfig('nytimes').id, 'nytimes');
    });

    it('handles case-insensitive lookup', () => {
      assert.strictEqual(getOutletConfig('NYTIMES').tier, 1);
      assert.strictEqual(getOutletConfig('Vulture').tier, 1);
    });
  });
});

describe('getRegistryTier() — Registry Fallback', () => {

  it('returns tier for outlets in registry', () => {
    assert.strictEqual(getRegistryTier('nytimes'), 1);
    assert.strictEqual(getRegistryTier('nypost'), 2);
    assert.strictEqual(getRegistryTier('broadwayworld'), 3);
  });

  it('returns tier for outlets NOT in OUTLET_TIERS', () => {
    const tier = getRegistryTier('broadwayworld');
    assert.ok(tier !== undefined, 'broadwayworld should be in registry');
  });

  it('returns undefined for unknown outlets', () => {
    assert.strictEqual(getRegistryTier('totally-fake-outlet'), undefined);
  });

  it('returns undefined for null/empty', () => {
    assert.strictEqual(getRegistryTier(null), undefined);
    assert.strictEqual(getRegistryTier(undefined), undefined);
    assert.strictEqual(getRegistryTier(''), undefined);
  });
});
