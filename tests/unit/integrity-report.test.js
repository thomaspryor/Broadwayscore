/**
 * Unit tests for generate-integrity-report.js logic
 *
 * Tests the issue detection and report generation logic.
 */

const assert = require('assert');

// ============================================================================
// CONSTANTS (from generate-integrity-report.js)
// ============================================================================

const DEGRADATION_THRESHOLD = 0.05; // 5%
const MAX_HISTORY_WEEKS = 12;

// ============================================================================
// ISSUE DETECTION LOGIC (adapted from generate-integrity-report.js)
// ============================================================================

/**
 * Detect issues by comparing current metrics to previous metrics
 */
function detectIssues(current, previous) {
  const issues = [];

  // Check 1: Review count decrease (more than threshold)
  if (previous && current.totalReviews < previous.totalReviews) {
    const decrease = previous.totalReviews - current.totalReviews;
    const percentDecrease = decrease / previous.totalReviews;

    if (percentDecrease > DEGRADATION_THRESHOLD) {
      issues.push({
        type: 'review_count_decrease',
        severity: 'error',
        message: `Review count decreased by ${decrease} (${(percentDecrease * 100).toFixed(1)}%) from ${previous.totalReviews} to ${current.totalReviews}`
      });
    } else {
      issues.push({
        type: 'review_count_decrease',
        severity: 'warning',
        message: `Review count decreased by ${decrease} (${(percentDecrease * 100).toFixed(1)}%) from ${previous.totalReviews} to ${current.totalReviews}`
      });
    }
  }

  // Check 2: Unknown outlets
  if (current.unknownOutlets > 0) {
    issues.push({
      type: 'unknown_outlets',
      severity: 'error',
      message: `${current.unknownOutlets} reviews have unknown outlets`
    });
  }

  // Check 3: Duplicates
  if (current.duplicates > 0) {
    issues.push({
      type: 'duplicates',
      severity: 'error',
      message: `${current.duplicates} duplicate reviews detected`
    });
  }

  // Check 4: Sync delta
  if (current.syncDelta > 0) {
    // Expected when reviews lack score sources - only warning
    issues.push({
      type: 'sync_delta',
      severity: 'warning',
      message: `review-texts and reviews.json are out of sync by ${current.syncDelta} reviews`
    });
  }

  return issues;
}

/**
 * Determine if any issues are critical
 */
function hasBlockingIssues(issues) {
  return issues.some(issue => issue.severity === 'error');
}

/**
 * Maintain history with max weeks limit
 */
function updateHistory(history, current) {
  const newHistory = {
    weeks: [...(history?.weeks || [])],
  };

  // Check if we already have an entry for today
  const today = current.date;
  const existingIndex = newHistory.weeks.findIndex(w => w.date === today);

  if (existingIndex >= 0) {
    // Update existing entry
    newHistory.weeks[existingIndex] = current;
  } else {
    // Add new entry at the beginning
    newHistory.weeks.unshift(current);
  }

  // Trim to max weeks
  if (newHistory.weeks.length > MAX_HISTORY_WEEKS) {
    newHistory.weeks = newHistory.weeks.slice(0, MAX_HISTORY_WEEKS);
  }

  return newHistory;
}

/**
 * Get the previous week's entry from history
 */
function getPreviousEntry(history, currentDate) {
  if (!history?.weeks || history.weeks.length === 0) {
    return null;
  }

  // Find the most recent entry that's not today
  return history.weeks.find(w => w.date !== currentDate) || null;
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
// detectIssues tests
// ----------------------------------------------------------------------------

console.log('\n=== detectIssues ===\n');

test('returns empty array for perfect metrics with no previous', () => {
  const current = {
    totalReviews: 2000,
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 0
  };

  const issues = detectIssues(current, null);
  assert.strictEqual(issues.length, 0);
});

test('returns empty array for improved metrics', () => {
  const current = {
    totalReviews: 2100,
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 0
  };

  const previous = {
    totalReviews: 2000,
    unknownOutlets: 5,
    duplicates: 3,
    syncDelta: 10
  };

  const issues = detectIssues(current, previous);
  assert.strictEqual(issues.length, 0);
});

test('detects review count decrease as warning (under threshold)', () => {
  const current = {
    totalReviews: 1990,
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 0
  };

  const previous = {
    totalReviews: 2000,
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 0
  };

  const issues = detectIssues(current, previous);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].type, 'review_count_decrease');
  assert.strictEqual(issues[0].severity, 'warning');
});

