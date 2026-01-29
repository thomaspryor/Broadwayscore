#!/usr/bin/env node
/**
 * Deep Research Guardian Module
 *
 * Protects verified commercial data from being overwritten by automated processes.
 * Shows with Deep Research data have been manually verified through detailed
 * financial analysis (producer interviews, SEC filings, trade press) and should
 * only be updated through explicit Deep Research updates.
 *
 * The deepResearch object in commercial-data.json contains:
 * - verifiedFields: Array of field names that have been verified
 * - verifiedDate: ISO date string of when verification occurred
 * - notes: Optional notes about the verification process
 *
 * Usage:
 *   const { detectConflict, shouldBlockChange, getProtectedShows } = require('./lib/deep-research-guardian');
 *
 *   const conflict = detectConflict(change, showData);
 *   if (conflict && shouldBlockChange(conflict)) {
 *     console.log(`Blocked: ${calculateDiscrepancy(conflict.field, conflict.verifiedValue, conflict.proposedValue)}`);
 *   }
 *
 * CLI Test Mode:
 *   node scripts/lib/deep-research-guardian.js --test
 */

/**
 * Detect if a proposed change conflicts with Deep Research verified data.
 *
 * @param {Object} change - Proposed change object
 * @param {string} change.slug - Show slug identifier
 * @param {string} change.field - Field being changed
 * @param {*} change.newValue - Proposed new value
 * @param {*} change.oldValue - Current value
 * @param {string} [change.source] - Source of the proposed change
 * @param {Object} showData - Show's current data from commercial-data.json
 * @returns {Object|null} Conflict object if detected, null otherwise
 */
function detectConflict(change, showData) {
  // No conflict if showData is null/undefined
  if (!showData) {
    return null;
  }

  // No conflict if no Deep Research data
  if (!showData.deepResearch) {
    return null;
  }

  const { verifiedFields, verifiedDate, notes } = showData.deepResearch;

  // No conflict if verifiedFields is empty or doesn't include this field
  if (!verifiedFields || !Array.isArray(verifiedFields) || !verifiedFields.includes(change.field)) {
    return null;
  }

  // Get the verified value (current value in the data)
  const verifiedValue = showData[change.field] || change.oldValue;

  // Calculate severity based on the difference
  const severity = calculateSeverity(change.field, verifiedValue, change.newValue);

  return {
    slug: change.slug,
    field: change.field,
    verifiedValue,
    proposedValue: change.newValue,
    verifiedDate,
    notes,
    source: change.source,
    severity
  };
}

/**
 * Calculate the severity of a conflict based on how much the values differ.
 *
 * Severity levels:
 * - critical: Major discrepancy that would fundamentally change the show's financial picture
 * - high: Significant discrepancy that warrants investigation
 * - medium: Moderate discrepancy that should be reviewed
 * - low: Minor discrepancy that may be acceptable
 *
 * @param {string} field - Field name
 * @param {*} verifiedValue - Value verified through Deep Research
 * @param {*} proposedValue - Proposed new value
 * @returns {string} Severity level: 'critical', 'high', 'medium', or 'low'
 */
function calculateSeverity(field, verifiedValue, proposedValue) {
  // Handle recoupment percentage ranges
  if (field === 'estimatedRecoupmentPct') {
    const verifiedMid = getRecoupmentMidpoint(verifiedValue);
    const proposedMid = getRecoupmentMidpoint(proposedValue);
    const pointDiff = Math.abs(verifiedMid - proposedMid);

    if (pointDiff > 30) return 'critical';
    if (pointDiff > 15) return 'high';
    if (pointDiff > 5) return 'medium';
    return 'low';
  }

  // Handle boolean fields (recouped, etc.)
  if (typeof verifiedValue === 'boolean' || typeof proposedValue === 'boolean') {
    if (verifiedValue !== proposedValue) return 'critical';
    return 'low';
  }

  // Handle designation changes
  if (field === 'designation') {
    if (verifiedValue !== proposedValue) return 'high';
    return 'low';
  }

  // Handle financial fields (capitalization, weeklyRunningCost, etc.)
  if (isFinancialField(field)) {
    const verified = verifiedValue || 0;
    const proposed = proposedValue || 0;

    if (verified === 0 && proposed === 0) return 'low';
    if (verified === 0 || proposed === 0) return 'critical';

    const percentDiff = Math.abs(verified - proposed) / Math.max(verified, proposed);

    if (percentDiff > 0.50) return 'critical';
    if (percentDiff > 0.30) return 'high';
    if (percentDiff > 0.15) return 'medium';
    return 'low';
  }

  // Default: any change to verified field is at least medium severity
  return 'medium';
}

