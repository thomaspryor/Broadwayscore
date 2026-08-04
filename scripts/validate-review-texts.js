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
 *   node scripts/validate-review-texts.js                    # Validate all shows (exit 1 on ANY error)
 *   node scripts/validate-review-texts.js --gate             # Per-push trunk catastrophe FLOOR
 *   node scripts/validate-review-texts.js --show=hamilton-2015  # Validate single show
 *   node scripts/validate-review-texts.js --json             # Output JSON (machine-readable)
 *
 * --gate (vs default) as of 2026-06-29: review-texts live in a SEPARATE private repo
 * that data bots mutate every ~2min, so the default (exit 1 on ANY error) reddened
 * the trunk for unrelated pushes whenever a single duplicate-churn file existed in
 * the window before the dedup workflows cleared it. --gate blocks only on
 * catastrophic, non-self-healing classes (corrupt JSON / aggregator contamination /
 * broken refs / missing required fields) and tolerates auto-healable duplicate churn
 * up to a floor. Decision logic + tests: scripts/lib/review-texts-gate.{js,test.mjs}.
 * The FULL validator runs daily in check-corpus-drift.yml, surfaced non-blocking.
 *
 * Exit codes:
 *   0 - All files valid (default) / no catastrophe (--gate)
 *   1 - Validation errors found (default) / catastrophic error or churn spike (--gate)
 */

const fs = require('fs');
const path = require('path');
const { normalizeOutlet, AGGREGATOR_SCORE_SOURCES } = require('./lib/review-normalization');
const { shouldBlockReviewTextsGate, HEALABLE_CHECKS } = require('./lib/review-texts-gate');
// Aggregator domain/outlet sets are the single source of truth in lib/aggregator-domains.js,
// shared with the ingest-side guard in gather-reviews.js so the validator and the writer
// agree by construction. See that file for the contamination-class rationale.
const { AGGREGATOR_DOMAINS, AGGREGATOR_OUTLET_IDS } = require('./lib/aggregator-domains');
const { isSkippedByValidator } = require('./lib/aggregator-url-latent');

// Startup assertion — prevent silent no-ops if import breaks
if (!AGGREGATOR_SCORE_SOURCES || AGGREGATOR_SCORE_SOURCES.size === 0) {
  throw new Error('AGGREGATOR_SCORE_SOURCES failed to load from review-normalization.js');
}
if (!AGGREGATOR_DOMAINS || AGGREGATOR_DOMAINS.size === 0 || !AGGREGATOR_OUTLET_IDS || AGGREGATOR_OUTLET_IDS.size === 0) {
  throw new Error('AGGREGATOR_DOMAINS/AGGREGATOR_OUTLET_IDS failed to load from aggregator-domains.js');
}

// Parse command line arguments
const args = process.argv.slice(2);
const showFilter = args.find(a => a.startsWith('--show='))?.split('=')[1];
const jsonOutput = args.includes('--json');
const GATE = args.includes('--gate');
// Per-push gate: tolerate this much auto-healable duplicate-churn before blocking.
const GATE_HEALABLE_FLOOR = 10;

// Paths
const DATA_DIR = path.join(__dirname, '..', 'data');
const REVIEW_TEXTS_DIR = path.join(DATA_DIR, 'review-texts');
const OUTLET_REGISTRY_PATH = path.join(DATA_DIR, 'outlet-registry.json');