test('detects review count decrease as error (over threshold)', () => {
  const current = {
    totalReviews: 1800,
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 0
  };

  const previous = {
    totalReviews: 2000,
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 0
  };

  const issues = detectIssues(current, previous);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].type, 'review_count_decrease');
  assert.strictEqual(issues[0].severity, 'error');
  assert.ok(issues[0].message.includes('10.0%'));
});

test('detects unknown outlets as error', () => {
  const current = {
    totalReviews: 2000,
    unknownOutlets: 5,
    duplicates: 0,
    syncDelta: 0
  };

  const issues = detectIssues(current, null);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].type, 'unknown_outlets');
  assert.strictEqual(issues[0].severity, 'error');
  assert.ok(issues[0].message.includes('5'));
});

test('detects duplicates as error', () => {
  const current = {
    totalReviews: 2000,
    unknownOutlets: 0,
    duplicates: 3,
    syncDelta: 0
  };

  const issues = detectIssues(current, null);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].type, 'duplicates');
  assert.strictEqual(issues[0].severity, 'error');
});

test('detects sync delta as warning', () => {
  const current = {
    totalReviews: 2000,
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 15
  };

  const issues = detectIssues(current, null);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].type, 'sync_delta');
  assert.strictEqual(issues[0].severity, 'warning');
});

test('detects multiple issues', () => {
  const current = {
    totalReviews: 2000,
    unknownOutlets: 5,
    duplicates: 3,
    syncDelta: 10
  };

  const issues = detectIssues(current, null);
  assert.strictEqual(issues.length, 3);
  assert.ok(issues.some(i => i.type === 'unknown_outlets'));
  assert.ok(issues.some(i => i.type === 'duplicates'));
  assert.ok(issues.some(i => i.type === 'sync_delta'));
});

// ----------------------------------------------------------------------------
// hasBlockingIssues tests
// ----------------------------------------------------------------------------

console.log('\n=== hasBlockingIssues ===\n');

test('returns false for no issues', () => {
  assert.strictEqual(hasBlockingIssues([]), false);
});

test('returns false for only warnings', () => {
  const issues = [
    { type: 'sync_delta', severity: 'warning' },
    { type: 'review_count_decrease', severity: 'warning' }
  ];
  assert.strictEqual(hasBlockingIssues(issues), false);
});

test('returns true for any error', () => {
  const issues = [
    { type: 'sync_delta', severity: 'warning' },
    { type: 'unknown_outlets', severity: 'error' }
  ];
  assert.strictEqual(hasBlockingIssues(issues), true);
});

test('returns true for only errors', () => {
  const issues = [
    { type: 'duplicates', severity: 'error' }
  ];
  assert.strictEqual(hasBlockingIssues(issues), true);
});

// ----------------------------------------------------------------------------
// updateHistory tests
// ----------------------------------------------------------------------------

console.log('\n=== updateHistory ===\n');

test('creates history from empty', () => {
  const current = {
    date: '2026-01-30',
    totalReviews: 2000
  };

  const history = updateHistory(null, current);
  assert.strictEqual(history.weeks.length, 1);
  assert.strictEqual(history.weeks[0].date, '2026-01-30');
});

test('adds new entry to beginning of history', () => {
  const existing = {
    weeks: [
      { date: '2026-01-23', totalReviews: 1900 }
    ]
  };

  const current = {
    date: '2026-01-30',
    totalReviews: 2000
  };

  const history = updateHistory(existing, current);
  assert.strictEqual(history.weeks.length, 2);
  assert.strictEqual(history.weeks[0].date, '2026-01-30');
  assert.strictEqual(history.weeks[1].date, '2026-01-23');
});