/**
 * Calculate a human-readable discrepancy description.
 *
 * @param {string} field - Field name
 * @param {*} verifiedValue - Value verified through Deep Research
 * @param {*} proposedValue - Proposed new value
 * @returns {string} Human-readable discrepancy description
 */
function calculateDiscrepancy(field, verifiedValue, proposedValue) {
  // Handle recoupment percentage ranges
  if (field === 'estimatedRecoupmentPct') {
    const verifiedStr = formatRecoupmentPct(verifiedValue);
    const proposedStr = formatRecoupmentPct(proposedValue);
    const verifiedMid = getRecoupmentMidpoint(verifiedValue);
    const proposedMid = getRecoupmentMidpoint(proposedValue);
    const pointDiff = Math.abs(verifiedMid - proposedMid);
    return `verified ${verifiedStr}, proposed ${proposedStr} (${pointDiff}pt difference)`;
  }

  // Handle boolean fields
  if (typeof verifiedValue === 'boolean' || typeof proposedValue === 'boolean') {
    return `verified ${verifiedValue}, proposed ${proposedValue}`;
  }

  // Handle designation changes
  if (field === 'designation') {
    return `verified ${verifiedValue}, proposed ${proposedValue}`;
  }

  // Handle financial fields
  if (isFinancialField(field)) {
    const verifiedStr = formatFinancialValue(verifiedValue);
    const proposedStr = formatFinancialValue(proposedValue);

    // Calculate percentage change
    const verified = verifiedValue || 0;
    const proposed = proposedValue || 0;
    let percentStr = '';

    if (verified !== 0) {
      const percentChange = ((proposed - verified) / verified) * 100;
      const sign = percentChange >= 0 ? '+' : '';
      percentStr = ` (${sign}${percentChange.toFixed(1)}% change)`;
    }

    return `verified ${verifiedStr}, proposed ${proposedStr}${percentStr}`;
  }

  // Default format
  return `verified ${JSON.stringify(verifiedValue)}, proposed ${JSON.stringify(proposedValue)}`;
}

/**
 * Determine if a conflict should block the change.
 * Critical and high severity conflicts are blocked.
 *
 * @param {Object|null} conflict - Conflict object from detectConflict
 * @returns {boolean} True if change should be blocked
 */
function shouldBlockChange(conflict) {
  if (!conflict) return false;
  if (!conflict.severity) return false;

  return conflict.severity === 'critical' || conflict.severity === 'high';
}

/**
 * Get all shows with Deep Research protection.
 *
 * @param {Object} commercialData - Full commercial-data.json contents
 * @returns {Array} Array of protected show objects with slug, verifiedFields, verifiedDate, notes
 */
function getProtectedShows(commercialData) {
  if (!commercialData || !commercialData.shows) {
    return [];
  }

  const protectedShows = [];

  for (const [slug, showData] of Object.entries(commercialData.shows)) {
    if (showData.deepResearch &&
        showData.deepResearch.verifiedFields &&
        showData.deepResearch.verifiedFields.length > 0) {
      protectedShows.push({
        slug,
        verifiedFields: showData.deepResearch.verifiedFields,
        verifiedDate: showData.deepResearch.verifiedDate,
        notes: showData.deepResearch.notes
      });
    }
  }

  return protectedShows;
}

// Helper functions

/**
 * Check if a field is a financial field.
 */
function isFinancialField(field) {
  return [
    'capitalization',
    'weeklyRunningCost',
    'weeklyGrossTarget',
    'breakEvenGross',
    'cumulativeGross',
    'cumulativeProfit'
  ].includes(field);
}

/**
 * Get the midpoint of a recoupment percentage (handles both ranges and single values).
 */
function getRecoupmentMidpoint(value) {
  if (Array.isArray(value) && value.length === 2) {
    return (value[0] + value[1]) / 2;
  }
  if (typeof value === 'number') {
    return value;
  }
  return 0;
}

/**
 * Format a recoupment percentage value for display.
 */
function formatRecoupmentPct(value) {
  if (Array.isArray(value) && value.length === 2) {
    return `${value[0]}-${value[1]}%`;
  }
  if (typeof value === 'number') {
    return `${value}%`;
  }
  return String(value);
}

/**
 * Format a financial value for display (with K or M suffix).
 */
