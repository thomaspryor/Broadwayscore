#!/usr/bin/env node
/**
 * Source Validator Module
 *
 * Multi-source validation framework for cross-referencing changes.
 * Used by update-commercial-data.js to validate proposed changes against
 * multiple data sources before applying.
 *
 * Usage:
 *   const { validateChange, SOURCE_WEIGHTS, findCorroboration, calculateConfidence } = require('./lib/source-validator');
 *   const validated = validateChange(change, allSources);
 *
 * CLI Test Mode:
 *   node scripts/lib/source-validator.js --test
 */

/**
 * Source weights for credibility scoring.
 * Higher weights indicate more authoritative sources.
 * Scale: 0.0 (least credible) to 1.2 (most credible)
 */
const SOURCE_WEIGHTS = {
  'Deep Research': 1.2,        // Manually verified through extensive research - highest authority
  'SEC Form D': 1.0,           // Official government filing
  'Deadline': 0.9,             // Major entertainment trade publication
  'Variety': 0.9,              // Major entertainment trade publication
  'New York Times': 0.85,      // Respected newspaper with editorial standards
  'Broadway Journal': 0.8,     // Broadway-focused trade publication
  'Playbill': 0.75,            // Broadway industry publication
  'Reddit Grosses Analysis': 0.7,  // Structured analysis with methodology
  'Reddit comment': 0.4,       // Single user comment - low credibility
  'estimate': 0.3              // Unattributed estimate - lowest credibility
};

/**
 * Methodology compatibility matrix.
 * Defines which cost methodologies can be meaningfully compared.
 * 'all' means compatible with all methodologies.
 */
const METHODOLOGY_COMPATIBILITY = {
  'reddit-standard': ['reddit-standard'],  // Reddit methodology only compares to itself
  'trade-reported': ['trade-reported', 'sec-filing', 'producer-confirmed', 'deep-research'],
  'sec-filing': ['trade-reported', 'sec-filing', 'producer-confirmed', 'deep-research'],
  'producer-confirmed': ['trade-reported', 'sec-filing', 'producer-confirmed', 'deep-research'],
  'deep-research': 'all',  // Deep Research compares to everything
  'industry-estimate': ['industry-estimate']  // Industry estimates only compare to themselves
};

/**
 * Check if two methodologies can be meaningfully compared.
 *
 * @param {string} methodology1 - First methodology
 * @param {string} methodology2 - Second methodology
 * @returns {boolean} True if methodologies can be compared
 */
function methodologiesAreComparable(methodology1, methodology2) {
  // If either is missing, assume comparable (backward compatibility)
  if (!methodology1 || !methodology2) return true;

  // If either is 'all', they're compatible
  const compat1 = METHODOLOGY_COMPATIBILITY[methodology1];
  const compat2 = METHODOLOGY_COMPATIBILITY[methodology2];

  if (compat1 === 'all' || compat2 === 'all') return true;

  // Check if either lists the other as compatible
  if (Array.isArray(compat1) && compat1.includes(methodology2)) return true;
  if (Array.isArray(compat2) && compat2.includes(methodology1)) return true;

  return false;
}

/**
 * Manual override slugs that bypass validation.
 * Use sparingly for shows where we have confirmed data through other means.
 */
const OVERRIDE_SLUGS = [
  // Add show slugs here that should bypass validation
  // e.g., 'hamilton-2015' if we have confirmed SEC filing data
];

/**
 * Find corroborating and contradicting sources for a proposed change.
 *
 * @param {Object} change - Proposed change object
 * @param {string} change.showSlug - Show identifier
 * @param {string} change.field - Field being changed (e.g., 'capitalization')
 * @param {*} change.newValue - Proposed new value
 * @param {Array} sources - Array of source objects
 * @param {string} sources[].showSlug - Show identifier
 * @param {string} sources[].field - Field name
 * @param {*} sources[].value - Value from this source
 * @param {string} sources[].sourceType - Type of source (key in SOURCE_WEIGHTS)
 * @param {string} sources[].methodology - Optional methodology for cost data
 * @param {string} [changeMethodology=null] - Methodology of the proposed change (for cost fields)
 * @returns {Object} { supporting: Source[], contradicting: Source[] }
 */
