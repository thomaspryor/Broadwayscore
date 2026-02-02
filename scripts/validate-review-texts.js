#!/usr/bin/env node

/**
 * validate-review-texts.js
 *
 * Validates individual review-text JSON files in data/review-texts/
 *
 * Validation checks:
 * 1. Unknown outlets - outletId must exist in data/outlet-registry.json
 * 2. Garbage critic names - Must not match garbage patterns
 * 3. Duplicate reviews - No two files with same outlet+critic in same show directory
 * 4. Required fields - Must have showId, and either outletId or outlet
 *
 * Usage:
 *   node scripts/validate-review-texts.js                    # Validate all shows
 *   node scripts/validate-review-texts.js --show=hamilton-2015  # Validate single show
 *   node scripts/validate-review-texts.js --json             # Output JSON (machine-readable)
 *
 * Exit codes:
 *   0 - All files valid
 *   1 - Validation errors found
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const jsonOutput = args.includes('--json');

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const OUTLET_REGISTRY_PATH = path.join(DATA_DIR, 'outlet-registry.json');

// Garbage critic name patterns
const GARBAGE_PATTERNS = [
  /^photo\s*(credit|by)?/i,
  /^staff$/i,
  /^&nbsp;/,
  /^\s*$/,
  /^unknown$/i,
  /^advertisement$/i,
  /^editorial$/i,
];

/**
 * Load and parse the outlet registry
 */
function loadOutletRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(OUTLET_REGISTRY_PATH, 'utf8'));
    const validOutlets = new Set();

    // Add all outlet IDs
    Object.keys(data.outlets || {}).forEach(id => validOutlets.add(id));

    // Add all aliases from _aliasIndex
    Object.keys(data._aliasIndex || {}).forEach(alias => validOutlets.add(alias));

    // Add all aliases from each outlet entry
    Object.values(data.outlets || {}).forEach(outlet => {
      if (outlet.aliases) {
        outlet.aliases.forEach(alias => validOutlets.add(alias.toLowerCase()));
      }
    });

    return validOutlets;
  } catch (err) {
    console.error('Failed to load outlet registry:', err.message);
    process.exit(1);
  }
}

/**
 * Check if a critic name is garbage/invalid
 */
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

/**
 * Normalize outlet ID for comparison
 */
function normalizeOutletId(id) {
  if (!id) return null;
  return id.toLowerCase().trim();
}

/**
 * Generate a key for duplicate detection
 */
function generateReviewKey(outletId, outlet, criticName) {
  const normalizedOutlet = normalizeOutletId(outletId) || normalizeOutletId(outlet) || 'unknown';
  const normalizedCritic = (criticName || 'unknown').toLowerCase().trim().replace(/\s+/g, '-');
  return `${normalizedOutlet}::${normalizedCritic}`;
}

/**
 * Validate a single review file
 */
function validateReviewFile(filePath, validOutlets, seenReviews) {
  const errors = [];
  const warnings = [];
  const relativePath = path.relative(DATA_DIR, filePath);

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    errors.push({
      file: relativePath,
      check: 'json_parse',
      message: `Failed to parse JSON: ${err.message}`
    });
    return { errors, warnings };
  }

  // Check 1: Required fields
  if (!data.showId) {
    errors.push({
      file: relativePath,
      check: 'required_fields',
      message: 'Missing required field: showId'
    });
  }

  if (!data.outletId && !data.outlet) {
    errors.push({
      file: relativePath,
      check: 'required_fields',
      message: 'Missing required field: must have outletId or outlet'
    });
  }

  // Check 2: Unknown outlets (warning — unregistered outlets are common from aggregators)
  const outletId = normalizeOutletId(data.outletId);
  if (outletId && !validOutlets.has(outletId)) {
    warnings.push({
      file: relativePath,
      check: 'unknown_outlet',
      message: `Outlet '${data.outletId}' not in registry`
    });
  }

  // Check 3: Garbage critic names (warning — aggregator stubs often lack critic names)
  if (isGarbageCriticName(data.criticName)) {
    const displayName = data.criticName || '(empty)';
    warnings.push({
      file: relativePath,
      check: 'garbage_critic_name',
      message: `Garbage critic name: '${displayName}'`
    });
  }

  // Check 4: Duplicate reviews
  const showDir = path.dirname(filePath);
  const showId = path.basename(showDir);
  const reviewKey = `${showId}::${generateReviewKey(data.outletId, data.outlet, data.criticName)}`;

  if (seenReviews.has(reviewKey)) {
    const existingFile = seenReviews.get(reviewKey);
    errors.push({
      file: relativePath,
      check: 'duplicate_review',
      message: `Duplicate review (same outlet+critic): also in ${existingFile}`
    });
  } else {
    seenReviews.set(reviewKey, relativePath);
  }

  return { errors, warnings };
}

