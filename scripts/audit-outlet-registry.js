#!/usr/bin/env node
/**
 * Audit Outlet Registry Script
 *
 * Compares outlet-registry.json against actual review data in data/review-texts/
 * to find:
 * - Outlets in reviews but NOT in registry (missing from registry)
 * - Outlets in registry but NOT in reviews (orphans - informational only)
 * - Reviews where outlet display name doesn't match registry displayName
 * - Reviews with outletId that should be normalized to different canonical ID
 *
 * Usage:
 *   node scripts/audit-outlet-registry.js           # Audit only
 *   node scripts/audit-outlet-registry.js --fix     # Audit and fix issues
 *   node scripts/audit-outlet-registry.js --dry-run # Show what --fix would do
 */

const fs = require('fs');
const path = require('path');

// Paths
const REGISTRY_PATH = path.join(__dirname, '../data/outlet-registry.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const AUDIT_OUTPUT_PATH = path.join(__dirname, '../data/audit/outlet-registry-audit.json');
const NORMALIZATION_PATH = path.join(__dirname, './lib/review-normalization.js');

// Parse command line args
const args = process.argv.slice(2);
const FIX_MODE = args.includes('--fix');
const DRY_RUN = args.includes('--dry-run');

// Load the outlet registry
function loadRegistry() {
  if (!fs.existsSync(REGISTRY_PATH)) {
    console.error(`ERROR: Outlet registry not found at ${REGISTRY_PATH}`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
}

// Load normalization module if it exists
function loadNormalization() {
  try {
    return require(NORMALIZATION_PATH);
  } catch (e) {
    console.warn('Warning: Could not load review-normalization.js, some checks will be limited');
    return null;
  }
}

// Build alias-to-canonical mapping from registry
function buildAliasMap(registry) {
  const aliasMap = {};
  for (const [canonicalId, data] of Object.entries(registry.outlets)) {
    if (data.aliases) {
      for (const alias of data.aliases) {
        aliasMap[alias.toLowerCase()] = canonicalId;
      }
    }
    // Also add the canonical ID itself
    aliasMap[canonicalId.toLowerCase()] = canonicalId;
  }
  return aliasMap;
}

// Build alias-to-canonical mapping from normalization module
function buildNormalizationAliasMap(normalization) {
  if (!normalization || !normalization.OUTLET_ALIASES) return {};
  const aliasMap = {};
  for (const [canonicalId, aliases] of Object.entries(normalization.OUTLET_ALIASES)) {
    for (const alias of aliases) {
      aliasMap[alias.toLowerCase()] = canonicalId;
    }
    aliasMap[canonicalId.toLowerCase()] = canonicalId;
  }
  return aliasMap;
}

// Get all review files
function getAllReviewFiles() {
  const reviewFiles = [];

  if (!fs.existsSync(REVIEW_TEXTS_DIR)) {
    console.error(`ERROR: Review texts directory not found at ${REVIEW_TEXTS_DIR}`);
    process.exit(1);
  }

  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR).filter(f => {
    const fullPath = path.join(REVIEW_TEXTS_DIR, f);
    return fs.statSync(fullPath).isDirectory();
  });

  for (const showDir of showDirs) {
    const showPath = path.join(REVIEW_TEXTS_DIR, showDir);
    const files = fs.readdirSync(showPath).filter(f =>
      f.endsWith('.json') && f !== 'failed-fetches.json'
    );

    for (const file of files) {
      reviewFiles.push({
        showId: showDir,
        filename: file,
        fullPath: path.join(showPath, file)
      });
    }
  }

  return reviewFiles;
}

// Extract outlet ID from filename (format: outletId--criticName.json)
function extractOutletIdFromFilename(filename) {
  const match = filename.match(/^(.+?)--/);
  return match ? match[1] : null;
}

// Main audit function
function auditOutletRegistry() {
  console.log('=== Outlet Registry Audit ===\n');

  const registry = loadRegistry();
  const normalization = loadNormalization();

  const registryAliasMap = buildAliasMap(registry);
  const normalizationAliasMap = buildNormalizationAliasMap(normalization);

  const reviewFiles = getAllReviewFiles();
  console.log(`Found ${reviewFiles.length} review files to analyze\n`);

  // Track findings
  const findings = {
    missingFromRegistry: [],      // Outlets in reviews but not in registry
    orphanedInRegistry: [],       // Outlets in registry but not in reviews
    displayNameMismatches: [],    // Reviews where outlet name doesn't match registry
    needsNormalization: [],       // Reviews with non-canonical outletId
    registryNormalizationConflicts: [], // Cases where registry and normalization module disagree
  };

  // Track all outlets found in reviews
  const outletsInReviews = new Map(); // outletId -> { count, displayNames: Set, files: [] }

  // Process each review file
  for (const reviewFile of reviewFiles) {
    try {
      const review = JSON.parse(fs.readFileSync(reviewFile.fullPath, 'utf-8'));
      const filenameOutletId = extractOutletIdFromFilename(reviewFile.filename);
      const reviewOutletId = review.outletId || filenameOutletId;
      const reviewOutlet = review.outlet; // Display name

      if (!reviewOutletId) continue;

      // Track this outlet
      if (!outletsInReviews.has(reviewOutletId)) {
        outletsInReviews.set(reviewOutletId, {
          count: 0,
          displayNames: new Set(),
          files: []
        });
      }
      const outletData = outletsInReviews.get(reviewOutletId);
      outletData.count++;
      if (reviewOutlet) outletData.displayNames.add(reviewOutlet);
      outletData.files.push(reviewFile.fullPath);

      // Check 1: Is this outlet in the registry?
      const registryCanonical = registryAliasMap[reviewOutletId.toLowerCase()];

      if (!registryCanonical) {
        // Not found in registry - add to missing list (deduped later)
      }

      // Check 2: Does display name match registry?
      if (registryCanonical && reviewOutlet) {
        const registryDisplayName = registry.outlets[registryCanonical]?.displayName;
        if (registryDisplayName && reviewOutlet !== registryDisplayName) {
          findings.displayNameMismatches.push({
            file: reviewFile.fullPath,
            showId: reviewFile.showId,
            outletId: reviewOutletId,
            currentDisplayName: reviewOutlet,
            expectedDisplayName: registryDisplayName,
            canonicalId: registryCanonical
          });
        }
      }

      // Check 3: Should outletId be normalized to different canonical form?
      if (registryCanonical && reviewOutletId !== registryCanonical) {
        findings.needsNormalization.push({
          file: reviewFile.fullPath,
          showId: reviewFile.showId,
          currentOutletId: reviewOutletId,
          canonicalId: registryCanonical,
          displayName: reviewOutlet
        });
      }

      // Check 4: Does normalization module agree with registry?
      if (normalization) {
        const normCanonical = normalization.normalizeOutlet(reviewOutletId);
        if (registryCanonical && normCanonical !== registryCanonical) {
          findings.registryNormalizationConflicts.push({
            outletId: reviewOutletId,
            registryCanonical,
            normalizationCanonical: normCanonical,
            file: reviewFile.fullPath
          });
        }
      }

    } catch (e) {
      console.error(`Error processing ${reviewFile.fullPath}: ${e.message}`);
    }
  }

  // Find outlets missing from registry (deduped)
  const missingOutlets = new Map();
  for (const [outletId, data] of outletsInReviews) {
    const registryCanonical = registryAliasMap[outletId.toLowerCase()];
    if (!registryCanonical) {
      if (!missingOutlets.has(outletId)) {
        missingOutlets.set(outletId, {
          outletId,
          count: data.count,
          displayNames: Array.from(data.displayNames),
          sampleFiles: data.files.slice(0, 3)
        });
      }
    }
  }
  findings.missingFromRegistry = Array.from(missingOutlets.values())
    .sort((a, b) => b.count - a.count);

  // Find orphaned outlets in registry (in registry but not in reviews)
  const registryOutletIds = Object.keys(registry.outlets);
  const reviewOutletIdsLower = new Set(
    Array.from(outletsInReviews.keys()).map(id => id.toLowerCase())
  );

  for (const registryId of registryOutletIds) {
    // Check if any alias is used in reviews
    const aliases = registry.outlets[registryId].aliases || [registryId];
    const isUsed = aliases.some(alias => reviewOutletIdsLower.has(alias.toLowerCase()));

    if (!isUsed) {
      findings.orphanedInRegistry.push({
        outletId: registryId,
        displayName: registry.outlets[registryId].displayName,
        tier: registry.outlets[registryId].tier
      });
    }
  }

  // Dedupe display name mismatches (report unique combinations)
  const uniqueDisplayMismatches = new Map();
  for (const mismatch of findings.displayNameMismatches) {
    const key = `${mismatch.outletId}|${mismatch.currentDisplayName}|${mismatch.expectedDisplayName}`;
    if (!uniqueDisplayMismatches.has(key)) {
      uniqueDisplayMismatches.set(key, { ...mismatch, files: [] });
    }
    uniqueDisplayMismatches.get(key).files.push(mismatch.file);
    delete uniqueDisplayMismatches.get(key).file;
  }
  findings.displayNameMismatches = Array.from(uniqueDisplayMismatches.values());

  // Dedupe normalization needs
  const uniqueNormalization = new Map();
  for (const norm of findings.needsNormalization) {
    const key = `${norm.currentOutletId}|${norm.canonicalId}`;
    if (!uniqueNormalization.has(key)) {
      uniqueNormalization.set(key, { ...norm, files: [], count: 0 });
    }
    uniqueNormalization.get(key).files.push(norm.file);
    uniqueNormalization.get(key).count++;
    delete uniqueNormalization.get(key).file;
  }
  findings.needsNormalization = Array.from(uniqueNormalization.values())
    .sort((a, b) => b.count - a.count);

  // Dedupe registry/normalization conflicts
  const uniqueConflicts = new Map();
  for (const conflict of findings.registryNormalizationConflicts) {
    const key = `${conflict.outletId}|${conflict.registryCanonical}|${conflict.normalizationCanonical}`;
    if (!uniqueConflicts.has(key)) {
      uniqueConflicts.set(key, { ...conflict, files: [], count: 0 });
    }
    uniqueConflicts.get(key).files.push(conflict.file);
    uniqueConflicts.get(key).count++;
    delete uniqueConflicts.get(key).file;
  }
  findings.registryNormalizationConflicts = Array.from(uniqueConflicts.values());

  return findings;
}

// Print report
function printReport(findings) {
  console.log('=== AUDIT RESULTS ===\n');

  // Missing from registry
  console.log(`\n--- MISSING FROM REGISTRY (${findings.missingFromRegistry.length} outlets) ---`);
  if (findings.missingFromRegistry.length > 0) {
    console.log('These outlets appear in reviews but are not in outlet-registry.json:\n');
    for (const missing of findings.missingFromRegistry.slice(0, 30)) {
      console.log(`  ${missing.outletId} (${missing.count} reviews)`);
      if (missing.displayNames.length > 0) {
        console.log(`    Display names: ${missing.displayNames.join(', ')}`);
      }
    }
    if (findings.missingFromRegistry.length > 30) {
      console.log(`  ... and ${findings.missingFromRegistry.length - 30} more`);
    }
  } else {
    console.log('  All outlets are in the registry!');
  }

  // Orphaned in registry (informational)
  console.log(`\n--- ORPHANED IN REGISTRY (${findings.orphanedInRegistry.length} outlets) ---`);
  if (findings.orphanedInRegistry.length > 0) {
    console.log('These outlets are in the registry but have no reviews (OK, just informational):\n');
    for (const orphan of findings.orphanedInRegistry) {
      console.log(`  ${orphan.outletId}: "${orphan.displayName}" (tier ${orphan.tier})`);
    }
  } else {
    console.log('  All registry outlets have reviews!');
  }

  // Display name mismatches
  console.log(`\n--- DISPLAY NAME MISMATCHES (${findings.displayNameMismatches.length} unique) ---`);
  if (findings.displayNameMismatches.length > 0) {
    console.log('Reviews where outlet display name does not match registry:\n');
    for (const mismatch of findings.displayNameMismatches.slice(0, 20)) {
      console.log(`  ${mismatch.outletId}:`);
      console.log(`    Current:  "${mismatch.currentDisplayName}"`);
      console.log(`    Expected: "${mismatch.expectedDisplayName}"`);
      console.log(`    Files: ${mismatch.files?.length || 1}`);
    }
    if (findings.displayNameMismatches.length > 20) {
      console.log(`  ... and ${findings.displayNameMismatches.length - 20} more`);
    }
  } else {
    console.log('  All display names match!');
  }

  // Needs normalization
  console.log(`\n--- NEEDS NORMALIZATION (${findings.needsNormalization.length} unique) ---`);
  if (findings.needsNormalization.length > 0) {
    console.log('Reviews with outletId that should be normalized:\n');
    for (const norm of findings.needsNormalization.slice(0, 20)) {
      console.log(`  "${norm.currentOutletId}" -> "${norm.canonicalId}" (${norm.count} files)`);
    }
    if (findings.needsNormalization.length > 20) {
      console.log(`  ... and ${findings.needsNormalization.length - 20} more`);
    }
  } else {
    console.log('  All outletIds are canonical!');
  }

  // Registry vs normalization conflicts
  if (findings.registryNormalizationConflicts.length > 0) {
    console.log(`\n--- REGISTRY VS NORMALIZATION CONFLICTS (${findings.registryNormalizationConflicts.length}) ---`);
    console.log('Cases where outlet-registry.json and review-normalization.js disagree:\n');
    for (const conflict of findings.registryNormalizationConflicts) {
      console.log(`  ${conflict.outletId}:`);
      console.log(`    Registry says:      ${conflict.registryCanonical}`);
      console.log(`    Normalization says: ${conflict.normalizationCanonical}`);
      console.log(`    Files: ${conflict.count}`);
    }
  }

  // Summary
  console.log('\n=== SUMMARY ===');
  const hasIssues = findings.missingFromRegistry.length > 0 ||
                    findings.displayNameMismatches.length > 0 ||
                    findings.needsNormalization.length > 0;

  console.log(`Missing from registry:     ${findings.missingFromRegistry.length}`);
  console.log(`Orphaned in registry:      ${findings.orphanedInRegistry.length} (informational)`);
  console.log(`Display name mismatches:   ${findings.displayNameMismatches.length}`);
  console.log(`Needs normalization:       ${findings.needsNormalization.length}`);
  console.log(`Registry/norm conflicts:   ${findings.registryNormalizationConflicts.length}`);
  console.log(`\nStatus: ${hasIssues ? 'FAIL - Issues found' : 'PASS - No issues'}`);

  return hasIssues;
}

// Apply fixes
function applyFixes(findings, dryRun = false) {
  console.log(`\n=== ${dryRun ? 'DRY RUN - ' : ''}APPLYING FIXES ===\n`);

  const registry = loadRegistry();
  let fixedCount = 0;
  let errorCount = 0;

  // Fix display name mismatches
  console.log('Fixing display name mismatches...');
  for (const mismatch of findings.displayNameMismatches) {
    const files = mismatch.files || [mismatch.file];
    for (const filePath of files) {
      try {
        if (dryRun) {
          console.log(`  Would fix: ${path.basename(filePath)}`);
          console.log(`    outlet: "${mismatch.currentDisplayName}" -> "${mismatch.expectedDisplayName}"`);
        } else {
          const review = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          review.outlet = mismatch.expectedDisplayName;
          fs.writeFileSync(filePath, JSON.stringify(review, null, 2));
          console.log(`  Fixed: ${path.basename(filePath)}`);
        }
        fixedCount++;
      } catch (e) {
        console.error(`  Error fixing ${filePath}: ${e.message}`);
        errorCount++;
      }
    }
  }

  // Fix normalization (update outletId to canonical form)
  console.log('\nFixing outletId normalization...');
  for (const norm of findings.needsNormalization) {
    const files = norm.files || [norm.file];
    for (const filePath of files) {
      try {
        if (dryRun) {
          console.log(`  Would fix: ${path.basename(filePath)}`);
          console.log(`    outletId: "${norm.currentOutletId}" -> "${norm.canonicalId}"`);
        } else {
          const review = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          review.outletId = norm.canonicalId;
          // Also fix display name if registry has it
          if (registry.outlets[norm.canonicalId]) {
            review.outlet = registry.outlets[norm.canonicalId].displayName;
          }
          fs.writeFileSync(filePath, JSON.stringify(review, null, 2));
          console.log(`  Fixed: ${path.basename(filePath)}`);
        }
        fixedCount++;
      } catch (e) {
        console.error(`  Error fixing ${filePath}: ${e.message}`);
        errorCount++;
      }
    }
  }

  console.log(`\n${dryRun ? 'Would fix' : 'Fixed'}: ${fixedCount} files`);
  if (errorCount > 0) {
    console.log(`Errors: ${errorCount}`);
  }

  return fixedCount;
}

// Save audit results
function saveAuditResults(findings, hasIssues) {
  // Ensure audit directory exists
  const auditDir = path.dirname(AUDIT_OUTPUT_PATH);
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true });
  }

  const auditReport = {
    timestamp: new Date().toISOString(),
    status: hasIssues ? 'fail' : 'pass',
    summary: {
      missingFromRegistry: findings.missingFromRegistry.length,
      orphanedInRegistry: findings.orphanedInRegistry.length,
      displayNameMismatches: findings.displayNameMismatches.length,
      needsNormalization: findings.needsNormalization.length,
      registryNormalizationConflicts: findings.registryNormalizationConflicts.length
    },
    missingFromRegistry: findings.missingFromRegistry,
    displayNameMismatches: findings.displayNameMismatches,
    needsNormalization: findings.needsNormalization,
    orphanedInRegistry: findings.orphanedInRegistry,
    registryNormalizationConflicts: findings.registryNormalizationConflicts
  };

  fs.writeFileSync(AUDIT_OUTPUT_PATH, JSON.stringify(auditReport, null, 2));
  console.log(`\nAudit results saved to: ${AUDIT_OUTPUT_PATH}`);
}

// Main
async function main() {
  try {
    const findings = auditOutletRegistry();
    const hasIssues = printReport(findings);

    saveAuditResults(findings, hasIssues);

    if (FIX_MODE || DRY_RUN) {
      applyFixes(findings, DRY_RUN);
    }

    // Exit with appropriate code
    // Missing outlets = fail (exit 1)
    // Other issues are fixable
    if (findings.missingFromRegistry.length > 0) {
      console.log('\n!!! Outlets missing from registry - add them to data/outlet-registry.json !!!');
      process.exit(1);
    }

    process.exit(0);

  } catch (e) {
    console.error(`Fatal error: ${e.message}`);
    console.error(e.stack);
    process.exit(1);
  }
}

main();
