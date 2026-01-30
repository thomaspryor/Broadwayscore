/**
 * Unit tests for validate-review-texts.js validation logic
 *
 * Tests the core validation functions without requiring the full file system.
 */

const assert = require('assert');

// ============================================================================
// GARBAGE CRITIC NAME PATTERNS (copied from validate-review-texts.js)
// ============================================================================

const GARBAGE_PATTERNS = [
  /^photo\s*(credit|by)?/i,
  /^staff$/i,
  /^&nbsp;/,
  /^\s*$/,
  /^unknown$/i,
  /^advertisement$/i,
  /^editorial$/i,
];

function isGarbageCriticName(name) {
  if (!name || typeof name !== 'string') return true;

  const trimmed = name.trim();
  if (!trimmed) return true;

  for (const pattern of GARBAGE_PATTERNS) {
    if (pattern.test(trimmed)) {
      return true;
    }
  }

  return false;
}

// ============================================================================
// OUTLET NORMALIZATION (copied from validate-review-texts.js)
// ============================================================================

function normalizeOutletId(id) {
  if (!id) return null;
  return id.toLowerCase().trim();
}

function generateReviewKey(outletId, outlet, criticName) {
  const normalizedOutlet = normalizeOutletId(outletId) || normalizeOutletId(outlet) || 'unknown';
  const normalizedCritic = (criticName || 'unknown').toLowerCase().trim().replace(/\s+/g, '-');
  return `${normalizedOutlet}::${normalizedCritic}`;
}

// ============================================================================
// TESTS
// ============================================================================

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

// ----------------------------------------------------------------------------
// isGarbageCriticName tests
// ----------------------------------------------------------------------------

console.log('\n=== isGarbageCriticName ===\n');

test('returns true for null', () => {
  assert.strictEqual(isGarbageCriticName(null), true);
});

test('returns true for undefined', () => {
  assert.strictEqual(isGarbageCriticName(undefined), true);
});

test('returns true for empty string', () => {
  assert.strictEqual(isGarbageCriticName(''), true);
});

test('returns true for whitespace only', () => {
  assert.strictEqual(isGarbageCriticName('   '), true);
});

test('returns true for "Photo Credit"', () => {
  assert.strictEqual(isGarbageCriticName('Photo Credit'), true);
});

test('returns true for "photo by"', () => {
  assert.strictEqual(isGarbageCriticName('photo by'), true);
});

test('returns true for "PHOTO"', () => {
  assert.strictEqual(isGarbageCriticName('PHOTO'), true);
});

test('returns true for "Staff"', () => {
  assert.strictEqual(isGarbageCriticName('Staff'), true);
});

test('returns true for "STAFF"', () => {
  assert.strictEqual(isGarbageCriticName('STAFF'), true);
});

test('returns true for "&nbsp;Name"', () => {
  assert.strictEqual(isGarbageCriticName('&nbsp;Name'), true);
});

test('returns true for "Unknown"', () => {
  assert.strictEqual(isGarbageCriticName('Unknown'), true);
});

test('returns true for "UNKNOWN"', () => {
  assert.strictEqual(isGarbageCriticName('UNKNOWN'), true);
});

test('returns true for "Advertisement"', () => {
  assert.strictEqual(isGarbageCriticName('Advertisement'), true);
});

test('returns true for "Editorial"', () => {
  assert.strictEqual(isGarbageCriticName('Editorial'), true);
});

test('returns false for valid name "Jesse Green"', () => {
  assert.strictEqual(isGarbageCriticName('Jesse Green'), false);
});

test('returns false for valid name "Ben Brantley"', () => {
  assert.strictEqual(isGarbageCriticName('Ben Brantley'), false);
});

test('returns false for valid name "Laura Collins-Hughes"', () => {
  assert.strictEqual(isGarbageCriticName('Laura Collins-Hughes'), false);
});

test('returns false for name with numbers "Johnny O\'Sullivan Jr. III"', () => {
  assert.strictEqual(isGarbageCriticName("Johnny O'Sullivan Jr. III"), false);
});

test('returns true for non-string input (number)', () => {
  assert.strictEqual(isGarbageCriticName(123), true);
});

test('returns true for non-string input (object)', () => {
  assert.strictEqual(isGarbageCriticName({}), true);
});

// ----------------------------------------------------------------------------
// normalizeOutletId tests
// ----------------------------------------------------------------------------

