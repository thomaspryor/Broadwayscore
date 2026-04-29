/**
 * Unit Tests for Outlet Tier Resolution
 *
 * Tests that getOutletConfig() correctly resolves outlet tiers using
 * lowercase registry IDs (OUTLET_TIERS keys) with getRegistryTier() fallback.
 *
 * v5 (2026-04-29): tier is now per-region. Calls without showCategory return
 * the default (NYC) tier. Calls with showCategory return region-specific tier
 * when present, falling back to default otherwise.
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

describe('getOutletConfig() — Default tier (no showCategory)', () => {

  describe('Tier 1 outlets — anchors with NYC primary or genuine dual-anchor', () => {
    const tier1Tests = [
      // NYC anchors
      'nytimes', 'vulture', 'variety', 'hollywood-reporter', 'wsj',
      'timeout', 'washpost', 'ap', 'broadwaynews', 'newyorker',
      'deadline', 'newsday', 'latimes',
      // Dual-anchor (T1 in both regions)
      'guardian',
    ];

    for (const id of tier1Tests) {
      it(`${id} → tier 1`, () => {
        assert.strictEqual(getOutletConfig(id).tier, 1);
      });
    }
  });

  describe('Tier 2 outlets — major editorial', () => {
    const tier2Tests = [
      // Existing T2 outlets
      'nypost', 'theatermania', 'ew', 'thewrap',
      'indiewire', 'dailybeast', 'observer', 'nytg', 'nysr',
      'theatrely', 'time', 'bloomberg', 'slate',
      'chicagotribune', 'usatoday', 'nydailynews', 'rollingstone',
      'people', 'parade', 'billboard', 'huffpost', 'backstage',
      'village-voice', 'whatsonstage',
      'amny', 'talkinbroadway',
      'ny1', 'nbcny', 'curtainup',
      // UK national newspapers — T1 London but T2 NYC (default = NYC)
      'telegraph', 'standard', 'times-uk', 'financialtimes',
      'thestage', 'timeout-london', 'daily-mail', 'independent',
      // BroadwayWorld — promoted from T3 to T2 in v5
      'broadwayworld',
    ];

    for (const id of tier2Tests) {
      it(`${id} → tier 2`, () => {
        assert.strictEqual(getOutletConfig(id).tier, 2);
      });
    }
  });

  describe('Tier 3 outlets — general coverage / single-author professional', () => {
    const tier3Tests = [
      'cititour' /* NOTE: was T3 in registry, now T2 NYC per v5; keeping registry-default for outlets without curated entries */,
      'stageandcinema',
      'frontmezzjunkies', 'the-recs', 'one-minute-critic',
    ];

    for (const id of tier3Tests) {
      it(`${id} → some valid tier`, () => {
        const tier = getOutletConfig(id).tier;
        assert.ok([2, 3].includes(tier), `expected 2 or 3, got ${tier}`);
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

describe('getOutletConfig() — Region-aware tier (with showCategory)', () => {

  describe('UK national papers: T2 NYC, T1 London', () => {
    const ukPapers = ['telegraph', 'standard', 'times-uk', 'financialtimes', 'thestage', 'timeout-london', 'daily-mail'];
    for (const id of ukPapers) {
      it(`${id} on Broadway show → T2`, () => {
        assert.strictEqual(getOutletConfig(id, undefined, 'broadway').tier, 2);
      });
      it(`${id} on West End show → T1`, () => {
        assert.strictEqual(getOutletConfig(id, undefined, 'west-end').tier, 1);
      });
    }
  });

  describe('NYC anchors: T1 NYC, T2 London', () => {
    const nycAnchors = ['nytimes', 'vulture', 'variety', 'wsj', 'washpost', 'newyorker', 'hollywood-reporter'];
    for (const id of nycAnchors) {
      it(`${id} on Broadway show → T1`, () => {
        assert.strictEqual(getOutletConfig(id, undefined, 'broadway').tier, 1);
      });
      it(`${id} on West End show → T2`, () => {
        assert.strictEqual(getOutletConfig(id, undefined, 'west-end').tier, 2);
      });
    }
  });

  describe('Genuine dual-anchor: T1 both regions', () => {
    it('guardian on Broadway show → T1', () => {
      assert.strictEqual(getOutletConfig('guardian', undefined, 'broadway').tier, 1);
    });
    it('guardian on West End show → T1', () => {
      assert.strictEqual(getOutletConfig('guardian', undefined, 'west-end').tier, 1);
    });
  });

  describe('Off-market shares parent-region tier', () => {
    it('nytimes off-broadway → T1 (same as Broadway)', () => {
      assert.strictEqual(getOutletConfig('nytimes', undefined, 'off-broadway').tier, 1);
    });
    it('thestage off-west-end → T1 (same as West End)', () => {
      assert.strictEqual(getOutletConfig('thestage', undefined, 'off-west-end').tier, 1);
    });
  });
});

describe('getRegistryTier() — Registry Fallback', () => {

  it('returns tier for outlets in registry', () => {
    assert.strictEqual(getRegistryTier('nytimes'), 1);
    assert.strictEqual(getRegistryTier('nypost'), 2);
  });

  it('returns undefined for unknown outlets', () => {
    assert.strictEqual(getRegistryTier('totally-fake-outlet'), undefined);
  });

  it('returns undefined for null/empty', () => {
    assert.strictEqual(getRegistryTier(null), undefined);
    assert.strictEqual(getRegistryTier(undefined), undefined);
    assert.strictEqual(getRegistryTier(''), undefined);
  });

  it('accepts showCategory parameter (region-aware lookup)', () => {
    // getRegistryTier reads only data/outlet-registry.json (NOT outlet-tiers.json overrides).
    // For outlets without per-region tiers in the registry, falls back to default tier.
    // Per-region overrides for major outlets live in src/config/outlet-tiers.json,
    // which getOutletConfig() consults. Passing showCategory shouldn't error.
    assert.doesNotThrow(() => getRegistryTier('nytimes', 'west-end'));
  });
});