/**
 * Get all review JSON files for a show
 */
function getReviewFilesForShow(showDir) {
  try {
    return fs.readdirSync(showDir)
      .filter(f => f.endsWith('.json') && f !== 'failed-fetches.json')
      .map(f => path.join(showDir, f));
  } catch (err) {
    return [];
  }
}

/**
 * Get all show directories
 */
function getShowDirectories() {
  try {
    return fs.readdirSync(REVIEW_TEXTS_DIR)
      .filter(f => {
        const fullPath = path.join(REVIEW_TEXTS_DIR, f);
        const stat = fs.lstatSync(fullPath);
        return stat.isDirectory() && !stat.isSymbolicLink();
      })
      .map(f => path.join(REVIEW_TEXTS_DIR, f));
  } catch (err) {
    console.error('Failed to read review-texts directory:', err.message);
    process.exit(1);
  }
}

/**
 * Main validation function
 */
function main() {
  // Load outlet registry
  const validOutlets = loadOutletRegistry();

  // Get show directories to validate
  let showDirs = getShowDirectories();

  if (showFilter) {
    const targetDir = path.join(REVIEW_TEXTS_DIR, showFilter);
    if (!fs.existsSync(targetDir)) {
      console.error(`Show directory not found: ${showFilter}`);
      process.exit(1);
    }
    showDirs = [targetDir];
  }

  // Track results
  const allErrors = [];
  const allWarnings = [];
  let totalFiles = 0;
  const seenReviews = new Map();

  // Validate each show
  for (const showDir of showDirs) {
    const files = getReviewFilesForShow(showDir);

    for (const file of files) {
      totalFiles++;
      const { errors, warnings } = validateReviewFile(file, validOutlets, seenReviews);
      allErrors.push(...errors);
      allWarnings.push(...warnings);
    }
  }

  // Calculate summary
  const errorFiles = new Set(allErrors.map(e => e.file)).size;
  const summary = {
    total: totalFiles,
    passed: totalFiles - errorFiles,
    failed: errorFiles,
    warnings: allWarnings.length
  };

  // Output results
  if (jsonOutput) {
    const result = {
      summary,
      errors: allErrors,
      warnings: allWarnings
    };
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('Validating review-text files...');
    console.log(`  Scanning: ${showDirs.length} shows, ${totalFiles} files\n`);

    if (allErrors.length > 0) {
      console.log(`ERRORS (${allErrors.length}):`);
      for (const error of allErrors) {
        console.log(`  ${error.file}: ${error.message}`);
      }
      console.log('');
    }

    if (allWarnings.length > 0) {
      console.log(`WARNINGS (${allWarnings.length}):`);
      for (const warning of allWarnings) {
        console.log(`  ${warning.file}: ${warning.message}`);
      }
      console.log('');
    }

    console.log(`Summary: ${summary.passed}/${summary.total} passed, ${summary.failed} errors, ${summary.warnings} warnings`);
  }

  // Exit with appropriate code
  process.exit(allErrors.length > 0 ? 1 : 0);
}

// Run
main();