function findCorroboration(change, sources, changeMethodology = null) {
  const supporting = [];
  const contradicting = [];

  if (!sources || !Array.isArray(sources)) {
    return { supporting, contradicting };
  }

  for (const source of sources) {
    // Match by show slug and field
    if (source.showSlug !== change.showSlug || source.field !== change.field) {
      continue;
    }

    // Skip if same source as the change itself (don't self-corroborate)
    if (source.sourceType === change.sourceType && source.url === change.sourceUrl) {
      continue;
    }

    // Skip if methodologies are incompatible for cost-related fields
    if (['weeklyRunningCost', 'capitalization'].includes(change.field)) {
      if (!methodologiesAreComparable(changeMethodology, source.methodology)) {
        continue;  // Skip - incompatible methodologies
      }
    }

    // Compare values
    const isSupporting = valuesMatch(change.newValue, source.value);

    if (isSupporting) {
      supporting.push(source);
    } else if (source.value !== null && source.value !== undefined) {
      // Only count as contradicting if source has a concrete value
      contradicting.push(source);
    }
  }

  return { supporting, contradicting };
}

/**
 * Check if two values match, with numeric tolerance for financial data.
 * Numeric values within 10% of each other are considered matching.
 *
 * @param {*} value1 - First value
 * @param {*} value2 - Second value
 * @returns {boolean} True if values match
 */
function valuesMatch(value1, value2) {
  // Handle null/undefined
  if (value1 == null || value2 == null) {
    return value1 == value2;
  }

  // Handle numeric comparison with 10% tolerance
  if (typeof value1 === 'number' && typeof value2 === 'number') {
    const larger = Math.max(Math.abs(value1), Math.abs(value2));
    if (larger === 0) {
      return value1 === value2;
    }
    const difference = Math.abs(value1 - value2);
    const percentDiff = difference / larger;
    return percentDiff <= 0.10; // Within 10%
  }

  // Handle array comparison (e.g., estimatedRecoupmentPct ranges)
  if (Array.isArray(value1) && Array.isArray(value2)) {
    if (value1.length !== value2.length) {
      return false;
    }
    return value1.every((v, i) => valuesMatch(v, value2[i]));
  }

  // Handle string comparison (case-insensitive for designations)
  if (typeof value1 === 'string' && typeof value2 === 'string') {
    return value1.toLowerCase() === value2.toLowerCase();
  }

  // Default strict equality
  return value1 === value2;
}

/**
 * Calculate validated confidence level based on corroboration.
 *
 * Rules:
 * - 2+ supporting sources -> 'high'
 * - contradicting > supporting -> 'flagged'
 * - Otherwise -> original confidence
 *
 * @param {string} originalConfidence - Original confidence level ('high', 'medium', 'low')
 * @param {number} supportingCount - Number of supporting sources
 * @param {number} contradictingCount - Number of contradicting sources
 * @returns {string} Validated confidence level
 */
function calculateConfidence(originalConfidence, supportingCount, contradictingCount) {
  // Rule 1: 2+ supporting sources = high confidence
  if (supportingCount >= 2) {
    return 'high';
  }

  // Rule 2: More contradicting than supporting = flagged
  if (contradictingCount > supportingCount) {
    return 'flagged';
  }

  // Rule 3: Otherwise, keep original confidence
  return originalConfidence;
}

/**
 * Validate a proposed change against all available sources.
 *
 * @param {Object} change - Proposed change object
 * @param {string} change.showSlug - Show identifier
 * @param {string} change.field - Field being changed
 * @param {*} change.newValue - Proposed new value
 * @param {*} change.oldValue - Current value
 * @param {string} change.confidence - Original confidence level
 * @param {string} [change.sourceType] - Type of source for this change
 * @param {string} [change.sourceUrl] - URL of source for this change
 * @param {Array} allSources - All available source data
 * @returns {Object} Validated change with additional fields
 */
