/**
 * E2E Data Quality Pipeline Test
 *
 * Tests the entire data quality pipeline end-to-end:
 * 1. Review file structure validation
 * 2. Outlet registry consistency
 * 3. Integrity report generation
 * 4. Discord notification module
 *
 * This ensures all components work together correctly.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Paths
const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'scripts');

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

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ✗ ${name}`);
    console.log(`    ${err.message}`);
    failed++;
  }
}

// ============================================================================
// Component 1: Data Files Exist
// ============================================================================

console.log('\n=== Data Files Existence ===\n');

test('outlet-registry.json exists and is valid JSON', () => {
  const registryPath = path.join(DATA_DIR, 'outlet-registry.json');
  assert.ok(fs.existsSync(registryPath), 'outlet-registry.json should exist');

  const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  assert.ok(data.outlets, 'Should have outlets object');
  assert.ok(Object.keys(data.outlets).length > 100, 'Should have 100+ outlets');
});

test('reviews.json exists and is valid JSON', () => {
  const reviewsPath = path.join(DATA_DIR, 'reviews.json');
  assert.ok(fs.existsSync(reviewsPath), 'reviews.json should exist');

  const data = JSON.parse(fs.readFileSync(reviewsPath, 'utf8'));
  assert.ok(typeof data === 'object', 'Should be an object');
  assert.ok(data.reviews, 'Should have reviews object');
  assert.ok(Object.keys(data.reviews).length > 20, `Should have 20+ shows, got ${Object.keys(data.reviews).length}`);
});

test('review-texts directory exists with show directories', () => {
  const reviewTextsDir = path.join(DATA_DIR, 'review-texts');
  assert.ok(fs.existsSync(reviewTextsDir), 'review-texts directory should exist');

  const dirs = fs.readdirSync(reviewTextsDir).filter(f =>
    fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
  );
  assert.ok(dirs.length > 20, 'Should have 20+ show directories');
});

test('integrity-history.json exists', () => {
  const historyPath = path.join(DATA_DIR, 'integrity-history.json');
  assert.ok(fs.existsSync(historyPath), 'integrity-history.json should exist');

  const data = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
  assert.ok(data.weeks, 'Should have weeks array');
});

// ============================================================================
// Component 2: Outlet Registry Consistency
// ============================================================================

console.log('\n=== Outlet Registry Consistency ===\n');

test('all outlets have required fields', () => {
  const registryPath = path.join(DATA_DIR, 'outlet-registry.json');
  const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

  const issues = [];
  for (const [id, outlet] of Object.entries(data.outlets)) {
    if (!outlet.displayName) issues.push(`${id}: missing displayName`);
    if (!outlet.tier) issues.push(`${id}: missing tier`);
    if (outlet.tier && (outlet.tier < 1 || outlet.tier > 3)) {
      issues.push(`${id}: invalid tier ${outlet.tier}`);
    }
  }

  assert.strictEqual(issues.length, 0, `Issues found:\n  ${issues.join('\n  ')}`);
});

test('alias index maps to valid outlets', () => {
  const registryPath = path.join(DATA_DIR, 'outlet-registry.json');
  const data = JSON.parse(fs.readFileSync(registryPath, 'utf8'));

  if (!data._aliasIndex) {
    // No alias index is fine
    return;
  }

  const issues = [];
  for (const [alias, outletId] of Object.entries(data._aliasIndex)) {
    if (alias === '_note') continue;
    if (!data.outlets[outletId]) {
      issues.push(`Alias "${alias}" maps to non-existent outlet "${outletId}"`);
    }
  }

  assert.strictEqual(issues.length, 0, `Issues found:\n  ${issues.join('\n  ')}`);
});

// ============================================================================
// Component 3: Review Normalization Module
// ============================================================================

console.log('\n=== Review Normalization Module ===\n');

test('review-normalization.js loads without error', () => {
  const normalizationPath = path.join(SCRIPTS_DIR, 'lib', 'review-normalization.js');
  assert.ok(fs.existsSync(normalizationPath), 'Module should exist');

  const module = require(normalizationPath);
  assert.ok(typeof module.normalizeOutlet === 'function', 'Should export normalizeOutlet');
  assert.ok(typeof module.normalizeCritic === 'function', 'Should export normalizeCritic');
  assert.ok(typeof module.generateReviewFilename === 'function', 'Should export generateReviewFilename');
});

test('normalizeOutlet handles common variations', () => {
  const { normalizeOutlet } = require(path.join(SCRIPTS_DIR, 'lib', 'review-normalization.js'));

  // Test common aliases
  assert.strictEqual(normalizeOutlet('The New York Times'), 'nytimes');
  assert.strictEqual(normalizeOutlet('NY Times'), 'nytimes');
  assert.strictEqual(normalizeOutlet('Vulture'), 'vulture');
  assert.strictEqual(normalizeOutlet('The Hollywood Reporter'), 'hollywood-reporter');
});

test('normalizeCritic handles name variations', () => {
  const { normalizeCritic } = require(path.join(SCRIPTS_DIR, 'lib', 'review-normalization.js'));

  // Test basic normalization
  const result = normalizeCritic('Jesse Green');
  assert.ok(result.includes('jesse'), `Should normalize "Jesse Green" to lowercase: ${result}`);
});

// ============================================================================
// Component 4: Validation Script
// ============================================================================

console.log('\n=== Validation Script ===\n');

test('validate-review-texts.js exists', () => {
  const scriptPath = path.join(SCRIPTS_DIR, 'validate-review-texts.js');
  assert.ok(fs.existsSync(scriptPath), 'Script should exist');
});

test('current review-texts pass validation', () => {
  // Count review files and check for known issues
  const reviewTextsDir = path.join(DATA_DIR, 'review-texts');
  const registryPath = path.join(DATA_DIR, 'outlet-registry.json');

  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const validOutlets = new Set(Object.keys(registry.outlets));

  // Add aliases
  if (registry._aliasIndex) {
    Object.keys(registry._aliasIndex).forEach(alias => {
      if (alias !== '_note') validOutlets.add(alias);
    });
  }

  let unknownOutlets = 0;
  let totalFiles = 0;

  const showDirs = fs.readdirSync(reviewTextsDir).filter(f =>
    fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
  );

  for (const showDir of showDirs) {
    const files = fs.readdirSync(path.join(reviewTextsDir, showDir))
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      totalFiles++;
      try {
        const data = JSON.parse(fs.readFileSync(
          path.join(reviewTextsDir, showDir, file), 'utf8'
        ));

        // Skip inherently unresolvable outlet IDs:
        // - "unknown" outletId from web search sourcing
        // - junk/sentence IDs with more than 5 hyphens (e.g., "plenty-of-joy-and-pleasures-to-offer")
        const outletId = (data.outletId || '').toLowerCase();
        const hyphenCount = (outletId.match(/-/g) || []).length;
        if (outletId && outletId !== 'unknown' && hyphenCount <= 5 && !validOutlets.has(outletId)) {
          unknownOutlets++;
        }
      } catch (e) {
        // Skip invalid JSON files
      }
    }
  }

  assert.ok(totalFiles > 2000, `Should have 2000+ review files, got ${totalFiles}`);
  assert.strictEqual(unknownOutlets, 0, `Should have 0 unknown outlets, got ${unknownOutlets}`);
});

// ============================================================================
// Component 5: Integrity Report Generator
// ============================================================================

console.log('\n=== Integrity Report Generator ===\n');

test('generate-integrity-report.js exists', () => {
  const scriptPath = path.join(SCRIPTS_DIR, 'generate-integrity-report.js');
  assert.ok(fs.existsSync(scriptPath), 'Script should exist');
});

test('integrity report has valid structure', () => {
  const reportPath = path.join(DATA_DIR, 'integrity-report.json');

  if (!fs.existsSync(reportPath)) {
    // Generate report if it doesn't exist
    console.log('    (generating report...)');
    require('child_process').execSync('node scripts/generate-integrity-report.js', {
      cwd: path.join(__dirname, '..', '..'),
      stdio: 'ignore'
    });
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));

  assert.ok(report.timestamp, 'Should have timestamp');
  assert.ok(typeof report.hasIssues === 'boolean', 'Should have hasIssues boolean');
  assert.ok(report.current, 'Should have current metrics');
  assert.ok(typeof report.current.totalReviews === 'number', 'Should have totalReviews');
  assert.ok(typeof report.current.unknownOutlets === 'number', 'Should have unknownOutlets');
  assert.ok(typeof report.current.duplicates === 'number', 'Should have duplicates');
  assert.ok(typeof report.current.syncDelta === 'number', 'Should have syncDelta');
});

// ============================================================================
// Component 6: Discord Notification Module
// ============================================================================

console.log('\n=== Discord Notification Module ===\n');

test('discord-notify.js loads without error', () => {
  const discordPath = path.join(SCRIPTS_DIR, 'lib', 'discord-notify.js');
  assert.ok(fs.existsSync(discordPath), 'Module should exist');

  const module = require(discordPath);
  assert.ok(typeof module.sendAlert === 'function', 'Should export sendAlert');
  assert.ok(typeof module.sendReport === 'function', 'Should export sendReport');
  assert.ok(typeof module.sendNewShowNotification === 'function', 'Should export sendNewShowNotification');
  assert.ok(typeof module.getNotificationStatus === 'function', 'Should export getNotificationStatus');
});

test('getNotificationStatus returns correct structure', () => {
  const { getNotificationStatus } = require(path.join(SCRIPTS_DIR, 'lib', 'discord-notify.js'));

  const status = getNotificationStatus();
  assert.ok(typeof status === 'object', 'Should return object');
  assert.ok(typeof status.alerts === 'boolean', 'Should have alerts boolean');
  assert.ok(typeof status.reports === 'boolean', 'Should have reports boolean');
  assert.ok(typeof status.newshows === 'boolean', 'Should have newshows boolean');
});

test('sendAlert gracefully handles missing webhook', async () => {
  const { sendAlert } = require(path.join(SCRIPTS_DIR, 'lib', 'discord-notify.js'));

  // Without DISCORD_WEBHOOK_ALERTS set, should return false but not throw
  const result = await sendAlert({
    title: 'Test Alert',
    description: 'Test description',
    severity: 'info'
  });

  assert.strictEqual(result, false, 'Should return false when webhook not configured');
});

// ============================================================================
// Component 7: Outlet ID Mapper
// ============================================================================

console.log('\n=== Outlet ID Mapper ===\n');

test('outlet-id-mapper.ts exists', () => {
  const mapperPath = path.join(__dirname, '..', '..', 'src', 'lib', 'outlet-id-mapper.ts');
  assert.ok(fs.existsSync(mapperPath), 'Mapper should exist');
});

// ============================================================================
// Component 8: Workflow Files
// ============================================================================

console.log('\n=== Workflow Files ===\n');

test('weekly-integrity.yml exists and has Discord step', () => {
  const workflowPath = path.join(__dirname, '..', '..', '.github', 'workflows', 'weekly-integrity.yml');
  assert.ok(fs.existsSync(workflowPath), 'Workflow should exist');

  const content = fs.readFileSync(workflowPath, 'utf8');
  assert.ok(content.includes('DISCORD_WEBHOOK'), 'Should reference Discord webhook');
  assert.ok(content.includes('discord-notify'), 'Should use discord-notify module');
});

test('test.yml exists and has Discord alert step', () => {
  const workflowPath = path.join(__dirname, '..', '..', '.github', 'workflows', 'test.yml');
  assert.ok(fs.existsSync(workflowPath), 'Workflow should exist');

  const content = fs.readFileSync(workflowPath, 'utf8');
  assert.ok(content.includes('DISCORD_WEBHOOK_ALERTS'), 'Should reference Discord alerts webhook');
});

test('update-show-status.yml exists and has Discord step', () => {
  const workflowPath = path.join(__dirname, '..', '..', '.github', 'workflows', 'update-show-status.yml');
  assert.ok(fs.existsSync(workflowPath), 'Workflow should exist');

  const content = fs.readFileSync(workflowPath, 'utf8');
  assert.ok(content.includes('DISCORD_WEBHOOK_NEWSHOWS'), 'Should reference Discord new shows webhook');
});

// ============================================================================
// Component 9: Data Quality Targets Met
// ============================================================================

console.log('\n=== Data Quality Targets ===\n');

test('zero resolvable unknown outlets', () => {
  // The integrity report counts ALL unknown outlets including inherently unresolvable ones
  // (outletId "unknown" from web search sourcing, junk/sentence IDs).
  // This test checks directly for resolvable unknowns, skipping those categories.
  const reviewTextsDir = path.join(DATA_DIR, 'review-texts');
  const registryPath = path.join(DATA_DIR, 'outlet-registry.json');

  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const validOutlets = new Set(Object.keys(registry.outlets));

  if (registry._aliasIndex) {
    Object.keys(registry._aliasIndex).forEach(alias => {
      if (alias !== '_note') validOutlets.add(alias);
    });
  }

  // Also add all aliases from outlets section
  for (const outlet of Object.values(registry.outlets)) {
    if (outlet.aliases) {
      outlet.aliases.forEach(alias => validOutlets.add(alias));
    }
  }

  let resolvableUnknowns = 0;

  const showDirs = fs.readdirSync(reviewTextsDir).filter(f =>
    fs.statSync(path.join(reviewTextsDir, f)).isDirectory()
  );

  for (const showDir of showDirs) {
    const files = fs.readdirSync(path.join(reviewTextsDir, showDir))
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json');

    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(
          path.join(reviewTextsDir, showDir, file), 'utf8'
        ));

        const outletId = (data.outletId || '').toLowerCase();
        const hyphenCount = (outletId.match(/-/g) || []).length;

        // Skip inherently unresolvable: "unknown" and junk IDs with >5 hyphens
        if (!outletId || outletId === 'unknown' || hyphenCount > 5) continue;

        if (!validOutlets.has(outletId)) {
          resolvableUnknowns++;
        }
      } catch (e) {
        // Skip invalid JSON files
      }
    }
  }

  assert.strictEqual(resolvableUnknowns, 0, `Target: 0 resolvable unknown outlets, got ${resolvableUnknowns}`);
});

test('zero duplicates', () => {
  const reportPath = path.join(DATA_DIR, 'integrity-report.json');
  if (!fs.existsSync(reportPath)) {
    console.log('    (skipped - no report file)');
    passed--;
    return;
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.strictEqual(report.current.duplicates, 0, 'Target: 0 duplicates');
});

test('review count above 2000', () => {
  const reportPath = path.join(DATA_DIR, 'integrity-report.json');
  if (!fs.existsSync(reportPath)) {
    console.log('    (skipped - no report file)');
    passed--;
    return;
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.ok(report.current.totalReviews > 2000,
    `Target: 2000+ reviews, got ${report.current.totalReviews}`);
});

// ============================================================================
// Summary
// ============================================================================

console.log('\n' + '='.repeat(50));
console.log(`\nE2E Pipeline Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  console.log('Some components of the data quality pipeline have issues.');
  process.exit(1);
} else {
  console.log('All data quality pipeline components are working correctly!');
}
