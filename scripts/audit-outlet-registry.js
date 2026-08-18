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
 *   node scripts/audit-outlet-registry.js               # Console summary output, always exits 0 (advisory)
 *   node scripts/audit-outlet-registry.js --json        # Full JSON output to stdout
 *   node scripts/audit-outlet-registry.js --fix         # Audit and fix display name/normalization issues
 *   node scripts/audit-outlet-registry.js --dry-run     # Show what --fix would do
 *   node scripts/audit-outlet-registry.js --update      # Add missing outlets to registry (with confirmation)
 *   node scripts/audit-outlet-registry.js --strict          # Exit 1 on NEW (non-baselined) missing outlets
 *   node scripts/audit-outlet-registry.js --update-baseline # Regenerate the baseline from current scan
 *
 * Baseline-diff (task #1666), mirrors audit-broadway-category-predicate.js
 * (task #1665): the pre-existing missing-outlet backlog is frozen in
 * data/audit/outlet-registry-baseline.json and never fails CI — only a NEW
 * outletId not in that baseline fails under --strict. Identity is just
 * outletId (a plain Set, not a multiset) — see scripts/lib/outlet-registry-
 * baseline.js for why that's safe here despite the predicate script needing
 * occurrence-count matching.
 *
 * Default mode (no flags) always exits 0 — report only, matching the sibling
 * gate's advisory-first convention now that test.yml calls --strict directly.
 * (Prior to task #1666 default mode exited 1 on any missing outlet; nothing
 * depended on that — the only caller was CI, already run with --report-only.)
 *
 * Wired into .github/workflows/test.yml with --strict, no continue-on-error.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { listShowDirs } = require('./lib/list-show-dirs');
const { baselineKeySet, computeNewViolators } = require('./lib/outlet-registry-baseline');
const { assertCorpusScanned, CorpusNotScannedError } = require('./lib/corpus-scan-guard');
const { isNonReviewDemotedByFreshCV, isRejectedNonReview } = require('./lib/review-guards');

// Paths
const REGISTRY_PATH = path.join(__dirname, '../data/outlet-registry.json');
const REVIEW_TEXTS_DIR = path.join(__dirname, '../data/review-texts');
const AUDIT_OUTPUT_PATH = path.join(__dirname, '../data/audit/outlet-registry-gaps.json');
const NORMALIZATION_PATH = path.join(__dirname, './lib/review-normalization.js');
const BASELINE_PATH = path.join(__dirname, '../data/audit/outlet-registry-baseline.json');
// Separate baseline for pre-existing exact-sentinel registry entries (task
// #1783). Same reasoning as BASELINE_PATH: a handful of these (e.g.
// "lets-note", "lets-go-to-the-theater") carry a manually-curated
// defaultCritic field, so they may be legitimate outlets that happen to
// share a literal reserved word, not scraper garbage like "unknown" was —
// blind deletion risks destroying real curation. Baselined so --strict
// only fails on a NEWLY introduced sentinel id, not this pre-existing
// backlog (which needs individual investigation, tracked separately).
const JUNK_BASELINE_PATH = path.join(__dirname, '../data/audit/outlet-registry-junk-baseline.json');

function loadJunkBaseline() {
  try {
    return JSON.parse(fs.readFileSync(JUNK_BASELINE_PATH, 'utf-8'));
  } catch {
    return { outletIds: [] };
  }
}

// Parse command line args
const args = process.argv.slice(2);
const FIX_MODE = args.includes('--fix');
const DRY_RUN = args.includes('--dry-run');
const JSON_OUTPUT = args.includes('--json');
const UPDATE_MODE = args.includes('--update');
const AUTO_MODE = args.includes('--auto'); // Skip confirmation prompts (for CI)
const STRICT = args.includes('--strict'); // Exit 1 on NEW (non-baselined) missing outlets
const UPDATE_BASELINE = args.includes('--update-baseline');

function loadBaseline() {
  try {
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
  } catch {
    return { outletIds: [] };
  }
}

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

  const showDirs = listShowDirs(REVIEW_TEXTS_DIR).filter(f => {
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
function suggestRegistryEntry(outletId, displayNames = [], count = 0, urls = []) {
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

  // Domain hint, majority-voted from this outlet's own review URLs and
  // filtered through the same blocked-host list as the SERP guard — task
  // #766. Falls back to null (still surfaced in the printed report so it's
  // never silently wrong) only when no URL yields a usable host.
  const { inferOutletDomainHint } = require('./lib/outlet-domain-hint');
  const domain = inferOutletDomainHint(urls);

  return {
    outletId,
    displayName,
    tier: 3, // Default to tier 3 for unknown outlets
    aliases,
    domain
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
    junkEntriesInRegistry: [],    // Junk/sentinel ids or aliases already IN the registry (task #1783)
    skippedJunkOutlets: [],        // outletIds seen in reviews but never suggested — isJunkOutlet (task #1783)
  };

  // A reserved-sentinel id (e.g. "unknown" — literally what
  // normalizeOutlet()/normalizeCritic() themselves return as a fallback)
  // must never exist as a registry canonical id OR alias — either one
  // poisons normalizeOutlet's alias map and hijacks every input that shares
  // its prefix (task #1783: a poisoned "unknown" entry broke
  // normalizeOutlet('Unknown Publication 123') and
  // getOutletDisplayName('unknown-outlet') for months undetected because no
  // gate ever checked the registry's OWN keys/aliases, only what reviews
  // were missing from it).
  //
  // Deliberately uses isSentinelOutletId (exact reserved-word match), NOT
  // the broader isJunkOutlet (which also fires on structural fuzz — long
  // slugs, many hyphens, sentence-fragment regexes). A pre-existing,
  // separate backlog of sentence-fragment junk ids already lives in the
  // registry (e.g. "keep-things-speeding-along") — using isJunkOutlet here
  // would fail --strict on all of them the instant this check landed. Exact
  // sentinel words are categorically different: there is no legitimate
  // reading of a registry outlet literally named "unknown".
  if (normalization && normalization.isSentinelOutletId) {
    for (const [outletId, data] of Object.entries(registry.outlets || {})) {
      if (outletId === '_aliasIndex' || outletId === '_meta') continue;
      if (normalization.isSentinelOutletId(outletId)) {
        findings.junkEntriesInRegistry.push({ outletId, matchedOn: 'id' });
        continue;
      }
      for (const alias of (data.aliases || [])) {
        if (normalization.isSentinelOutletId(alias)) {
          findings.junkEntriesInRegistry.push({ outletId, matchedOn: 'alias', alias });
        }
      }
    }
  }

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

      // Files already flagged by the content-quality pipeline as not being a
      // review at all (ticket/hotel-booking/venue pages ingested by mistake,
      // isNonReviewReason explains why) never need a registry entry — that's
      // the outlet-registration equivalent of registering a 404 page. Without
      // this, every new junk URL the aggregator-gap ingester picks up trips
      // --strict again (task #1756, main red 9h+: charingcrosstheatre,
      // londontopia, hoteldirect all hit this in one show in under a day).
      //
      // isNonReviewDemotedByFreshCV guard (task #1756 ship-check finding):
      // isNonReview:true is NOT a reliable "never scored" signal on its own —
      // rebuild-all-reviews.js's canonical inclusion predicate (review-guards.js)
      // ignores a stale isNonReview flag when a newer content-verification pass
      // affirms the article IS a review (the Telegraph class, #1255), and
      // nothing re-clears the on-disk flag when that happens. Re-deriving
      // "isNonReview means excluded" here instead of calling the same function
      // rebuild-all-reviews.js uses would silently hide a real registry gap for
      // an outlet that's actually being scored (memory: includability
      // predicates must be canonical).
      if (review.isNonReview === true && !isNonReviewDemotedByFreshCV(review)) continue;

      // Same purpose, the OTHER exclusion pipeline: ensemble-scoreability-check
      // rejects ingest-time junk (ticket-vendor/venue/aggregator/preview pages)
      // via rejectionReason/contentVerification/contentTier rather than
      // isNonReview. audit-unknown-outlets.js already treats isRejectedNonReview
      // as the canonical "this outletId never needs a registry entry" check
      // (scripts/audit-unknown-outlets.js:55) — mirrored here so this audit
      // doesn't re-derive its own narrower version of the same predicate.
      if (isRejectedNonReview(review)) continue;

      // Track this outlet
      if (!outletsInReviews.has(reviewOutletId)) {
        outletsInReviews.set(reviewOutletId, {
          count: 0,
          displayNames: [],
          files: [],
          urls: [],
          shows: new Set()
        });
      }
      const outletData = outletsInReviews.get(reviewOutletId);
      outletData.count++;
      if (reviewOutlet) outletData.displayNames.push(reviewOutlet);
      outletData.files.push(reviewFile.fullPath);
      if (review.url) outletData.urls.push(review.url);
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
  // Also check normalization module — if normalizeOutlet() resolves to a known
  // canonical outlet, it's not truly missing (just a denormalized variant)
  const missingOutlets = new Map();
  for (const [outletId, data] of outletsInReviews) {
    const registryCanonical = registryAliasMap[outletId.toLowerCase()];
    if (!registryCanonical) {
      // Never suggest a scraping-artifact/sentinel outletId (e.g. "unknown")
      // for registration — task #1783: an "unknown" registry entry hijacked
      // every Unknown-prefixed fallback outlet via normalizeOutlet's
      // concatenated outlet-critic prefix match.
      if (normalization && normalization.isJunkOutlet && normalization.isJunkOutlet(outletId)) {
        // Logged (not silent) — isJunkOutlet's structural heuristics (long
        // slug, many hyphens, sentence-fragment patterns) are heuristic, not
        // exact, so a genuinely-missing legit outlet that happens to match
        // must leave a trace an operator can investigate, matching
        // updateRegistry()'s skippedJunk logging below.
        findings.skippedJunkOutlets.push({ outletId, count: data.count });
        continue;
      }
      // Check if the normalization module can resolve this to a known outlet
      let resolvedByNorm = false;
      if (normalization) {
        const normCanonical = normalization.normalizeOutlet(outletId);
        if (normCanonical !== outletId && registry.outlets[normCanonical]) {
          resolvedByNorm = true;
        }
      }
      if (!resolvedByNorm && !missingOutlets.has(outletId)) {
        missingOutlets.set(outletId, {
          outletId,
          count: data.count,
          shows: Array.from(data.shows),
          exampleFile: data.files[0],
          displayNames: [...new Set(data.displayNames)], // Unique display names
          urls: data.urls
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
    suggestRegistryEntry(missing.outletId, missing.displayNames, missing.count, missing.urls)
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
  console.log(`  Unused in registry: ${findings.unusedInRegistry.length} outlets`);
  if (findings.skippedJunkOutlets.length > 0) {
    console.log(`  Skipped as junk (never suggested): ${findings.skippedJunkOutlets.length} outlets`);
  }
  console.log('');

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

  // Skipped as junk — never suggested (task #1783 logging-asymmetry fix):
  // isJunkOutlet's heuristics can false-positive on a genuinely-missing
  // outlet, so this must leave a visible trace, same as updateRegistry()'s
  // skippedJunk log.
  if (findings.skippedJunkOutlets.length > 0) {
    console.log('Skipped as junk (never suggested for registration):');
    for (const skipped of findings.skippedJunkOutlets.slice(0, 20)) {
      console.log(`  ${skipped.outletId} (${skipped.count} reviews) — matches isJunkOutlet()`);
    }
    if (findings.skippedJunkOutlets.length > 20) {
      console.log(`  ... and ${findings.skippedJunkOutlets.length - 20} more`);
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
    registryNormalizationConflicts: findings.registryNormalizationConflicts,
    junkEntriesInRegistry: findings.junkEntriesInRegistry,
    skippedJunkOutlets: findings.skippedJunkOutlets
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

// Check if an outlet ID is a slugified variant of an existing canonical outlet.
// This prevents adding bogus entries like "new-york-times" when "nytimes" already exists.
function wouldShadowCanonical(outletId, registry) {
  const normalization = loadNormalization();
  if (!normalization || !normalization.OUTLET_ALIASES) return null;

  const lower = outletId.toLowerCase();
  const withoutThe = lower.replace(/^the-/, '');

  // Check if this ID appears as an alias of any canonical outlet
  for (const [canonical, aliases] of Object.entries(normalization.OUTLET_ALIASES)) {
    // Skip if this IS the canonical outlet (shouldn't happen, but be safe)
    if (lower === canonical) continue;
    for (const alias of aliases) {
      const aliasSlug = alias.replace(/\s+/g, '-').toLowerCase();
      if (lower === alias || lower === aliasSlug || withoutThe === alias || withoutThe === aliasSlug) {
        return canonical;
      }
    }
  }

  // Also check if this ID is a prefix match for a known canonical outlet
  // e.g., "chicago-sun-times-catey-sullivan" starts with "chicago-sun-times"
  for (const [canonical, aliases] of Object.entries(normalization.OUTLET_ALIASES)) {
    for (const alias of aliases) {
      const aliasSlug = alias.replace(/\s+/g, '-').toLowerCase();
      if (aliasSlug.length > 5 && lower.startsWith(aliasSlug + '-') && lower.length > aliasSlug.length + 3) {
        return canonical;
      }
    }
  }

  // Check against existing registry entries' display names (slugified)
  for (const [existingId, data] of Object.entries(registry.outlets)) {
    if (lower === existingId) continue;
    const displaySlug = (data.displayName || '').replace(/\s+/g, '-').toLowerCase();
    if (displaySlug && (lower === displaySlug || withoutThe === displaySlug)) {
      return existingId;
    }
  }

  return null;
}

// Add missing outlets to registry
async function updateRegistry(auditResult) {
  const { suggestedAdditions, findings } = auditResult;

  if (findings.missingFromRegistry.length === 0) {
    console.log('\nNo missing outlets to add to registry.');
    return;
  }

  // Filter out entries that would shadow existing canonical outlets
  const registry = loadRegistry();
  const normalization = loadNormalization();
  const safeAdditions = [];
  const skippedShadows = [];
  const skippedJunk = [];

  for (const entry of suggestedAdditions) {
    // Defense-in-depth (task #1783): the missingFromRegistry scan already
    // excludes junk/sentinel outletIds like "unknown", but never write one
    // here either — a poisoned "unknown" entry hijacks every Unknown-prefixed
    // outlet via normalizeOutlet's concatenated outlet-critic prefix match.
    if (normalization && normalization.isJunkOutlet && normalization.isJunkOutlet(entry.outletId)) {
      skippedJunk.push(entry.outletId);
      continue;
    }
    const shadowsCanonical = wouldShadowCanonical(entry.outletId, registry);
    if (shadowsCanonical) {
      skippedShadows.push({ outletId: entry.outletId, canonical: shadowsCanonical });
    } else {
      safeAdditions.push(entry);
    }
  }

  if (skippedJunk.length > 0) {
    console.log('\n=== SKIPPED (junk/sentinel outletId, never registered) ===\n');
    for (const outletId of skippedJunk) {
      console.log(`  ✗ "${outletId}" → refused, matches isJunkOutlet()`);
    }
  }

  if (skippedShadows.length > 0) {
    console.log('\n=== SKIPPED (shadow existing canonical outlets) ===\n');
    for (const { outletId, canonical } of skippedShadows) {
      console.log(`  ✗ "${outletId}" → already covered by canonical "${canonical}"`);
    }
  }

  if (safeAdditions.length === 0) {
    console.log('\nNo new outlets to add (all were variants of existing canonical outlets).');
    return;
  }

  console.log('\n=== SUGGESTED REGISTRY ADDITIONS ===\n');
  for (const entry of safeAdditions) {
    console.log(`  ${entry.outletId}:`);
    console.log(`    displayName: "${entry.displayName}"`);
    console.log(`    tier: ${entry.tier}`);
    console.log(`    aliases: ${JSON.stringify(entry.aliases)}`);
    console.log(`    domain: ${entry.domain ? `"${entry.domain}"` : 'null (no usable host in this outlet\'s review URLs — SERP discovery will skip it, task #766)'}`);
    console.log('');
  }

  if (!AUTO_MODE) {
    const confirmed = await askConfirmation(
      `Add ${safeAdditions.length} outlets to registry? (y/n): `
    );
    if (!confirmed) {
      console.log('Aborted.');
      return;
    }
  } else {
    console.log(`\nAuto-adding ${safeAdditions.length} outlets (--auto mode)...`);
  }

  for (const entry of safeAdditions) {
    registry.outlets[entry.outletId] = {
      displayName: entry.displayName,
      tier: entry.tier,
      aliases: entry.aliases,
      // Inferred from this outlet's own review URLs (task #766) — only null
      // when no review URL yielded a usable, non-blocked host.
      domain: entry.domain || null
    };
  }

  // Update lastUpdated in _meta
  if (registry._meta) {
    registry._meta.lastUpdated = new Date().toISOString();
  }

  // Write back
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(registry, null, 2));
  console.log(`\nAdded ${safeAdditions.length} outlets to ${REGISTRY_PATH}`);
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

    // FAIL LOUD on an empty corpus (task #1666, same pattern as
    // audit-review-contamination.js's GATE check) — a missing/empty
    // data/review-texts checkout scans 0 files, leaving missingFromRegistry
    // empty and both --strict and --update-baseline would otherwise report a
    // vacuous "0 missing outlets" instead of failing closed.
    try {
      assertCorpusScanned(auditResult.totalReviewFiles, { gate: STRICT || UPDATE_BASELINE });
    } catch (e) {
      if (!(e instanceof CorpusNotScannedError)) throw e;
      console.error(`\n❌ ${e.message}`);
      process.exit(1);
    }

    // --update-baseline: regenerate the baseline from the current scan and exit,
    // bypassing --fix/--update/report output (mirrors audit-broadway-category-predicate.js).
    if (UPDATE_BASELINE) {
      const baseline = {
        generatedAt: new Date().toISOString().slice(0, 10),
        outletIds: auditResult.findings.missingFromRegistry.map(m => m.outletId).sort(),
      };
      fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
      fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
      console.log(`✅ Baseline updated: ${baseline.outletIds.length} known missing outlet(s) (${BASELINE_PATH})`);

      const junkBaseline = {
        generatedAt: new Date().toISOString().slice(0, 10),
        outletIds: auditResult.findings.junkEntriesInRegistry.map(j => j.outletId).sort(),
      };
      fs.writeFileSync(JUNK_BASELINE_PATH, JSON.stringify(junkBaseline, null, 2) + '\n');
      console.log(`✅ Junk baseline updated: ${junkBaseline.outletIds.length} known sentinel outletId(s) (${JUNK_BASELINE_PATH})`);
      process.exit(0);
    }

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

    const baselineSet = baselineKeySet(loadBaseline().outletIds);
    const newViolators = computeNewViolators(auditResult.findings.missingFromRegistry, baselineSet);

    if (auditResult.findings.missingFromRegistry.length > 0 && !JSON_OUTPUT && !UPDATE_MODE) {
      console.log('\n!!! Outlets missing from registry - add them to data/outlet-registry.json !!!');
      console.log(`    (${auditResult.findings.missingFromRegistry.length - newViolators.length} baselined, ${newViolators.length} new)`);
    }

    const junkBaselineSet = baselineKeySet(loadJunkBaseline().outletIds);
    const newJunkViolators = computeNewViolators(auditResult.findings.junkEntriesInRegistry, junkBaselineSet);

    if (auditResult.findings.junkEntriesInRegistry.length > 0 && !JSON_OUTPUT) {
      console.log(`\n⚠️  Sentinel/reserved-word entries already IN the registry:`);
      for (const j of auditResult.findings.junkEntriesInRegistry) {
        const tag = junkBaselineSet.has(j.outletId) ? '(baselined)' : '(NEW)';
        console.log(j.matchedOn === 'id'
          ? `  "${j.outletId}" ${tag} — the id itself matches a reserved word`
          : `  "${j.outletId}" ${tag} — alias "${j.alias}" matches a reserved word`);
      }
      console.log(`  A NEW entry must be deleted from data/outlet-registry.json — do not rename or merge.`);
    }

    if (STRICT) {
      if (newViolators.length > 0 || newJunkViolators.length > 0) {
        if (!JSON_OUTPUT) {
          if (newViolators.length > 0) {
            console.log(`\n⚠️  NEW outlet(s) missing from registry, not in the baseline (${BASELINE_PATH}):`);
            for (const v of newViolators) console.log(`  ${v.outletId} (${v.count} reviews)`);
            console.log(`\nAdd them to data/outlet-registry.json, or if this is deliberate progress, refresh the baseline:`);
            console.log(`  node scripts/audit-outlet-registry.js --update-baseline`);
          }
          if (newJunkViolators.length > 0) {
            console.log(`\n⚠️  NEW sentinel/reserved-word outletId(s) in the registry, not in the junk baseline (${JUNK_BASELINE_PATH}):`);
            for (const v of newJunkViolators) console.log(`  "${v.outletId}"`);
            console.log(`  Delete these from data/outlet-registry.json (task #1783 class of bug) — do not rename or merge.`);
          }
        }
        process.exit(1);
      }
      process.exit(0);
    }

    process.exit(0); // advisory-first: default mode never fails the build

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