console.log('\n=== normalizeOutletId ===\n');

test('returns null for null input', () => {
  assert.strictEqual(normalizeOutletId(null), null);
});

test('returns null for undefined input', () => {
  assert.strictEqual(normalizeOutletId(undefined), null);
});

test('returns null for empty string', () => {
  assert.strictEqual(normalizeOutletId(''), null);
});

test('lowercases "NYTIMES" to "nytimes"', () => {
  assert.strictEqual(normalizeOutletId('NYTIMES'), 'nytimes');
});

test('lowercases "NYTimes" to "nytimes"', () => {
  assert.strictEqual(normalizeOutletId('NYTimes'), 'nytimes');
});

test('trims whitespace " nytimes " to "nytimes"', () => {
  assert.strictEqual(normalizeOutletId(' nytimes '), 'nytimes');
});

test('handles mixed case "The Hollywood Reporter"', () => {
  assert.strictEqual(normalizeOutletId('The Hollywood Reporter'), 'the hollywood reporter');
});

// ----------------------------------------------------------------------------
// generateReviewKey tests
// ----------------------------------------------------------------------------

console.log('\n=== generateReviewKey ===\n');

test('generates key from outletId and criticName', () => {
  assert.strictEqual(
    generateReviewKey('nytimes', null, 'Jesse Green'),
    'nytimes::jesse-green'
  );
});

test('falls back to outlet when outletId is null', () => {
  assert.strictEqual(
    generateReviewKey(null, 'The New York Times', 'Jesse Green'),
    'the new york times::jesse-green'
  );
});

test('prefers outletId over outlet when both present', () => {
  assert.strictEqual(
    generateReviewKey('nytimes', 'The New York Times', 'Jesse Green'),
    'nytimes::jesse-green'
  );
});

test('uses "unknown" for missing outlet', () => {
  assert.strictEqual(
    generateReviewKey(null, null, 'Jesse Green'),
    'unknown::jesse-green'
  );
});

test('uses "unknown" for missing critic', () => {
  assert.strictEqual(
    generateReviewKey('nytimes', null, null),
    'nytimes::unknown'
  );
});

test('normalizes critic name with multiple spaces', () => {
  // Multiple spaces get collapsed to single dash
  assert.strictEqual(
    generateReviewKey('nytimes', null, 'Laura  Collins  Hughes'),
    'nytimes::laura-collins-hughes'
  );
});

test('lowercases everything', () => {
  assert.strictEqual(
    generateReviewKey('NYTimes', null, 'JESSE GREEN'),
    'nytimes::jesse-green'
  );
});

// ----------------------------------------------------------------------------
// Integration tests - mock file validation
// ----------------------------------------------------------------------------

console.log('\n=== File validation logic ===\n');

function validateReviewData(data, validOutlets, seenReviews, showId) {
  const errors = [];

  // Check 1: Required fields
  if (!data.showId) {
    errors.push({ check: 'required_fields', message: 'Missing showId' });
  }

  if (!data.outletId && !data.outlet) {
    errors.push({ check: 'required_fields', message: 'Missing outlet' });
  }

  // Check 2: Unknown outlets
  const outletId = normalizeOutletId(data.outletId);
  if (outletId && !validOutlets.has(outletId)) {
    errors.push({ check: 'unknown_outlet', message: `Unknown outlet: ${outletId}` });
  }

  // Check 3: Garbage critic names
  if (isGarbageCriticName(data.criticName)) {
    errors.push({ check: 'garbage_critic', message: `Garbage critic: ${data.criticName}` });
  }

  // Check 4: Duplicates
  const key = generateReviewKey(data.outletId, data.outlet, data.criticName);
  const fullKey = `${showId}::${key}`;
  if (seenReviews.has(fullKey)) {
    errors.push({ check: 'duplicate', message: `Duplicate: ${key}` });
  }
  seenReviews.add(fullKey);

  return errors;
}

test('valid review passes all checks', () => {
  const validOutlets = new Set(['nytimes', 'vulture', 'variety']);
  const seenReviews = new Set();

  const errors = validateReviewData({
    showId: 'hamilton-2015',
    outletId: 'nytimes',
    outlet: 'The New York Times',
    criticName: 'Jesse Green'
  }, validOutlets, seenReviews, 'hamilton-2015');

  assert.strictEqual(errors.length, 0, `Expected 0 errors, got: ${JSON.stringify(errors)}`);
});

