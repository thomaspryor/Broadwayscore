#!/usr/bin/env node
/**
 * Audit Outlet Registry Script
 *
 * Compares outlet-registry.json against actual review data in data/review-texts/
 * to find:
 * - Outlets in reviews but NOT in registry (missing from registry)
 * - Outlets in registry but NOT in reviews (unused - informational only)
 * - Reviews where outlet display name doesn't match registry displayName
 * - Reviews with outletId that should be normalized to different canonical ID
 *
 * Usage:
 *   node scripts/audit-outlet-registry.js           # Console summary output (default)
 *   node scripts/audit-outlet-registry.js --json    # Full JSON output to stdout
 *   node scripts/audit-outlet-registry.js --fix     # Audit and fix display name/normalization issues
 *   node scripts/audit-outlet-registry.js --dry-run # Show what --fix would do
 *   node scripts/audit-outlet-registry.js --update  # Add missing outlets to registry (with confirmation)
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Paths
const REGISTRY_PATH = path.join(__dirname, '../data/outlet-registry.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const AUDIT_OUTPUT_PATH = path.join(__dirname, '../data/audit/outlet-registry-gaps.json');
const NORMALIZATION_PATH = path.join(__dirname, './lib/review-normalization.js');

// Parse command line args
const args = process.argv.slice(2);
const FIX_MODE = args.includes('--fix');
const DRY_RUN = args.includes('--dry-run');
const JSON_OUTPUT = args.includes('--json');
const UPDATE_MODE = args.includes('--update');

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
    if (!JSON_OUTPUT) {
      console.warn('Warning: Could not load review-normalization.js, some checks will be limited');
    }
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

// Generate a suggested display name from an outletId
function suggestDisplayName(outletId, existingDisplayNames = []) {
  // If we have existing display names from the reviews, use the most common one
  if (existingDisplayNames.length > 0) {
    // Count occurrences and pick most frequent
    const counts = {};
    for (const name of existingDisplayNames) {
      counts[name] = (counts[name] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted[0][0];
  }

  // Otherwise, convert outletId to a reasonable display name
  // e.g., "xyz-magazine" -> "Xyz Magazine"
  return outletId
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Generate a suggested registry entry for a missing outlet
function suggestRegistryEntry(outletId, displayNames = [], count = 0) {
  const displayName = suggestDisplayName(outletId, displayNames);

  // Generate aliases: include the outletId and any variations
  const aliases = [outletId];

  // Add lowercase display name as alias if different
  const lowerDisplay = displayName.toLowerCase();
  if (lowerDisplay !== outletId && !aliases.includes(lowerDisplay)) {
    aliases.push(lowerDisplay);
  }

  // Add any original display names as aliases (lowercased)
  for (const name of displayNames) {
    const lower = name.toLowerCase();
    if (!aliases.includes(lower)) {
      aliases.push(lower);
    }
  }

  return {
    outletId,
    displayName,
    tier: 3, // Default to tier 3 for unknown outlets
    aliases
  };
}

// Main audit function
function auditOutletRegistry() {
  const registry = loadRegistry();
  const normalization = loadNormalization();

  const registryAliasMap = buildAliasMap(registry);

  const reviewFiles = getAllReviewFiles();

  // Track findings
  const findings = {
    missingFromRegistry: [],      // Outlets in reviews but not in registry
    unusedInRegistry: [],         // Outlets in registry but not in reviews
    displayNameMismatches: [],    // Reviews where outlet name doesn't match registry
    needsNormalization: [],       // Reviews with non-canonical outletId
    registryNormalizationConflicts: [], // Cases where registry and normalization module disagree
  };

  // Track all outlets found in reviews
  const outletsInReviews = new Map(); // outletId -> { count, displayNames: Set, files: [], shows: Set }

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
          displayNames: [],
          files: [],
          shows: new Set()
        });
      }
      const outletData = outletsInReviews.get(reviewOutletId);
      outletData.count++;
      if (reviewOutlet) outletData.displayNames.push(reviewOutlet);
      outletData.files.push(reviewFile.fullPath);
      outletData.shows.add(reviewFile.showId);

      // Check 1: Is this outlet in the registry?
      const registryCanonical = registryAliasMap[reviewOutletId.toLowerCase()];

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
      if (!JSON_OUTPUT) {
        console.error(`Error processing ${reviewFile.fullPath}: ${e.message}`);
      }
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
          shows: Array.from(data.shows),
          exampleFile: data.files[0],
          displayNames: [...new Set(data.displayNames)] // Unique display names
        });
      }
    }
  }
  findings.missingFromRegistry = Array.from(missingOutlets.values())
    .sort((a, b) => b.count - a.count);

  // Find unused outlets in registry (in registry but not in reviews)
  const registryOutletIds = Object.keys(registry.outlets);
  const reviewOutletIdsLower = new Set(
    Array.from(outletsInReviews.keys()).map(id => id.toLowerCase())
  );

  for (const registryId of registryOutletIds) {
    // Check if any alias is used in reviews
    const aliases = registry.outlets[registryId].aliases || [registryId];
    const isUsed = aliases.some(alias => reviewOutletIdsLower.has(alias.toLowerCase()));

    if (!isUsed) {
      findings.unusedInRegistry.push({
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

  // Generate suggested additions for missing outlets
  const suggestedAdditions = findings.missingFromRegistry.map(missing =>
    suggestRegistryEntry(missing.outletId, missing.displayNames, missing.count)
  );

  // Calculate summary stats
  const totalOutletsInReviews = outletsInReviews.size;
  const inRegistry = totalOutletsInReviews - findings.missingFromRegistry.length;

  return {
    findings,
    suggestedAdditions,
    totalReviewFiles: reviewFiles.length,
    totalOutletsInReviews,
    inRegistry,
    registrySize: registryOutletIds.length
  };
}

// Print console summary report
function printReport(auditResult) {
  const { findings, suggestedAdditions, totalReviewFiles, totalOutletsInReviews, inRegistry, registrySize } = auditResult;

  console.log('Outlet Registry Audit');
  console.log('=====================\n');

  console.log('Scanning review-texts...');
  console.log(`  Found ${totalOutletsInReviews} unique outlets across ${totalReviewFiles} files\n`);

  console.log('Registry Coverage:');
  console.log(`  In registry: ${inRegistry} outlets`);
  console.log(`  Missing: ${findings.missingFromRegistry.length} outlets`);
  console.log(`  Unused in registry: ${findings.unusedInRegistry.length} outlets\n`);

  // Missing from registry
  if (findings.missingFromRegistry.length > 0) {
    console.log('Missing Outlets:');
    for (const missing of findings.missingFromRegistry.slice(0, 20)) {
      console.log(`  ${missing.outletId} (${missing.count} reviews in ${missing.shows.length} shows)`);
    }
    if (findings.missingFromRegistry.length > 20) {
      console.log(`  ... and ${findings.missingFromRegistry.length - 20} more`);
    }
    console.log('');
  }

  // Display name mismatches (brief)
  if (findings.displayNameMismatches.length > 0) {
    console.log(`Display name mismatches: ${findings.displayNameMismatches.length} unique`);
  }

  // Normalization needs (brief)
  if (findings.needsNormalization.length > 0) {
    console.log(`Needs normalization: ${findings.needsNormalization.length} unique outletIds`);
  }

  // Conflicts (brief)
  if (findings.registryNormalizationConflicts.length > 0) {
    console.log(`Registry/normalization conflicts: ${findings.registryNormalizationConflicts.length}`);
  }

  console.log('\nRun with --json for full details');
  console.log('Run with --update to add missing outlets to registry');
  console.log('Run with --fix to fix display name and normalization issues');

  return findings.missingFromRegistry.length > 0;
}

// Generate full JSON output
function generateJsonOutput(auditResult) {
  const { findings, suggestedAdditions, totalReviewFiles, totalOutletsInReviews, inRegistry } = auditResult;

  // Transform missingFromRegistry to match spec format
  const missingOutlets = findings.missingFromRegistry.map(m => ({
    outletId: m.outletId,
    count: m.count,
    shows: m.shows,
    exampleFile: m.exampleFile
  }));

  // Transform unusedInRegistry to match spec format
  const unusedInRegistry = findings.unusedInRegistry.map(u => ({
    outletId: u.outletId,
    displayName: u.displayName
  }));

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalOutletsInReviews,
      inRegistry,
      missing: findings.missingFromRegistry.length,
      unused: findings.unusedInRegistry.length
    },
    missingOutlets,
    unusedInRegistry,
    suggestedAdditions,
    // Include additional detail sections
    displayNameMismatches: findings.displayNameMismatches,
    needsNormalization: findings.needsNormalization,
    registryNormalizationConflicts: findings.registryNormalizationConflicts
  };
}

// Apply fixes to review files
function applyFixes(auditResult, dryRun = false) {
  const { findings } = auditResult;

  if (!JSON_OUTPUT) {
    console.log(`\n=== ${dryRun ? 'DRY RUN - ' : ''}APPLYING FIXES ===\n`);
  }

  const registry = loadRegistry();
  let fixedCount = 0;
  let errorCount = 0;

  // Fix display name mismatches
  if (!JSON_OUTPUT) console.log('Fixing display name mismatches...');
  for (const mismatch of findings.displayNameMismatches) {
    const files = mismatch.files || [mismatch.file];
    for (const filePath of files) {
      try {
        if (dryRun) {
          if (!JSON_OUTPUT) {
            console.log(`  Would fix: ${path.basename(filePath)}`);
            console.log(`    outlet: "${mismatch.currentDisplayName}" -> "${mismatch.expectedDisplayName}"`);
          }
        } else {
          const review = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          review.outlet = mismatch.expectedDisplayName;
          fs.writeFileSync(filePath, JSON.stringify(review, null, 2));
          if (!JSON_OUTPUT) console.log(`  Fixed: ${path.basename(filePath)}`);
        }
        fixedCount++;
      } catch (e) {
        if (!JSON_OUTPUT) console.error(`  Error fixing ${filePath}: ${e.message}`);
        errorCount++;
      }
    }
  }

  // Fix normalization (update outletId to canonical form)
  if (!JSON_OUTPUT) console.log('\nFixing outletId normalization...');
  for (const norm of findings.needsNormalization) {
    const files = norm.files || [norm.file];
    for (const filePath of files) {
      try {
        if (dryRun) {
          if (!JSON_OUTPUT) {
            console.log(`  Would fix: ${path.basename(filePath)}`);
            console.log(`    outletId: "${norm.currentOutletId}" -> "${norm.canonicalId}"`);
          }
        } else {
          const review = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          review.outletId = norm.canonicalId;
          // Also fix display name if registry has it
          if (registry.outlets[norm.canonicalId]) {
            review.outlet = registry.outlets[norm.canonicalId].displayName;
          }
          fs.writeFileSync(filePath, JSON.stringify(review, null, 2));
          if (!JSON_OUTPUT) console.log(`  Fixed: ${path.basename(filePath)}`);
        }
        fixedCount++;
      } catch (e) {
        if (!JSON_OUTPUT) console.error(`  Error fixing ${filePath}: ${e.message}`);
        errorCount++;
      }
    }
  }

  if (!JSON_OUTPUT) {
    console.log(`\n${dryRun ? 'Would fix' : 'Fixed'}: ${fixedCount} files`);
    if (errorCount > 0) {
      console.log(`Errors: ${errorCount}`);
    }
  }

  return fixedCount;
}

// Prompt for confirmation
function askConfirmation(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// Add missing outlets to registry
async function updateRegistry(auditResult) {
  const { suggestedAdditions, findings } = auditResult;

  if (findings.missingFromRegistry.length === 0) {
    console.log('\nNo missing outlets to add to registry.');
    return;
  }

  console.log('\n=== SUGGESTED REGISTRY ADDITIONS ===\n');
  for (const entry of suggestedAdditions) {
    console.log(`  ${entry.outletId}:`);
    console.log(`    displayName: "${entry.displayName}"`);
    console.log(`    tier: ${entry.tier}`);
    console.log(`    aliases: ${JSON.stringify(entry.aliases)}`);
    console.log('');
  }

  const confirmed = await askConfirmation(
    `Add ${suggestedAdditions.length} outlets to registry? (y/n): `
  );

  if (!confirmed) {
    console.log('Aborted.');
    return;
  }

  // Load and update registry
  const registry = loadRegistry();

  for (const entry of suggestedAdditions) {
    registry.outlets[entry.outletId] = {
      displayName: entry.displayName,
      tier: entry.tier,
      aliases: entry.aliases,
      domain: null // Can be filled in manually later
    };
  }

  // Update lastUpdated in _meta
  if (registry._meta) {
    registry._meta.lastUpdated = new Date().toISOString().split('T')[0];
  }

  // Write back
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
  console.log(`\nAdded ${suggestedAdditions.length} outlets to ${REGISTRY_PATH}`);
}

// Save audit results to file
function saveAuditResults(jsonOutput) {
  // Ensure audit directory exists
  const auditDir = path.dirname(AUDIT_OUTPUT_PATH);
  if (!fs.existsSync(auditDir)) {
    fs.mkdirSync(auditDir, { recursive: true });
  }

  fs.writeFileSync(AUDIT_OUTPUT_PATH, JSON.stringify(jsonOutput, null, 2));
  if (!JSON_OUTPUT) {
    console.log(`\nAudit results saved to: ${AUDIT_OUTPUT_PATH}`);
  }
}

// Main
async function main() {
  try {
    const auditResult = auditOutletRegistry();
    const jsonOutput = generateJsonOutput(auditResult);

    if (JSON_OUTPUT) {
      // Output JSON to stdout
      console.log(JSON.stringify(jsonOutput, null, 2));
    } else {
      // Print console summary
      printReport(auditResult);
    }

    // Always save to file
    saveAuditResults(jsonOutput);

    // Handle --fix or --dry-run
    if (FIX_MODE || DRY_RUN) {
      applyFixes(auditResult, DRY_RUN);
    }

    // Handle --update
    if (UPDATE_MODE) {
      await updateRegistry(auditResult);
    }

    // Exit with appropriate code
    if (auditResult.findings.missingFromRegistry.length > 0) {
      if (!JSON_OUTPUT && !UPDATE_MODE) {
        console.log('\n!!! Outlets missing from registry - add them to data/outlet-registry.json !!!');
      }
      process.exit(1);
    }

    process.exit(0);

  } catch (e) {
    if (JSON_OUTPUT) {
      console.error(JSON.stringify({ error: e.message }));
    } else {
      console.error(`Fatal error: ${e.message}`);
      console.error(e.stack);
    }
    process.exit(1);
  }
}

main();