function validateChange(change, allSources) {
  // Check for manual override
  if (OVERRIDE_SLUGS.includes(change.showSlug)) {
    return {
      ...change,
      validatedConfidence: change.confidence,
      supportingSources: [],
      contradictingSources: [],
      validationNotes: 'Manual override - validation bypassed'
    };
  }

  // Find corroborating sources
  const { supporting, contradicting } = findCorroboration(change, allSources);

  // Calculate validated confidence
  const validatedConfidence = calculateConfidence(
    change.confidence,
    supporting.length,
    contradicting.length
  );

  // Build validation notes
  const notes = [];
  if (supporting.length > 0) {
    notes.push(`${supporting.length} supporting source(s): ${supporting.map(s => s.sourceType).join(', ')}`);
  }
  if (contradicting.length > 0) {
    notes.push(`${contradicting.length} contradicting source(s): ${contradicting.map(s => s.sourceType).join(', ')}`);
  }
  if (validatedConfidence !== change.confidence) {
    notes.push(`Confidence adjusted: ${change.confidence} -> ${validatedConfidence}`);
  }

  return {
    ...change,
    validatedConfidence,
    supportingSources: supporting,
    contradictingSources: contradicting,
    validationNotes: notes.length > 0 ? notes.join('; ') : 'No corroborating sources found'
  };
}

/**
 * Get the weight for a source type.
 * Returns 0.5 (neutral weight) for unknown source types.
 *
 * @param {string} sourceType - Type of source
 * @returns {number} Weight between 0 and 1
 */
function getSourceWeight(sourceType) {
  return SOURCE_WEIGHTS[sourceType] || 0.5;
}