// Registry alias index — built once at load for canonical outlet resolution
let registryAliasIndex = {};

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

    // Add all aliases from _aliasIndex and build canonical mapping
    Object.entries(data._aliasIndex || {}).forEach(([alias, canonical]) => {
      validOutlets.add(alias);
      registryAliasIndex[alias] = canonical;
    });

    // Add all aliases from each outlet entry
    Object.entries(data.outlets || {}).forEach(([id, outlet]) => {
      if (outlet.aliases) {
        outlet.aliases.forEach(alias => {
          const lower = alias.toLowerCase();
          validOutlets.add(lower);
          registryAliasIndex[lower] = id;
        });
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
 * Normalize outlet ID to canonical form.
 * Thin wrapper around canonical normalizeOutlet() that preserves null-in/null-out.
 */
function normalizeOutletId(id) {
  if (!id) return null;
  return normalizeOutlet(id);
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

  // Validate duplicateOf / duplicateTextOf targets exist before skipping
  for (const field of ['duplicateOf', 'duplicateTextOf']) {
    if (data[field]) {
      const targetPath = path.join(path.dirname(filePath), data[field]);
      if (!fs.existsSync(targetPath)) {
        errors.push({
          file: relativePath,
          check: 'broken_duplicate_ref',
          message: `Broken ${field} reference: "${data[field]}" does not exist`
        });
      }
    }
  }

  // Skip files excluded from rebuild (duplicates, wrong production, etc.).
  // The flag list lives in scripts/lib/aggregator-url-latent.js because
  // audit-aggregator-url-latent.js ratchets the population this predicate hides;
  // a second copy that drifted would report a clean number while the real latent
  // population grew (task #1002).
  if (isSkippedByValidator(data)) {
    return { errors, warnings, skipped: true };
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
    const existing = seenReviews.get(reviewKey);
    // Same outlet+critic but different URL = likely different articles (e.g. timeout-london reviews different productions)
    if (data.url && existing.url && data.url !== existing.url) {
      warnings.push({
        file: relativePath,
        check: 'duplicate_review',
        message: `Same outlet+critic as ${existing.file} but different URL — verify these are distinct reviews`
      });
    } else {
      errors.push({
        file: relativePath,
        check: 'duplicate_review',
        message: `Duplicate review (same outlet+critic): also in ${existing.file}`
      });
    }
  } else {
    seenReviews.set(reviewKey, { file: relativePath, url: data.url || null });
  }

  // Check 5: Aggregator score contamination
  // 5a: aggregator scoreSource + originalScore = contamination (unless humanReviewScore override)
  if (AGGREGATOR_SCORE_SOURCES.has(data.scoreSource) && data.originalScore && !data.humanReviewScore) {
    errors.push({
      file: relativePath,
      check: 'aggregator_contamination',
      message: `Aggregator scoreSource "${data.scoreSource}" with originalScore "${data.originalScore}" — aggregator ratings must not be stored as outlet scores`
    });
  }

  // 5b: URL points to aggregator domain but outletId is a different outlet
  if (data.url) {
    try {
      const hostname = new URL(data.url).hostname.replace(/^www\./, '');
      if (AGGREGATOR_DOMAINS.has(hostname) && !AGGREGATOR_OUTLET_IDS.has(outletId)) {
        errors.push({
          file: relativePath,
          check: 'aggregator_url_mismatch',
          message: `URL domain "${hostname}" is an aggregator but outletId is "${data.outletId}" — review URL should point to the outlet's own page`
        });
      }
    } catch { /* invalid URL — other checks catch this */ }
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
  let skippedFiles = 0;
  const seenReviews = new Map();

  // Validate each show
  for (const showDir of showDirs) {
    const files = getReviewFilesForShow(showDir);

    for (const file of files) {
      totalFiles++;
      const result = validateReviewFile(file, validOutlets, seenReviews);
      if (result.skipped) { skippedFiles++; continue; }
      allErrors.push(...result.errors);
      allWarnings.push(...result.warnings);
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
    console.log(`  Scanning: ${showDirs.length} shows, ${totalFiles} files (${skippedFiles} excluded)\n`);

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

  // --gate: catastrophe floor only. Catastrophic classes (corrupt JSON, aggregator
  // contamination, broken duplicate refs, missing required fields) are zero-tolerance
  // — they ship bad data and no self-heal clears them. Auto-healable duplicate churn
  // (WE scrapers minting variant files between dedup passes) is tolerated up to a
  // floor. Any UNKNOWN error check defaults to catastrophic (fail-safe). Decision is
  // the pure scripts/lib/review-texts-gate.js (unit-tested, CLAUDE.md §15).
  if (GATE) {
    const healableErrors = allErrors.filter(e => HEALABLE_CHECKS.has(e.check)).length;
    const catastrophicErrors = allErrors.length - healableErrors;
    if (shouldBlockReviewTextsGate({ catastrophicErrors, healableErrors, floor: GATE_HEALABLE_FLOOR })) {
      console.error(`\n❌ GATE: ${catastrophicErrors} catastrophic error(s) (zero-tolerance) + ${healableErrors} auto-healable duplicate error(s) vs floor ${GATE_HEALABLE_FLOOR}. Failing the trunk.`);
      process.exit(1);
    }
    console.log(`\n✅ GATE: 0 catastrophic errors, ${healableErrors} auto-healable duplicate error(s) ≤ floor ${GATE_HEALABLE_FLOOR}. Non-catastrophic — surfaced above, not blocking the trunk. Full validator runs daily in check-corpus-drift.yml (→ digest).`);
    process.exit(0);
  }

  // Exit with appropriate code
  process.exit(allErrors.length > 0 ? 1 : 0);
}

// Run
main();