test('updates existing entry for same date', () => {
  const existing = {
    weeks: [
      { date: '2026-01-30', totalReviews: 1950 },
      { date: '2026-01-23', totalReviews: 1900 }
    ]
  };

  const current = {
    date: '2026-01-30',
    totalReviews: 2000
  };

  const history = updateHistory(existing, current);
  assert.strictEqual(history.weeks.length, 2);
  assert.strictEqual(history.weeks[0].totalReviews, 2000);
});

test('trims history to max weeks', () => {
  const existing = {
    weeks: Array.from({ length: 12 }, (_, i) => ({
      date: `2026-01-${String(30 - i * 7).padStart(2, '0')}`,
      totalReviews: 2000 - i * 10
    }))
  };

  const current = {
    date: '2026-02-06',
    totalReviews: 2100
  };

  const history = updateHistory(existing, current);
  assert.strictEqual(history.weeks.length, MAX_HISTORY_WEEKS);
  assert.strictEqual(history.weeks[0].date, '2026-02-06');
});

// ----------------------------------------------------------------------------
// getPreviousEntry tests
// ----------------------------------------------------------------------------

console.log('\n=== getPreviousEntry ===\n');

test('returns null for empty history', () => {
  assert.strictEqual(getPreviousEntry(null, '2026-01-30'), null);
  assert.strictEqual(getPreviousEntry({}, '2026-01-30'), null);
  assert.strictEqual(getPreviousEntry({ weeks: [] }, '2026-01-30'), null);
});

test('returns previous entry skipping current date', () => {
  const history = {
    weeks: [
      { date: '2026-01-30', totalReviews: 2000 },
      { date: '2026-01-23', totalReviews: 1900 }
    ]
  };

  const prev = getPreviousEntry(history, '2026-01-30');
  assert.strictEqual(prev.date, '2026-01-23');
  assert.strictEqual(prev.totalReviews, 1900);
});

test('returns first entry if no current date match', () => {
  const history = {
    weeks: [
      { date: '2026-01-23', totalReviews: 1900 }
    ]
  };

  const prev = getPreviousEntry(history, '2026-01-30');
  assert.strictEqual(prev.date, '2026-01-23');
});

test('returns null if only entry is current date', () => {
  const history = {
    weeks: [
      { date: '2026-01-30', totalReviews: 2000 }
    ]
  };

  const prev = getPreviousEntry(history, '2026-01-30');
  assert.strictEqual(prev, null);
});

// ----------------------------------------------------------------------------
// Edge case tests
// ----------------------------------------------------------------------------

console.log('\n=== Edge cases ===\n');

test('handles exact threshold boundary (5%)', () => {
  const current = {
    totalReviews: 1900,  // exactly 5% decrease
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 0
  };

  const previous = {
    totalReviews: 2000,
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 0
  };

  const issues = detectIssues(current, previous);
  assert.strictEqual(issues.length, 1);
  // At exactly 5%, it's warning (not over threshold)
  assert.strictEqual(issues[0].severity, 'warning');
});

test('handles just over threshold (5.1%)', () => {
  const current = {
    totalReviews: 1898,  // 5.1% decrease
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 0
  };

  const previous = {
    totalReviews: 2000,
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 0
  };

  const issues = detectIssues(current, previous);
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].severity, 'error');
});

test('no issue for review count increase', () => {
  const current = {
    totalReviews: 2100,
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 0
  };

  const previous = {
    totalReviews: 2000,
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 0
  };

  const issues = detectIssues(current, previous);
  assert.strictEqual(issues.length, 0);
});

test('handles zero values gracefully', () => {
  const current = {
    totalReviews: 0,
    unknownOutlets: 0,
    duplicates: 0,
    syncDelta: 0
  };

  // No previous - should not throw
  const issues = detectIssues(current, null);
  assert.ok(Array.isArray(issues));
});

// ----------------------------------------------------------------------------
// Summary
// ----------------------------------------------------------------------------

console.log('\n' + '='.repeat(50));
console.log(`\nResults: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  process.exit(1);
}