function formatFinancialValue(value) {
  if (value == null) return 'null';
  if (typeof value !== 'number') return String(value);

  if (value >= 1000000) {
    return `$${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `$${Math.round(value / 1000)}K`;
  }
  return `$${value}`;
}

// CLI test mode
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    console.log('Deep Research Guardian - Test Mode\n');
    console.log('='.repeat(50));

    // Test detectConflict
    console.log('\nTesting detectConflict():');

    const testChange = {
      slug: 'death-becomes-her',
      field: 'estimatedRecoupmentPct',
      newValue: [10, 30],
      oldValue: [70, 80],
      source: 'Reddit Grosses Analysis'
    };

    const testShowData = {
      title: 'Death Becomes Her',
      designation: 'TBD',
      estimatedRecoupmentPct: [70, 80],
      deepResearch: {
        verifiedFields: ['estimatedRecoupmentPct', 'capitalization'],
        verifiedDate: '2026-01-28',
        notes: 'Verified through producer interview and SEC filings'
      }
    };

    console.log('\nProposed change:');
    console.log(`  Slug: ${testChange.slug}`);
    console.log(`  Field: ${testChange.field}`);
    console.log(`  New Value: ${JSON.stringify(testChange.newValue)}`);
    console.log(`  Source: ${testChange.source}`);

    console.log('\nCurrent show data (with Deep Research):');
    console.log(`  Verified Fields: ${testShowData.deepResearch.verifiedFields.join(', ')}`);
    console.log(`  Verified Date: ${testShowData.deepResearch.verifiedDate}`);

    const conflict = detectConflict(testChange, testShowData);

    if (conflict) {
      console.log('\n[CONFLICT DETECTED]');
      console.log(`  Severity: ${conflict.severity}`);
      console.log(`  Should Block: ${shouldBlockChange(conflict)}`);
      console.log(`  Discrepancy: ${calculateDiscrepancy(conflict.field, conflict.verifiedValue, conflict.proposedValue)}`);
    } else {
      console.log('\n[NO CONFLICT]');
    }

    // Test calculateSeverity
    console.log('\n' + '='.repeat(50));
    console.log('Testing calculateSeverity():');

    const severityTests = [
      { field: 'estimatedRecoupmentPct', verified: [70, 80], proposed: [10, 30], expected: 'critical' },
      { field: 'estimatedRecoupmentPct', verified: [50, 60], proposed: [30, 40], expected: 'high' },
      { field: 'estimatedRecoupmentPct', verified: [50, 60], proposed: [45, 55], expected: 'medium' },
      { field: 'weeklyRunningCost', verified: 1000000, proposed: 400000, expected: 'critical' },
      { field: 'weeklyRunningCost', verified: 1000000, proposed: 650000, expected: 'high' },
      { field: 'recouped', verified: true, proposed: false, expected: 'critical' },
      { field: 'designation', verified: 'Windfall', proposed: 'Flop', expected: 'high' }
    ];

    severityTests.forEach(test => {
      const result = calculateSeverity(test.field, test.verified, test.proposed);
      const pass = result === test.expected ? 'PASS' : 'FAIL';
      console.log(`  [${pass}] ${test.field}: ${result} (expected ${test.expected})`);
    });

    // Test getProtectedShows
    console.log('\n' + '='.repeat(50));
    console.log('Testing getProtectedShows():');

    const mockCommercialData = {
      shows: {
        'death-becomes-her': {
          designation: 'TBD',
          deepResearch: {
            verifiedFields: ['estimatedRecoupmentPct', 'capitalization'],
            verifiedDate: '2026-01-28'
          }
        },
        'hamilton-2015': {
          designation: 'Miracle'
          // No deepResearch - not protected
        },
        'wicked-2003': {
          designation: 'Windfall',
          deepResearch: {
            verifiedFields: ['recouped'],
            verifiedDate: '2026-01-15',
            notes: 'Confirmed recoupment'
          }
        }
      }
    };

    const protectedShows = getProtectedShows(mockCommercialData);
    console.log(`\nFound ${protectedShows.length} protected show(s):`);
    protectedShows.forEach(show => {
      console.log(`  - ${show.slug}: ${show.verifiedFields.join(', ')} (verified ${show.verifiedDate})`);
    });

    console.log('\n' + '='.repeat(50));
    console.log('Test complete!\n');
  } else {
    console.log('Deep Research Guardian Module');
    console.log('==============================');
    console.log('\nUsage: node scripts/lib/deep-research-guardian.js --test');
    console.log('\nExports:');
    console.log('  detectConflict(change, showData) - Detect conflicts with Deep Research data');
    console.log('  calculateSeverity(field, verified, proposed) - Calculate conflict severity');
    console.log('  calculateDiscrepancy(field, verified, proposed) - Format discrepancy description');
    console.log('  shouldBlockChange(conflict) - Determine if change should be blocked');
    console.log('  getProtectedShows(commercialData) - Get all shows with Deep Research protection');
  }
}

module.exports = {
  detectConflict,
  calculateSeverity,
  calculateDiscrepancy,
  shouldBlockChange,
  getProtectedShows
};
