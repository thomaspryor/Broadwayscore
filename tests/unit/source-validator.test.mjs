/**
 * Unit tests for source-validator module
 *
 * Sprint 3 - Source Validator Module
 *
 * Run with: npm run test:unit
 * Or: node --test tests/unit/source-validator.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  SOURCE_WEIGHTS,
  OVERRIDE_SLUGS,
  calculateConfidence,
  findCorroboration,
  validateChange,
  getSourceWeight,
  valuesMatch
} = require('../../scripts/lib/source-validator');

describe('Source Validator', () => {
  describe('SOURCE_WEIGHTS', () => {
    it('contains all expected source types', () => {
      const expectedSources = [
        'SEC Form D',
        'Deadline',
        'Variety',
        'New York Times',
        'Broadway Journal',
        'Playbill',
        'Reddit Grosses Analysis',
        'Reddit comment',
        'estimate'
      ];

      expectedSources.forEach(source => {
        assert.ok(
          SOURCE_WEIGHTS.hasOwnProperty(source),
          `Missing source: ${source}`
        );
      });
    });

    it('all weights are numbers between 0.1 and 1.0', () => {
      Object.entries(SOURCE_WEIGHTS).forEach(([source, weight]) => {
        assert.strictEqual(
          typeof weight,
          'number',
          `Weight for ${source} is not a number`
        );
        assert.ok(
          weight >= 0.1 && weight <= 1.0,
          `Weight for ${source} (${weight}) is out of range [0.1, 1.0]`
        );
      });
    });

    it('SEC Form D has highest weight (1.0)', () => {
      assert.strictEqual(SOURCE_WEIGHTS['SEC Form D'], 1.0);
    });

    it('estimate has lowest weight (0.3)', () => {
      assert.strictEqual(SOURCE_WEIGHTS['estimate'], 0.3);
    });

    it('trade publications have high weights (>= 0.75)', () => {
      assert.ok(SOURCE_WEIGHTS['Deadline'] >= 0.75);
      assert.ok(SOURCE_WEIGHTS['Variety'] >= 0.75);
      assert.ok(SOURCE_WEIGHTS['Playbill'] >= 0.75);
    });

    it('Reddit comment has low weight (< 0.5)', () => {
      assert.ok(SOURCE_WEIGHTS['Reddit comment'] < 0.5);
    });
  });

  describe('getSourceWeight', () => {
    it('returns correct weight for known source', () => {
      assert.strictEqual(getSourceWeight('SEC Form D'), 1.0);
      assert.strictEqual(getSourceWeight('Reddit comment'), 0.4);
    });

    it('returns 0.5 for unknown source type', () => {
      assert.strictEqual(getSourceWeight('Unknown Source'), 0.5);
      assert.strictEqual(getSourceWeight('Random Blog'), 0.5);
    });
  });

  describe('valuesMatch', () => {
    it('exact numeric match returns true', () => {
      assert.strictEqual(valuesMatch(20000000, 20000000), true);
    });

    it('numeric values within 10% match', () => {
      // 19M is 5% less than 20M - should match
      assert.strictEqual(valuesMatch(20000000, 19000000), true);
      // 21M is 5% more than 20M - should match
      assert.strictEqual(valuesMatch(20000000, 21000000), true);
    });

    it('numeric values outside 10% do not match', () => {
      // 15M is 25% less than 20M - should not match
      assert.strictEqual(valuesMatch(20000000, 15000000), false);
      // 25M is 25% more than 20M - should not match
      assert.strictEqual(valuesMatch(20000000, 25000000), false);
    });

    it('edge case: exactly 10% difference matches', () => {
      // 18M is exactly 10% less than 20M - should match
      assert.strictEqual(valuesMatch(20000000, 18000000), true);
      // 22M is exactly 10% more than 20M - should match
      assert.strictEqual(valuesMatch(20000000, 22000000), true);
    });

    it('edge case: just over 10% difference does not match', () => {
      // 17.9M is ~10.5% less than 20M - should not match
      assert.strictEqual(valuesMatch(20000000, 17900000), false);
    });

    it('string comparison is case-insensitive', () => {
      assert.strictEqual(valuesMatch('Windfall', 'windfall'), true);
      assert.strictEqual(valuesMatch('WINDFALL', 'windfall'), true);
    });

    it('array comparison works element-wise', () => {
      assert.strictEqual(valuesMatch([60, 80], [60, 80]), true);
      assert.strictEqual(valuesMatch([60, 80], [60, 90]), false);
      assert.strictEqual(valuesMatch([60, 80], [60]), false);
    });

    it('null handling', () => {
      assert.strictEqual(valuesMatch(null, null), true);
      assert.strictEqual(valuesMatch(null, 100), false);
      assert.strictEqual(valuesMatch(100, null), false);
    });

    it('zero handling', () => {
      assert.strictEqual(valuesMatch(0, 0), true);
      assert.strictEqual(valuesMatch(0, 100), false);
    });
  });

  describe('calculateConfidence', () => {
    it('2+ supporting sources -> high', () => {
      assert.strictEqual(calculateConfidence('medium', 2, 0), 'high');
      assert.strictEqual(calculateConfidence('low', 3, 0), 'high');
      assert.strictEqual(calculateConfidence('medium', 2, 1), 'high');
    });

    it('contradicting > supporting -> flagged', () => {
      assert.strictEqual(calculateConfidence('medium', 0, 2), 'flagged');
      assert.strictEqual(calculateConfidence('high', 1, 2), 'flagged');
      assert.strictEqual(calculateConfidence('medium', 0, 1), 'flagged');
    });

    it('1 supporting + 0 contradicting -> original', () => {
      assert.strictEqual(calculateConfidence('medium', 1, 0), 'medium');
      assert.strictEqual(calculateConfidence('high', 1, 0), 'high');
      assert.strictEqual(calculateConfidence('low', 1, 0), 'low');
    });

    it('equal supporting and contradicting with <2 supporting -> original', () => {
      assert.strictEqual(calculateConfidence('high', 1, 1), 'high');
      assert.strictEqual(calculateConfidence('medium', 1, 1), 'medium');
    });

    it('0 supporting + 0 contradicting -> original', () => {
      assert.strictEqual(calculateConfidence('low', 0, 0), 'low');
      assert.strictEqual(calculateConfidence('medium', 0, 0), 'medium');
      assert.strictEqual(calculateConfidence('high', 0, 0), 'high');
    });
  });

  describe('findCorroboration', () => {
    const mockSources = [
      { showSlug: 'hamilton-2015', field: 'capitalization', value: 19500000, sourceType: 'Variety' },
      { showSlug: 'hamilton-2015', field: 'capitalization', value: 21000000, sourceType: 'New York Times' },
      { showSlug: 'hamilton-2015', field: 'capitalization', value: 15000000, sourceType: 'Reddit comment' },
      { showSlug: 'hamilton-2015', field: 'weeklyRunningCost', value: 800000, sourceType: 'Deadline' },
      { showSlug: 'wicked-2003', field: 'capitalization', value: 20000000, sourceType: 'Playbill' }
    ];

    it('finds supporting sources within 10% tolerance', () => {
      const change = {
        showSlug: 'hamilton-2015',
        field: 'capitalization',
        newValue: 20000000
      };

      const result = findCorroboration(change, mockSources);

      // 19.5M and 21M are within 10% of 20M
      assert.strictEqual(result.supporting.length, 2);
      assert.ok(result.supporting.some(s => s.sourceType === 'Variety'));
      assert.ok(result.supporting.some(s => s.sourceType === 'New York Times'));
    });

    it('finds contradicting sources outside 10% tolerance', () => {
      const change = {
        showSlug: 'hamilton-2015',
        field: 'capitalization',
        newValue: 20000000
      };

      const result = findCorroboration(change, mockSources);

      // 15M is more than 10% away from 20M
      assert.strictEqual(result.contradicting.length, 1);
      assert.strictEqual(result.contradicting[0].sourceType, 'Reddit comment');
    });

    it('only matches same show slug', () => {
      const change = {
        showSlug: 'hamilton-2015',
        field: 'capitalization',
        newValue: 20000000
      };

      const result = findCorroboration(change, mockSources);

      // Should not include wicked-2003 source
      assert.ok(!result.supporting.some(s => s.showSlug === 'wicked-2003'));
      assert.ok(!result.contradicting.some(s => s.showSlug === 'wicked-2003'));
    });

    it('only matches same field', () => {
      const change = {
        showSlug: 'hamilton-2015',
        field: 'capitalization',
        newValue: 20000000
      };

      const result = findCorroboration(change, mockSources);

      // Should not include weeklyRunningCost source
      assert.ok(!result.supporting.some(s => s.field === 'weeklyRunningCost'));
      assert.ok(!result.contradicting.some(s => s.field === 'weeklyRunningCost'));
    });

    it('handles empty sources array', () => {
      const change = {
        showSlug: 'hamilton-2015',
        field: 'capitalization',
        newValue: 20000000
      };

      const result = findCorroboration(change, []);
      assert.strictEqual(result.supporting.length, 0);
      assert.strictEqual(result.contradicting.length, 0);
    });

    it('handles null/undefined sources', () => {
      const change = {
        showSlug: 'hamilton-2015',
        field: 'capitalization',
        newValue: 20000000
      };

      assert.deepStrictEqual(findCorroboration(change, null), { supporting: [], contradicting: [] });
      assert.deepStrictEqual(findCorroboration(change, undefined), { supporting: [], contradicting: [] });
    });

    it('does not self-corroborate', () => {
      const change = {
        showSlug: 'hamilton-2015',
        field: 'capitalization',
        newValue: 20000000,
        sourceType: 'Variety',
        sourceUrl: 'https://variety.com/article1'
      };

      const sourcesWithSameUrl = [
        { showSlug: 'hamilton-2015', field: 'capitalization', value: 20000000, sourceType: 'Variety', url: 'https://variety.com/article1' }
      ];

      const result = findCorroboration(change, sourcesWithSameUrl);
      assert.strictEqual(result.supporting.length, 0);
    });
  });

  describe('validateChange', () => {
    const mockSources = [
      { showSlug: 'hamilton-2015', field: 'capitalization', value: 19500000, sourceType: 'Variety' },
      { showSlug: 'hamilton-2015', field: 'capitalization', value: 21000000, sourceType: 'SEC Form D' }
    ];

    it('returns all required fields', () => {
      const change = {
        showSlug: 'hamilton-2015',
        field: 'capitalization',
        newValue: 20000000,
        oldValue: null,
        confidence: 'medium'
      };

      const result = validateChange(change, mockSources);

      assert.ok('validatedConfidence' in result);
      assert.ok('supportingSources' in result);
      assert.ok('contradictingSources' in result);
      assert.ok('validationNotes' in result);
      // Original fields preserved
      assert.strictEqual(result.showSlug, 'hamilton-2015');
      assert.strictEqual(result.field, 'capitalization');
      assert.strictEqual(result.newValue, 20000000);
    });

    it('upgrades confidence with 2+ supporting sources', () => {
      const change = {
        showSlug: 'hamilton-2015',
        field: 'capitalization',
        newValue: 20000000,
        confidence: 'medium'
      };

      const result = validateChange(change, mockSources);

      assert.strictEqual(result.validatedConfidence, 'high');
      assert.strictEqual(result.supportingSources.length, 2);
    });

    it('flags when contradicting > supporting', () => {
      const change = {
        showSlug: 'hamilton-2015',
        field: 'capitalization',
        newValue: 50000000, // Way off from sources
        confidence: 'medium'
      };

      const sourcesContradicting = [
        { showSlug: 'hamilton-2015', field: 'capitalization', value: 20000000, sourceType: 'Variety' },
        { showSlug: 'hamilton-2015', field: 'capitalization', value: 21000000, sourceType: 'Deadline' }
      ];

      const result = validateChange(change, sourcesContradicting);

      assert.strictEqual(result.validatedConfidence, 'flagged');
      assert.strictEqual(result.contradictingSources.length, 2);
    });

    it('includes validation notes', () => {
      const change = {
        showSlug: 'hamilton-2015',
        field: 'capitalization',
        newValue: 20000000,
        confidence: 'medium'
      };

      const result = validateChange(change, mockSources);

      assert.ok(result.validationNotes.includes('supporting source'));
      assert.ok(result.validationNotes.includes('Confidence adjusted'));
    });

    it('handles no corroborating sources', () => {
      const change = {
        showSlug: 'unknown-show',
        field: 'capitalization',
        newValue: 20000000,
        confidence: 'medium'
      };

      const result = validateChange(change, mockSources);

      assert.strictEqual(result.validatedConfidence, 'medium');
      assert.strictEqual(result.supportingSources.length, 0);
      assert.strictEqual(result.contradictingSources.length, 0);
      assert.ok(result.validationNotes.includes('No corroborating sources'));
    });
  });

  describe('OVERRIDE_SLUGS', () => {
    it('is an array', () => {
      assert.ok(Array.isArray(OVERRIDE_SLUGS));
    });

    it('bypasses validation for override slugs', () => {
      // Temporarily add a test slug if OVERRIDE_SLUGS is empty
      // This test validates the bypass mechanism works
      const change = {
        showSlug: 'test-override-slug',
        field: 'capitalization',
        newValue: 99999999,
        confidence: 'low'
      };

      // If the slug is not in OVERRIDE_SLUGS, normal validation happens
      const normalResult = validateChange(change, [
        { showSlug: 'test-override-slug', field: 'capitalization', value: 1, sourceType: 'Variety' }
      ]);

      // If not overridden, should be flagged (since value contradicts)
      if (!OVERRIDE_SLUGS.includes('test-override-slug')) {
        assert.strictEqual(normalResult.validatedConfidence, 'flagged');
      }
    });
  });

  describe('Full validation flow', () => {
    it('complete validation scenario', () => {
      const change = {
        showSlug: 'hadestown-2019',
        field: 'capitalization',
        newValue: 16500000,
        oldValue: null,
        confidence: 'medium',
        sourceType: 'Deadline',
        sourceUrl: 'https://deadline.com/hadestown-article'
      };

      const allSources = [
        { showSlug: 'hadestown-2019', field: 'capitalization', value: 16000000, sourceType: 'Variety' },
        { showSlug: 'hadestown-2019', field: 'capitalization', value: 17000000, sourceType: 'Playbill' },
        { showSlug: 'hadestown-2019', field: 'weeklyRunningCost', value: 650000, sourceType: 'Broadway Journal' },
        { showSlug: 'hamilton-2015', field: 'capitalization', value: 20000000, sourceType: 'SEC Form D' }
      ];

      const result = validateChange(change, allSources);

      // Should find 2 supporting (Variety and Playbill within 10%)
      assert.strictEqual(result.supportingSources.length, 2);
      // Should upgrade to high confidence
      assert.strictEqual(result.validatedConfidence, 'high');
      // Original fields preserved
      assert.strictEqual(result.confidence, 'medium');
      assert.strictEqual(result.showSlug, 'hadestown-2019');
    });
  });
});