// CLI test mode
if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--test')) {
    console.log('Source Validator - Test Mode\n');
    console.log('='.repeat(50));

    // Display SOURCE_WEIGHTS
    console.log('\nSOURCE_WEIGHTS:');
    Object.entries(SOURCE_WEIGHTS)
      .sort((a, b) => b[1] - a[1])
      .forEach(([source, weight]) => {
        console.log(`  ${source.padEnd(25)} ${weight.toFixed(2)}`);
      });

    // Display METHODOLOGY_COMPATIBILITY
    console.log('\n' + '='.repeat(50));
    console.log('METHODOLOGY_COMPATIBILITY:');
    Object.entries(METHODOLOGY_COMPATIBILITY).forEach(([methodology, compatible]) => {
      const compatStr = compatible === 'all' ? 'all' : compatible.join(', ');
      console.log(`  ${methodology.padEnd(20)} -> ${compatStr}`);
    });

    // Test methodologiesAreComparable
    console.log('\n' + '='.repeat(50));
    console.log('Testing methodologiesAreComparable():');

    const methodologyTestCases = [
      { m1: 'reddit-standard', m2: 'reddit-standard', expected: true },
      { m1: 'reddit-standard', m2: 'trade-reported', expected: false },
      { m1: 'trade-reported', m2: 'sec-filing', expected: true },
      { m1: 'deep-research', m2: 'reddit-standard', expected: true },  // deep-research is 'all'
      { m1: 'industry-estimate', m2: 'trade-reported', expected: false },
      { m1: null, m2: 'trade-reported', expected: true },  // Backward compatibility
      { m1: 'unknown', m2: 'trade-reported', expected: false }  // Unknown methodology
    ];

    methodologyTestCases.forEach(tc => {
      const result = methodologiesAreComparable(tc.m1, tc.m2);
      const pass = result === tc.expected ? 'PASS' : 'FAIL';
      console.log(`  [${pass}] (${tc.m1 || 'null'}, ${tc.m2 || 'null'}) -> ${result}`);
    });

    // Test findCorroboration
    console.log('\n' + '='.repeat(50));
    console.log('Testing findCorroboration():');

    const mockChange = {
      showSlug: 'hamilton-2015',
      field: 'capitalization',
      newValue: 20000000,
      confidence: 'medium',
      sourceType: 'Deadline',
      sourceUrl: 'https://deadline.com/article1'
    };

    const mockSources = [
      { showSlug: 'hamilton-2015', field: 'capitalization', value: 19500000, sourceType: 'Variety' },
      { showSlug: 'hamilton-2015', field: 'capitalization', value: 21000000, sourceType: 'New York Times' },
      { showSlug: 'hamilton-2015', field: 'capitalization', value: 15000000, sourceType: 'Reddit comment' },
      { showSlug: 'wicked-2003', field: 'capitalization', value: 20000000, sourceType: 'Playbill' }  // Different show
    ];

    console.log('\nProposed change:');
    console.log(`  Show: ${mockChange.showSlug}`);
    console.log(`  Field: ${mockChange.field}`);
    console.log(`  New Value: $${mockChange.newValue.toLocaleString()}`);
    console.log(`  Original Confidence: ${mockChange.confidence}`);

    console.log('\nAvailable sources:');
    mockSources.forEach(s => {
      console.log(`  ${s.showSlug}: $${s.value.toLocaleString()} (${s.sourceType})`);
    });

    const corroboration = findCorroboration(mockChange, mockSources);
    console.log('\nCorroboration results:');
    console.log(`  Supporting (within 10%): ${corroboration.supporting.length}`);
    corroboration.supporting.forEach(s => {
      console.log(`    - ${s.sourceType}: $${s.value.toLocaleString()}`);
    });
    console.log(`  Contradicting: ${corroboration.contradicting.length}`);
    corroboration.contradicting.forEach(s => {
      console.log(`    - ${s.sourceType}: $${s.value.toLocaleString()}`);
    });

    // Test calculateConfidence
    console.log('\n' + '='.repeat(50));
    console.log('Testing calculateConfidence():');

    const testCases = [
      { original: 'medium', supporting: 2, contradicting: 0, expected: 'high' },
      { original: 'medium', supporting: 1, contradicting: 0, expected: 'medium' },
      { original: 'medium', supporting: 0, contradicting: 2, expected: 'flagged' },
      { original: 'high', supporting: 1, contradicting: 1, expected: 'high' },
      { original: 'low', supporting: 0, contradicting: 0, expected: 'low' }
    ];

    testCases.forEach(tc => {
      const result = calculateConfidence(tc.original, tc.supporting, tc.contradicting);
      const pass = result === tc.expected ? 'PASS' : 'FAIL';
      console.log(`  [${pass}] (${tc.original}, ${tc.supporting} support, ${tc.contradicting} contradict) -> ${result}`);
    });

    // Test validateChange
    console.log('\n' + '='.repeat(50));
    console.log('Testing validateChange():');

    const validated = validateChange(mockChange, mockSources);
    console.log('\nValidated change:');
    console.log(`  Show: ${validated.showSlug}`);
    console.log(`  Field: ${validated.field}`);
    console.log(`  New Value: $${validated.newValue.toLocaleString()}`);
    console.log(`  Original Confidence: ${validated.confidence}`);
    console.log(`  Validated Confidence: ${validated.validatedConfidence}`);
    console.log(`  Supporting Sources: ${validated.supportingSources.length}`);
    console.log(`  Contradicting Sources: ${validated.contradictingSources.length}`);
    console.log(`  Notes: ${validated.validationNotes}`);

    console.log('\n' + '='.repeat(50));
    console.log('Test complete!\n');
  } else {
    console.log('Usage: node scripts/lib/source-validator.js --test');
    console.log('\nExports:');
    console.log('  validateChange(change, allSources) - Main validation function');
    console.log('  SOURCE_WEIGHTS - Object with source credibility weights');
    console.log('  METHODOLOGY_COMPATIBILITY - Matrix of comparable methodologies');
    console.log('  findCorroboration(change, sources, methodology) - Find supporting/contradicting sources');
    console.log('  calculateConfidence(original, supportCount, contradictCount) - Calculate confidence');
    console.log('  OVERRIDE_SLUGS - Array of slugs that bypass validation');
    console.log('  getSourceWeight(sourceType) - Get weight for a source type');
    console.log('  methodologiesAreComparable(m1, m2) - Check if methodologies can be compared');
  }
}

module.exports = {
  validateChange,
  SOURCE_WEIGHTS,
  METHODOLOGY_COMPATIBILITY,
  findCorroboration,
  calculateConfidence,
  OVERRIDE_SLUGS,
  getSourceWeight,
  valuesMatch,  // Exported for testing
  methodologiesAreComparable
};