test('missing showId is an error', () => {
  const validOutlets = new Set(['nytimes']);
  const seenReviews = new Set();

  const errors = validateReviewData({
    outletId: 'nytimes',
    criticName: 'Jesse Green'
  }, validOutlets, seenReviews, 'test-show');

  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].check, 'required_fields');
});

test('missing outlet and outletId is an error', () => {
  const validOutlets = new Set(['nytimes']);
  const seenReviews = new Set();

  const errors = validateReviewData({
    showId: 'hamilton-2015',
    criticName: 'Jesse Green'
  }, validOutlets, seenReviews, 'hamilton-2015');

  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].check, 'required_fields');
});

test('unknown outlet is an error', () => {
  const validOutlets = new Set(['nytimes', 'vulture']);
  const seenReviews = new Set();

  const errors = validateReviewData({
    showId: 'hamilton-2015',
    outletId: 'fake-outlet',
    criticName: 'Jesse Green'
  }, validOutlets, seenReviews, 'hamilton-2015');

  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].check, 'unknown_outlet');
});

test('garbage critic name is an error', () => {
  const validOutlets = new Set(['nytimes']);
  const seenReviews = new Set();

  const errors = validateReviewData({
    showId: 'hamilton-2015',
    outletId: 'nytimes',
    criticName: 'Photo Credit'
  }, validOutlets, seenReviews, 'hamilton-2015');

  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].check, 'garbage_critic');
});

test('duplicate review is an error', () => {
  const validOutlets = new Set(['nytimes']);
  const seenReviews = new Set();

  // First review - should pass
  const errors1 = validateReviewData({
    showId: 'hamilton-2015',
    outletId: 'nytimes',
    criticName: 'Jesse Green'
  }, validOutlets, seenReviews, 'hamilton-2015');

  assert.strictEqual(errors1.length, 0);

  // Second review with same outlet+critic - should fail
  const errors2 = validateReviewData({
    showId: 'hamilton-2015',
    outletId: 'nytimes',
    criticName: 'Jesse Green'
  }, validOutlets, seenReviews, 'hamilton-2015');

  assert.strictEqual(errors2.length, 1);
  assert.strictEqual(errors2[0].check, 'duplicate');
});

test('same critic at different outlets is not duplicate', () => {
  const validOutlets = new Set(['nytimes', 'vulture']);
  const seenReviews = new Set();

  const errors1 = validateReviewData({
    showId: 'hamilton-2015',
    outletId: 'nytimes',
    criticName: 'Jesse Green'
  }, validOutlets, seenReviews, 'hamilton-2015');

  const errors2 = validateReviewData({
    showId: 'hamilton-2015',
    outletId: 'vulture',
    criticName: 'Jesse Green'
  }, validOutlets, seenReviews, 'hamilton-2015');

  assert.strictEqual(errors1.length, 0);
  assert.strictEqual(errors2.length, 0);
});

test('same outlet+critic at different shows is not duplicate', () => {
  const validOutlets = new Set(['nytimes']);
  const seenReviews = new Set();

  const errors1 = validateReviewData({
    showId: 'hamilton-2015',
    outletId: 'nytimes',
    criticName: 'Jesse Green'
  }, validOutlets, seenReviews, 'hamilton-2015');

  const errors2 = validateReviewData({
    showId: 'wicked-2003',
    outletId: 'nytimes',
    criticName: 'Jesse Green'
  }, validOutlets, seenReviews, 'wicked-2003');

  assert.strictEqual(errors1.length, 0);
  assert.strictEqual(errors2.length, 0);
});

test('multiple errors can be reported', () => {
  const validOutlets = new Set(['nytimes']);
  const seenReviews = new Set();

  const errors = validateReviewData({
    // Missing showId
    outletId: 'fake-outlet',  // Unknown outlet
    criticName: 'Staff'  // Garbage name
  }, validOutlets, seenReviews, 'test-show');

  assert.strictEqual(errors.length, 3);
  assert.ok(errors.some(e => e.check === 'required_fields'));
  assert.ok(errors.some(e => e.check === 'unknown_outlet'));
  assert.ok(errors.some(e => e.check === 'garbage_critic'));
});

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------

console.log('\n' + '='.repeat(50));
console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
