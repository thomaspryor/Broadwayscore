/**
 * Unit Tests for Outlet ID Mapper
 *
 * Tests the bidirectional mapping between:
 * - Registry format (lowercase): nytimes, vulture, variety
 * - Scoring format (uppercase): NYT, VULT, VARIETY
 *
 * This mapping is critical for the scoring engine to correctly
 * identify outlet tiers. Without it, Tier 1 outlets would
 * incorrectly default to Tier 3.
 *
 * Run with: npx tsx --test tests/unit/outlet-id-mapper.test.mjs
 * Or: node --import tsx --test tests/unit/outlet-id-mapper.test.mjs
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert';

// We need to register tsx to import TypeScript files
// Import the mapper directly from the TypeScript source
let toScoringId;
let toRegistryId;
let isKnownOutlet;
let REGISTRY_TO_SCORING;
let REGISTRY_ALIASES_TO_SCORING;
let SCORING_TO_REGISTRY;
let getOutletConfig;

// Use dynamic import with tsx loader
before(async () => {
  // Import outlet-id-mapper TypeScript module
  const mapperModule = await import('../../src/lib/outlet-id-mapper.ts');
  toScoringId = mapperModule.toScoringId;
  toRegistryId = mapperModule.toRegistryId;
  isKnownOutlet = mapperModule.isKnownOutlet;
  REGISTRY_TO_SCORING = mapperModule.REGISTRY_TO_SCORING;
  REGISTRY_ALIASES_TO_SCORING = mapperModule.REGISTRY_ALIASES_TO_SCORING;
  SCORING_TO_REGISTRY = mapperModule.SCORING_TO_REGISTRY;

  // Import engine TypeScript module
  const engineModule = await import('../../src/lib/engine.ts');
  getOutletConfig = engineModule.getOutletConfig;
});

describe('Outlet ID Mapper', () => {

  describe('toScoringId - Tier 1 outlets', () => {
    const tier1Outlets = [
      { registry: 'nytimes', scoring: 'NYT' },
      { registry: 'washpost', scoring: 'WASHPOST' },
      { registry: 'latimes', scoring: 'LATIMES' },
      { registry: 'wsj', scoring: 'WSJ' },
      { registry: 'ap', scoring: 'AP' },
      { registry: 'variety', scoring: 'VARIETY' },
      { registry: 'hollywood-reporter', scoring: 'THR' },
      { registry: 'vulture', scoring: 'VULT' },
      { registry: 'guardian', scoring: 'GUARDIAN' },
      { registry: 'timeout', scoring: 'TIMEOUTNY' },
      { registry: 'broadwaynews', scoring: 'BWAYNEWS' },
    ];

    for (const { registry, scoring } of tier1Outlets) {
      it(`maps ${registry} -> ${scoring}`, () => {
        assert.strictEqual(toScoringId(registry), scoring);
      });
    }

    it('maps all 11 tier 1 outlets correctly', () => {
      const results = tier1Outlets.map(({ registry }) => toScoringId(registry));
      const allValid = results.every(r => r !== undefined);
      assert.strictEqual(allValid, true, 'All tier 1 outlets should map successfully');
    });
  });

  describe('toScoringId - Tier 2 outlets', () => {
    const tier2Outlets = [
      { registry: 'chicagotribune', scoring: 'CHTRIB' },
      { registry: 'usatoday', scoring: 'USATODAY' },
      { registry: 'nydailynews', scoring: 'NYDN' },
      { registry: 'nypost', scoring: 'NYP' },
      { registry: 'thewrap', scoring: 'WRAP' },
      { registry: 'ew', scoring: 'EW' },
      { registry: 'indiewire', scoring: 'INDIEWIRE' },
      { registry: 'deadline', scoring: 'DEADLINE' },
      { registry: 'slantmagazine', scoring: 'SLANT' },
      { registry: 'dailybeast', scoring: 'TDB' },
      { registry: 'observer', scoring: 'OBSERVER' },
      { registry: 'nyt-theater', scoring: 'NYTHTR' },
      { registry: 'nytg', scoring: 'NYTG' },
      { registry: 'nysr', scoring: 'NYSR' },
      { registry: 'theatermania', scoring: 'TMAN' },
      { registry: 'theatrely', scoring: 'THLY' },
      { registry: 'newsday', scoring: 'NEWSDAY' },
      { registry: 'time', scoring: 'TIME' },
      { registry: 'rollingstone', scoring: 'ROLLSTONE' },
      { registry: 'bloomberg', scoring: 'BLOOMBERG' },
      { registry: 'vox', scoring: 'VOX' },
      { registry: 'slate', scoring: 'SLATE' },
      { registry: 'people', scoring: 'PEOPLE' },
      { registry: 'parade', scoring: 'PARADE' },
      { registry: 'billboard', scoring: 'BILLBOARD' },
      { registry: 'huffpost', scoring: 'HUFFPOST' },
      { registry: 'backstage', scoring: 'BACKSTAGE' },
      { registry: 'village-voice', scoring: 'VILLAGEVOICE' },
    ];

    for (const { registry, scoring } of tier2Outlets) {
      it(`maps ${registry} -> ${scoring}`, () => {
        assert.strictEqual(toScoringId(registry), scoring);
      });
    }

    it('maps all tier 2 outlets correctly (28 outlets)', () => {
      const results = tier2Outlets.map(({ registry }) => toScoringId(registry));
      const allValid = results.every(r => r !== undefined);
      assert.strictEqual(allValid, true, 'All tier 2 outlets should map successfully');
      assert.strictEqual(tier2Outlets.length, 28, 'Should have 28 tier 2 outlets');
    });
  });

  describe('toScoringId - Tier 3 outlets', () => {
    const tier3Outlets = [
      { registry: 'amny', scoring: 'AMNY' },
      { registry: 'cititour', scoring: 'CITI' },
      { registry: 'culturesauce', scoring: 'CSCE' },
      { registry: 'frontmezzjunkies', scoring: 'FRONTMEZZ' },
      { registry: 'the-recs', scoring: 'THERECS' },
      { registry: 'one-minute-critic', scoring: 'OMC' },
      { registry: 'broadwayworld', scoring: 'BWW' },
      { registry: 'stageandcinema', scoring: 'STGCNMA' },
      { registry: 'talkinbroadway', scoring: 'TALKINBWAY' },
      { registry: 'ny1', scoring: 'NY1' },
      { registry: 'curtainup', scoring: 'CURTAINUP' },
      { registry: 'theater-scene', scoring: 'THEATERSCENE' },
      { registry: 'njcom', scoring: 'NJCOM' },
      { registry: 'stagezine', scoring: 'STAGEZINE' },
      { registry: 'mashable', scoring: 'MASHABLE' },
      { registry: 'wnyc', scoring: 'WNYC' },
      { registry: 'queerty', scoring: 'QUEERTY' },
      { registry: 'medium', scoring: 'MEDIUM' },
      { registry: 'exeunt-magazine', scoring: 'EXEUNT' },
      { registry: 'towleroad', scoring: 'TOWLEROAD' },
      { registry: 'northjerseycom', scoring: 'NORTHJERSEY' },
      { registry: 'nbcny', scoring: 'NBC' },
    ];

    for (const { registry, scoring } of tier3Outlets) {
      it(`maps ${registry} -> ${scoring}`, () => {
        assert.strictEqual(toScoringId(registry), scoring);
      });
    }
  });

  describe('toScoringId - Alias mappings', () => {
    const aliasTestCases = [
      { alias: 'new-york-times', scoring: 'NYT' },
      { alias: 'washington-post', scoring: 'WASHPOST' },
      { alias: 'los-angeles-times', scoring: 'LATIMES' },
      { alias: 'wall-street-journal', scoring: 'WSJ' },
      { alias: 'associated-press', scoring: 'AP' },
      { alias: 'the-wrap', scoring: 'WRAP' },
      { alias: 'entertainment-weekly', scoring: 'EW' },
      { alias: 'the-daily-beast', scoring: 'TDB' },
      { alias: 'rolling-stone', scoring: 'ROLLSTONE' },
      { alias: 'broadway-world', scoring: 'BWW' },
      { alias: 'stage-and-cinema', scoring: 'STGCNMA' },
      { alias: 'newyorker', scoring: 'NEWYORKER' }, // New Yorker has its own tier 1 entry
    ];

    for (const { alias, scoring } of aliasTestCases) {
      it(`maps alias ${alias} -> ${scoring}`, () => {
        assert.strictEqual(toScoringId(alias), scoring);
      });
    }
  });

  describe('toScoringId - Edge cases', () => {
    it('returns undefined for unknown outlet IDs', () => {
      assert.strictEqual(toScoringId('unknown-outlet'), undefined);
      assert.strictEqual(toScoringId('xyz-news'), undefined);
      assert.strictEqual(toScoringId('random-blog'), undefined);
    });

    it('returns undefined for empty string', () => {
      assert.strictEqual(toScoringId(''), undefined);
    });

    it('returns undefined for null input', () => {
      assert.strictEqual(toScoringId(null), undefined);
    });

    it('returns undefined for undefined input', () => {
      assert.strictEqual(toScoringId(undefined), undefined);
    });

    it('handles whitespace gracefully', () => {
      assert.strictEqual(toScoringId('  nytimes  '), 'NYT');
      assert.strictEqual(toScoringId('  vulture  '), 'VULT');
    });

    it('handles mixed case input (case insensitive)', () => {
      assert.strictEqual(toScoringId('NYTIMES'), 'NYT');
      assert.strictEqual(toScoringId('NYTimes'), 'NYT');
      assert.strictEqual(toScoringId('Vulture'), 'VULT');
    });

    it('returns scoring ID as-is if already in uppercase format', () => {
      assert.strictEqual(toScoringId('NYT'), 'NYT');
      assert.strictEqual(toScoringId('VULT'), 'VULT');
      assert.strictEqual(toScoringId('VARIETY'), 'VARIETY');
    });
  });

  describe('toRegistryId - Reverse mapping', () => {
    const reverseTestCases = [
      { scoring: 'NYT', registry: 'nytimes' },
      { scoring: 'VULT', registry: 'vulture' },
      { scoring: 'VARIETY', registry: 'variety' },
      { scoring: 'THR', registry: 'hollywood-reporter' },
      { scoring: 'WASHPOST', registry: 'washpost' },
      { scoring: 'WSJ', registry: 'wsj' },
      { scoring: 'GUARDIAN', registry: 'guardian' },
      { scoring: 'TIMEOUTNY', registry: 'timeout' },
      { scoring: 'NYP', registry: 'nypost' },
      { scoring: 'TMAN', registry: 'theatermania' },
      { scoring: 'BWW', registry: 'broadwayworld' },
    ];

    for (const { scoring, registry } of reverseTestCases) {
      it(`maps ${scoring} -> ${registry}`, () => {
        assert.strictEqual(toRegistryId(scoring), registry);
      });
    }

    it('returns undefined for unknown scoring IDs', () => {
      assert.strictEqual(toRegistryId('UNKNOWN'), undefined);
      assert.strictEqual(toRegistryId('XYZ'), undefined);
    });

    it('returns undefined for null/undefined input', () => {
      assert.strictEqual(toRegistryId(null), undefined);
      assert.strictEqual(toRegistryId(undefined), undefined);
    });

    it('returns undefined for empty string', () => {
      assert.strictEqual(toRegistryId(''), undefined);
    });

    it('handles lowercase input (normalizes to uppercase)', () => {
      assert.strictEqual(toRegistryId('nyt'), 'nytimes');
      assert.strictEqual(toRegistryId('vult'), 'vulture');
    });
  });

  describe('Bidirectional consistency', () => {
    it('round-trip: toRegistryId(toScoringId(x)) returns x for primary registry IDs', () => {
      const primaryIds = Object.keys(REGISTRY_TO_SCORING);

      for (const registryId of primaryIds) {
        const scoringId = toScoringId(registryId);
        const backToRegistry = toRegistryId(scoringId);
        assert.strictEqual(
          backToRegistry,
          registryId,
          `Round-trip failed for ${registryId}: got ${backToRegistry}`
        );
      }
    });

    it('round-trip: toScoringId(toRegistryId(x)) returns x for all scoring IDs', () => {
      const scoringIds = Object.keys(SCORING_TO_REGISTRY);

      for (const scoringId of scoringIds) {
        const registryId = toRegistryId(scoringId);
        const backToScoring = toScoringId(registryId);
        assert.strictEqual(
          backToScoring,
          scoringId,
          `Round-trip failed for ${scoringId}: got ${backToScoring}`
        );
      }
    });

    it('SCORING_TO_REGISTRY has same number of entries as REGISTRY_TO_SCORING', () => {
      const registryCount = Object.keys(REGISTRY_TO_SCORING).length;
      const scoringCount = Object.keys(SCORING_TO_REGISTRY).length;
      assert.strictEqual(registryCount, scoringCount);
    });
  });

  describe('isKnownOutlet', () => {
    it('returns true for known registry format IDs', () => {
      assert.strictEqual(isKnownOutlet('nytimes'), true);
      assert.strictEqual(isKnownOutlet('vulture'), true);
      assert.strictEqual(isKnownOutlet('variety'), true);
    });

    it('returns true for known scoring format IDs', () => {
      assert.strictEqual(isKnownOutlet('NYT'), true);
      assert.strictEqual(isKnownOutlet('VULT'), true);
      assert.strictEqual(isKnownOutlet('VARIETY'), true);
    });

    it('returns true for known aliases', () => {
      assert.strictEqual(isKnownOutlet('new-york-times'), true);
      assert.strictEqual(isKnownOutlet('washington-post'), true);
    });

    it('returns false for unknown outlets', () => {
      assert.strictEqual(isKnownOutlet('unknown-outlet'), false);
      assert.strictEqual(isKnownOutlet('random-blog'), false);
    });

    it('returns false for null/undefined/empty', () => {
      assert.strictEqual(isKnownOutlet(null), false);
      assert.strictEqual(isKnownOutlet(undefined), false);
      assert.strictEqual(isKnownOutlet(''), false);
    });
  });

  describe('Integration with getOutletConfig()', () => {
    describe('Tier 1 outlets return tier 1', () => {
      const tier1Tests = [
        { id: 'nytimes', expectedTier: 1 },
        { id: 'vulture', expectedTier: 1 },
        { id: 'variety', expectedTier: 1 },
        { id: 'hollywood-reporter', expectedTier: 1 },
        { id: 'wsj', expectedTier: 1 },
        { id: 'guardian', expectedTier: 1 },
        { id: 'timeout', expectedTier: 1 },
        { id: 'washpost', expectedTier: 1 },
        { id: 'ap', expectedTier: 1 },
        { id: 'latimes', expectedTier: 1 },
        { id: 'broadwaynews', expectedTier: 1 },
      ];

      for (const { id, expectedTier } of tier1Tests) {
        it(`${id} returns tier ${expectedTier}`, () => {
          const config = getOutletConfig(id);
          assert.strictEqual(
            config.tier,
            expectedTier,
            `Expected ${id} to be tier ${expectedTier}, got tier ${config.tier}`
          );
        });
      }
    });

    describe('Tier 2 outlets return tier 2', () => {
      const tier2Tests = [
        { id: 'nypost', expectedTier: 2 },
        { id: 'theatermania', expectedTier: 2 },
        { id: 'deadline', expectedTier: 2 },
        { id: 'ew', expectedTier: 2 },
        { id: 'thewrap', expectedTier: 2 },
        { id: 'indiewire', expectedTier: 2 },
        { id: 'dailybeast', expectedTier: 2 },
        { id: 'observer', expectedTier: 2 },
        { id: 'nytg', expectedTier: 2 },
        { id: 'nysr', expectedTier: 2 },
        { id: 'theatrely', expectedTier: 2 },
        { id: 'newsday', expectedTier: 2 },
        { id: 'time', expectedTier: 2 },
        { id: 'bloomberg', expectedTier: 2 },
        { id: 'slate', expectedTier: 2 },
      ];

      for (const { id, expectedTier } of tier2Tests) {
        it(`${id} returns tier ${expectedTier}`, () => {
          const config = getOutletConfig(id);
          assert.strictEqual(
            config.tier,
            expectedTier,
            `Expected ${id} to be tier ${expectedTier}, got tier ${config.tier}`
          );
        });
      }
    });

    describe('Tier 3 outlets return tier 3', () => {
      const tier3Tests = [
        { id: 'broadwayworld', expectedTier: 3 },
        { id: 'cititour', expectedTier: 3 },
        { id: 'stageandcinema', expectedTier: 3 },
        { id: 'ny1', expectedTier: 3 },
        { id: 'curtainup', expectedTier: 3 },
        { id: 'wnyc', expectedTier: 3 },
      ];

      for (const { id, expectedTier } of tier3Tests) {
        it(`${id} returns tier ${expectedTier}`, () => {
          const config = getOutletConfig(id);
          assert.strictEqual(
            config.tier,
            expectedTier,
            `Expected ${id} to be tier ${expectedTier}, got tier ${config.tier}`
          );
        });
      }
    });

    it('uppercase IDs work for backwards compatibility', () => {
      // These should work directly without mapping
      assert.strictEqual(getOutletConfig('NYT').tier, 1);
      assert.strictEqual(getOutletConfig('VULT').tier, 1);
      assert.strictEqual(getOutletConfig('NYP').tier, 2);
      assert.strictEqual(getOutletConfig('BWW').tier, 3);
    });

    it('unknown outlets default to tier 3', () => {
      const config = getOutletConfig('unknown-outlet');
      assert.strictEqual(config.tier, 3);
    });

    it('preserves original ID in returned config', () => {
      // When looking up by registry ID, the returned config should preserve the original ID
      const config = getOutletConfig('nytimes');
      assert.strictEqual(config.id, 'nytimes');
    });
  });

  describe('Coverage statistics', () => {
    it('has at least 10 tier 1 outlets mapped', () => {
      const tier1Count = Object.values(REGISTRY_TO_SCORING)
        .filter(scoringId => {
          // Count tier 1 outlets by checking the known tier 1 IDs
          const tier1Ids = ['NYT', 'WASHPOST', 'LATIMES', 'WSJ', 'AP', 'VARIETY', 'THR', 'VULT', 'GUARDIAN', 'TIMEOUTNY', 'BWAYNEWS'];
          return tier1Ids.includes(scoringId);
        }).length;

      assert.ok(tier1Count >= 10, `Should have at least 10 tier 1 outlets, got ${tier1Count}`);
    });

    it('has at least 15 tier 2 outlets mapped', () => {
      const tier2Count = Object.values(REGISTRY_TO_SCORING)
        .filter(scoringId => {
          // Count tier 2 outlets
          const tier2Ids = ['CHTRIB', 'USATODAY', 'NYDN', 'NYP', 'WRAP', 'EW', 'INDIEWIRE', 'DEADLINE',
            'SLANT', 'TDB', 'OBSERVER', 'NYTHTR', 'NYTG', 'NYSR', 'TMAN', 'THLY', 'NEWSDAY', 'TIME',
            'ROLLSTONE', 'BLOOMBERG', 'VOX', 'SLATE', 'PEOPLE', 'PARADE', 'BILLBOARD', 'HUFFPOST', 'BACKSTAGE', 'VILLAGEVOICE'];
          return tier2Ids.includes(scoringId);
        }).length;

      assert.ok(tier2Count >= 15, `Should have at least 15 tier 2 outlets, got ${tier2Count}`);
    });

    it('has alias mappings for common variations', () => {
      const aliasCount = Object.keys(REGISTRY_ALIASES_TO_SCORING).length;
      assert.ok(aliasCount >= 10, `Should have at least 10 aliases, got ${aliasCount}`);
    });
  });
});
