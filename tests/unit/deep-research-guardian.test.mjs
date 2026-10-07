/**
 * Unit tests for Deep Research Guardian module
 *
 * The Deep Research Guardian protects verified commercial data from being
 * overwritten by automated processes. Shows with Deep Research data have
 * been manually verified through detailed financial analysis and should
 * only be updated through explicit Deep Research updates.
 *
 * Run with: npm run test:unit
 * Or: node --test tests/unit/deep-research-guardian.test.mjs
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  detectConflict,
  calculateSeverity,
  calculateDiscrepancy,
  shouldBlockChange,
  getProtectedShows
} = require('../../scripts/lib/deep-research-guardian.js');

describe('Deep Research Guardian', () => {

  describe('detectConflict', () => {

    it('returns null when showData has no deepResearch object', () => {
      const change = {
        slug: 'test-show',
        field: 'estimatedRecoupmentPct',
        newValue: [10, 30],
        oldValue: [70, 80]
      };
      const showData = {
        designation: 'TBD',
        estimatedRecoupmentPct: [70, 80]
      };

      const result = detectConflict(change, showData);
      assert.strictEqual(result, null);
    });

    it('returns null when field is not in verifiedFields', () => {
      const change = {
        slug: 'test-show',
        field: 'notes',
        newValue: 'new notes',
        oldValue: 'old notes'
      };
      const showData = {
        deepResearch: {
          verifiedFields: ['estimatedRecoupmentPct'],
          verifiedDate: '2026-01-28'
        }
      };

      const result = detectConflict(change, showData);
      assert.strictEqual(result, null);
    });

    it('returns conflict when verified field is being changed', () => {
      const change = {
        slug: 'death-becomes-her',
        field: 'estimatedRecoupmentPct',
        newValue: [10, 30],
        oldValue: [70, 80],
        source: 'Reddit Grosses Analysis'
      };
      const showData = {
        deepResearch: {
          verifiedFields: ['estimatedRecoupmentPct'],
          verifiedDate: '2026-01-28',
          notes: 'Verified through Deep Research'
        }
      };

      const result = detectConflict(change, showData);
      assert.notStrictEqual(result, null);
      assert.strictEqual(result.slug, 'death-becomes-her');
      assert.strictEqual(result.field, 'estimatedRecoupmentPct');
      assert.strictEqual(result.severity, 'critical');
    });

    it('returns null when showData is null', () => {
      const change = { slug: 'test', field: 'field', newValue: 1, oldValue: 2 };
      assert.strictEqual(detectConflict(change, null), null);
    });

    it('returns null when showData is undefined', () => {
      const change = { slug: 'test', field: 'field', newValue: 1, oldValue: 2 };
      assert.strictEqual(detectConflict(change, undefined), null);
    });

    it('includes source information in conflict object', () => {
      const change = {
        slug: 'test-show',
        field: 'capitalization',
        newValue: 15000000,
        oldValue: 22000000,
        source: 'Reddit Grosses Analysis'
      };
      const showData = {
        deepResearch: {
          verifiedFields: ['capitalization'],
          verifiedDate: '2026-01-15'
        }
      };

      const result = detectConflict(change, showData);
      assert.notStrictEqual(result, null);
      assert.strictEqual(result.source, 'Reddit Grosses Analysis');
    });

    it('includes verified date in conflict object', () => {
      const change = {
        slug: 'test-show',
        field: 'weeklyRunningCost',
        newValue: 500000,
        oldValue: 900000,
        source: 'estimate'
      };
      const showData = {
        deepResearch: {
          verifiedFields: ['weeklyRunningCost'],
          verifiedDate: '2026-01-20',
          notes: 'Confirmed via producer interview'
        }
      };

      const result = detectConflict(change, showData);
      assert.notStrictEqual(result, null);
      assert.strictEqual(result.verifiedDate, '2026-01-20');
    });

  });

  describe('calculateSeverity', () => {

    it('returns critical for >30pt recoupment difference', () => {
      const result = calculateSeverity('estimatedRecoupmentPct', [70, 80], [10, 30]);
      assert.strictEqual(result, 'critical');
    });

    it('returns high for >15pt recoupment difference', () => {
      const result = calculateSeverity('estimatedRecoupmentPct', [50, 60], [30, 40]);
      assert.strictEqual(result, 'high');
    });

    it('returns medium for >5pt recoupment difference', () => {
      // [50, 60] has midpoint 55, [40, 50] has midpoint 45, diff = 10pt
      const result = calculateSeverity('estimatedRecoupmentPct', [50, 60], [40, 50]);
      assert.strictEqual(result, 'medium');
    });

    it('returns low for small recoupment difference', () => {
      const result = calculateSeverity('estimatedRecoupmentPct', [50, 60], [52, 58]);
      assert.strictEqual(result, 'low');
    });

    it('returns critical for >50% financial difference', () => {
      const result = calculateSeverity('weeklyRunningCost', 1000000, 400000);
      assert.strictEqual(result, 'critical');
    });

    it('returns high for >30% financial difference', () => {
      const result = calculateSeverity('weeklyRunningCost', 1000000, 650000);
      assert.strictEqual(result, 'high');
    });

    it('returns medium for >15% financial difference', () => {
      const result = calculateSeverity('weeklyRunningCost', 1000000, 800000);
      assert.strictEqual(result, 'medium');
    });

    it('returns low for small financial difference', () => {
      const result = calculateSeverity('weeklyRunningCost', 1000000, 950000);
      assert.strictEqual(result, 'low');
    });

    it('returns critical for boolean change from true to false', () => {
      const result = calculateSeverity('recouped', true, false);
      assert.strictEqual(result, 'critical');
    });

    it('returns critical for boolean change from false to true', () => {
      const result = calculateSeverity('recouped', false, true);
      assert.strictEqual(result, 'critical');
    });

    it('returns low for boolean no change', () => {
      const result = calculateSeverity('recouped', true, true);
      assert.strictEqual(result, 'low');
    });

    it('returns high for designation change', () => {
      const result = calculateSeverity('designation', 'Windfall', 'Flop');
      assert.strictEqual(result, 'high');
    });

    it('returns low for same designation', () => {
      const result = calculateSeverity('designation', 'Windfall', 'Windfall');
      assert.strictEqual(result, 'low');
    });

    it('handles capitalization field like other financial fields', () => {
      const result = calculateSeverity('capitalization', 22000000, 10000000);
      assert.strictEqual(result, 'critical');
    });

    it('handles null verified values gracefully', () => {
      const result = calculateSeverity('weeklyRunningCost', null, 500000);
      assert.ok(['low', 'medium', 'high', 'critical'].includes(result));
    });

    it('handles null proposed values gracefully', () => {
      const result = calculateSeverity('weeklyRunningCost', 500000, null);
      assert.ok(['low', 'medium', 'high', 'critical'].includes(result));
    });

  });

  describe('calculateDiscrepancy', () => {

    it('formats recoupment percentage ranges correctly', () => {
      const result = calculateDiscrepancy('estimatedRecoupmentPct', [70, 80], [10, 30]);
      assert.match(result, /verified 70-80%/);
      assert.match(result, /proposed 10-30%/);
    });

    it('formats large financial numbers with M suffix', () => {
      const result = calculateDiscrepancy('capitalization', 22000000, 18000000);
      assert.match(result, /\$22\.0M/);
      assert.match(result, /\$18\.0M/);
    });

    it('formats smaller financial numbers with K suffix', () => {
      const result = calculateDiscrepancy('weeklyRunningCost', 900000, 500000);
      assert.match(result, /\$900K/);
      assert.match(result, /\$500K/);
    });

    it('includes percentage change for financial numbers', () => {
      const result = calculateDiscrepancy('weeklyRunningCost', 1000000, 800000);
      assert.match(result, /-20\.0% change/);
    });

    it('shows positive percentage for increases', () => {
      const result = calculateDiscrepancy('weeklyRunningCost', 800000, 1000000);
      assert.match(result, /\+25\.0% change/);
    });

    it('formats boolean values correctly', () => {
      const result = calculateDiscrepancy('recouped', true, false);
      assert.match(result, /verified true/);
      assert.match(result, /proposed false/);
    });

    it('formats designation values correctly', () => {
      const result = calculateDiscrepancy('designation', 'Windfall', 'Flop');
      assert.match(result, /verified Windfall/);
      assert.match(result, /proposed Flop/);
    });

    it('handles single percentage values (not ranges)', () => {
      const result = calculateDiscrepancy('estimatedRecoupmentPct', 75, 50);
      assert.match(result, /verified 75%/);
      assert.match(result, /proposed 50%/);
    });

    it('includes point difference for recoupment percentages', () => {
      const result = calculateDiscrepancy('estimatedRecoupmentPct', [70, 80], [40, 50]);
      assert.match(result, /30pt difference/);
    });

  });

  describe('shouldBlockChange', () => {

    it('returns true for critical severity', () => {
      const conflict = { severity: 'critical' };
      assert.strictEqual(shouldBlockChange(conflict), true);
    });

    it('returns true for high severity', () => {
      const conflict = { severity: 'high' };
      assert.strictEqual(shouldBlockChange(conflict), true);
    });

    it('returns false for medium severity', () => {
      const conflict = { severity: 'medium' };
      assert.strictEqual(shouldBlockChange(conflict), false);
    });

    it('returns false for low severity', () => {
      const conflict = { severity: 'low' };
      assert.strictEqual(shouldBlockChange(conflict), false);
    });

    it('returns false for null conflict', () => {
      assert.strictEqual(shouldBlockChange(null), false);
    });

    it('returns false for undefined conflict', () => {
      assert.strictEqual(shouldBlockChange(undefined), false);
    });

    it('returns false for conflict without severity', () => {
      const conflict = { slug: 'test', field: 'test' };
      assert.strictEqual(shouldBlockChange(conflict), false);
    });

  });

  describe('getProtectedShows', () => {

    it('returns empty array for data with no Deep Research shows', () => {
      const commercialData = {
        shows: {
          'show-a': { designation: 'TBD' },
          'show-b': { designation: 'Windfall' }
        }
      };

      const result = getProtectedShows(commercialData);
      assert.deepStrictEqual(result, []);
    });

    it('returns protected shows with deepResearch data', () => {
      const commercialData = {
        shows: {
          'show-a': { designation: 'TBD' },
          'show-b': {
            designation: 'TBD',
            deepResearch: {
              verifiedFields: ['estimatedRecoupmentPct'],
              verifiedDate: '2026-01-28',
              notes: 'Test notes'
            }
          }
        }
      };

      const result = getProtectedShows(commercialData);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].slug, 'show-b');
      assert.deepStrictEqual(result[0].verifiedFields, ['estimatedRecoupmentPct']);
    });

    it('returns multiple protected shows', () => {
      const commercialData = {
        shows: {
          'show-a': {
            designation: 'Windfall',
            deepResearch: {
              verifiedFields: ['capitalization', 'recouped'],
              verifiedDate: '2026-01-15'
            }
          },
          'show-b': {
            designation: 'TBD',
            deepResearch: {
              verifiedFields: ['estimatedRecoupmentPct'],
              verifiedDate: '2026-01-28'
            }
          },
          'show-c': { designation: 'Flop' }
        }
      };

      const result = getProtectedShows(commercialData);
      assert.strictEqual(result.length, 2);
      const slugs = result.map(s => s.slug);
      assert.ok(slugs.includes('show-a'));
      assert.ok(slugs.includes('show-b'));
    });

    it('includes verifiedDate in returned show objects', () => {
      const commercialData = {
        shows: {
          'death-becomes-her': {
            designation: 'TBD',
            deepResearch: {
              verifiedFields: ['estimatedRecoupmentPct', 'capitalization'],
              verifiedDate: '2026-01-28',
              notes: 'Deep Research analysis complete'
            }
          }
        }
      };

      const result = getProtectedShows(commercialData);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].verifiedDate, '2026-01-28');
    });

    it('handles empty or missing shows object', () => {
      assert.deepStrictEqual(getProtectedShows({}), []);
      assert.deepStrictEqual(getProtectedShows({ shows: {} }), []);
    });

    it('handles null commercialData', () => {
      assert.deepStrictEqual(getProtectedShows(null), []);
    });

    it('handles undefined commercialData', () => {
      assert.deepStrictEqual(getProtectedShows(undefined), []);
    });

    it('ignores shows with empty verifiedFields array', () => {
      const commercialData = {
        shows: {
          'show-a': {
            designation: 'TBD',
            deepResearch: {
              verifiedFields: [],
              verifiedDate: '2026-01-28'
            }
          }
        }
      };

      const result = getProtectedShows(commercialData);
      assert.deepStrictEqual(result, []);
    });

    it('includes notes in returned show objects when present', () => {
      const commercialData = {
        shows: {
          'test-show': {
            designation: 'TBD',
            deepResearch: {
              verifiedFields: ['weeklyRunningCost'],
              verifiedDate: '2026-01-28',
              notes: 'Verified via producer interview'
            }
          }
        }
      };

      const result = getProtectedShows(commercialData);
      assert.strictEqual(result.length, 1);
      assert.strictEqual(result[0].notes, 'Verified via producer interview');
    });

  });

  describe('Integration scenarios', () => {

    it('complete workflow: detect conflict, check severity, decide to block', () => {
      const change = {
        slug: 'death-becomes-her',
        field: 'estimatedRecoupmentPct',
        newValue: [10, 30],
        oldValue: [70, 80],
        source: 'Reddit Grosses Analysis'
      };

      const showData = {
        title: 'Death Becomes Her',
        designation: 'TBD',
        estimatedRecoupmentPct: [70, 80],
        deepResearch: {
          verifiedFields: ['estimatedRecoupmentPct', 'capitalization'],
          verifiedDate: '2026-01-28',
          notes: 'Comprehensive analysis based on producer interviews and SEC filings'
        }
      };

      // Step 1: Detect conflict
      const conflict = detectConflict(change, showData);
      assert.notStrictEqual(conflict, null);

      // Step 2: Verify severity is critical (>30pt difference)
      assert.strictEqual(conflict.severity, 'critical');

      // Step 3: Should block this change
      assert.strictEqual(shouldBlockChange(conflict), true);

      // Step 4: Discrepancy message should be informative
      const discrepancy = calculateDiscrepancy(
        conflict.field,
        showData.estimatedRecoupmentPct,
        change.newValue
      );
      assert.match(discrepancy, /verified 70-80%/);
      assert.match(discrepancy, /proposed 10-30%/);
    });

    it('allows changes to non-verified fields on protected shows', () => {
      const change = {
        slug: 'death-becomes-her',
        field: 'notes',
        newValue: 'Updated notes',
        oldValue: 'Old notes',
        source: 'manual'
      };

      const showData = {
        deepResearch: {
          verifiedFields: ['estimatedRecoupmentPct', 'capitalization'],
          verifiedDate: '2026-01-28'
        }
      };

      const conflict = detectConflict(change, showData);
      assert.strictEqual(conflict, null);
    });

    it('allows minor adjustments (low severity) to verified fields', () => {
      const change = {
        slug: 'test-show',
        field: 'weeklyRunningCost',
        newValue: 880000,
        oldValue: 900000,
        source: 'Playbill'
      };

      const showData = {
        deepResearch: {
          verifiedFields: ['weeklyRunningCost'],
          verifiedDate: '2026-01-20'
        }
      };

      const conflict = detectConflict(change, showData);

      // Conflict is detected but severity should be low
      assert.notStrictEqual(conflict, null);
      assert.strictEqual(conflict.severity, 'low');

      // Low severity should not block
      assert.strictEqual(shouldBlockChange(conflict), false);
    });

  });

});
