#!/usr/bin/env node

/**
 * Audit Normalization Inconsistencies
 *
 * Compares outlet normalization across three files:
 * 1. scripts/lib/review-normalization.js - the canonical source (OUTLET_ALIASES object)
 * 2. scripts/extract-bww-reviews.js - has outletNormalization object
 * 3. scripts/extract-dtli-reviews.js - has outletNormalization object
 *
 * Identifies:
 * - Conflicts: same outlet name maps to different IDs in different files
 * - Missing from canonical: outlets in BWW/DTLI not in the canonical source
 * - Suggestions for aliases to add to canonical
 *
 * Output: data/audit/normalization-diff.json
 */

const fs = require('fs');
const path = require('path');

const CANONICAL_PATH = path.join(__dirname, 'lib/review-normalization.js');
const BWW_PATH = path.join(__dirname, 'extract-bww-reviews.js');
const DTLI_PATH = path.join(__dirname, 'extract-dtli-reviews.js');
const OUTPUT_PATH = path.join(__dirname, '../data/audit/normalization-diff.json');

/**
 * Parse OUTLET_ALIASES from review-normalization.js
 * Returns: { canonicalId: [alias1, alias2, ...], ... }
 */
function parseCanonical(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');

  // Extract the OUTLET_ALIASES object
  const match = content.match(/const OUTLET_ALIASES\s*=\s*\{([\s\S]*?)\n\};/);
  if (!match) {
    throw new Error('Could not find OUTLET_ALIASES in canonical file');
  }

  const aliasBlock = match[1];
  const result = {};

  // Parse each canonical entry
  // Pattern: 'canonical-id': ['alias1', 'alias2', ...]
  const entryPattern = /'([^']+)':\s*\[([\s\S]*?)\]/g;
  let entryMatch;

  while ((entryMatch = entryPattern.exec(aliasBlock)) !== null) {
    const canonicalId = entryMatch[1];
    const aliasesStr = entryMatch[2];

    // Extract individual aliases
    const aliases = [];
    const aliasPattern = /'([^']+)'/g;
    let aliasMatch;
    while ((aliasMatch = aliasPattern.exec(aliasesStr)) !== null) {
      aliases.push(aliasMatch[1].toLowerCase());
    }

    result[canonicalId] = aliases;
  }

  return result;
}

/**
 * Parse outletNormalization from BWW or DTLI extraction scripts
 * Returns: { outletNameLower: outletId, ... }
 */
function parseExtractor(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');

  // Extract the outletNormalization object
  const match = content.match(/const outletNormalization\s*=\s*\{([\s\S]*?)\n\};/);
  if (!match) {
    throw new Error(`Could not find outletNormalization in ${filePath}`);
  }

  const normBlock = match[1];
  const result = {};

  // Parse each entry
  // Pattern: 'outlet name': { name: '...', outletId: 'id', ... }
  const entryPattern = /'([^']+)':\s*\{[^}]*outletId:\s*'([^']+)'/g;
  let entryMatch;

  while ((entryMatch = entryPattern.exec(normBlock)) !== null) {
    const outletName = entryMatch[1].toLowerCase();
    const outletId = entryMatch[2];
    result[outletName] = outletId;
  }

  return result;
}

/**
 * Build a reverse lookup from canonical: alias -> canonicalId
 */
function buildCanonicalLookup(canonical) {
  const lookup = {};
  for (const [canonicalId, aliases] of Object.entries(canonical)) {
    for (const alias of aliases) {
      lookup[alias] = canonicalId;
    }
  }
  return lookup;
}

/**
 * Main audit function
 */
function auditNormalization() {
  console.log('Parsing normalization files...\n');

  // Parse all three files
  const canonical = parseCanonical(CANONICAL_PATH);
  const bww = parseExtractor(BWW_PATH);
  const dtli = parseExtractor(DTLI_PATH);

  console.log(`Canonical (review-normalization.js): ${Object.keys(canonical).length} outlet IDs`);
  console.log(`BWW (extract-bww-reviews.js): ${Object.keys(bww).length} outlet mappings`);
  console.log(`DTLI (extract-dtli-reviews.js): ${Object.keys(dtli).length} outlet mappings`);
  console.log('');

  // Build reverse lookup for canonical
  const canonicalLookup = buildCanonicalLookup(canonical);

  // Find conflicts and missing entries
  const conflicts = [];
  const missingFromCanonical = [];
  const aliasesToAdd = {};

  // Check BWW mappings
  for (const [outletName, bwwId] of Object.entries(bww)) {
    const canonicalId = canonicalLookup[outletName];
    const dtliId = dtli[outletName] || null;

    if (canonicalId) {
      // Check for conflicts
      if (canonicalId !== bwwId) {
        conflicts.push({
          outletName,
          canonical: canonicalId,
          bww: bwwId,
          dtli: dtliId
        });

        // Suggest adding BWW's mapping as an alias (if it produces different files)
        if (!aliasesToAdd[canonicalId]) {
          aliasesToAdd[canonicalId] = [];
        }
        if (!aliasesToAdd[canonicalId].includes(bwwId) && bwwId !== canonicalId) {
          aliasesToAdd[canonicalId].push(bwwId);
        }
      }
    } else {
      // Not in canonical
      missingFromCanonical.push({
        outletName,
        bwwId,
        dtliId
      });
    }
  }

  // Check DTLI mappings not already in BWW
  for (const [outletName, dtliId] of Object.entries(dtli)) {
    if (bww[outletName]) continue; // Already checked via BWW

    const canonicalId = canonicalLookup[outletName];

    if (canonicalId) {
      // Check for conflicts
      if (canonicalId !== dtliId) {
        conflicts.push({
          outletName,
          canonical: canonicalId,
          bww: null,
          dtli: dtliId
        });

        // Suggest adding DTLI's mapping as an alias
        if (!aliasesToAdd[canonicalId]) {
          aliasesToAdd[canonicalId] = [];
        }
        if (!aliasesToAdd[canonicalId].includes(dtliId) && dtliId !== canonicalId) {
          aliasesToAdd[canonicalId].push(dtliId);
        }
      }
    } else {
      // Not in canonical
      missingFromCanonical.push({
        outletName,
        bwwId: null,
        dtliId
      });
    }
  }

  // Check for BWW vs DTLI conflicts (same outlet name, different IDs between extractors)
  for (const [outletName, bwwId] of Object.entries(bww)) {
    const dtliId = dtli[outletName];
    if (dtliId && bwwId !== dtliId) {
      // Find existing conflict or add new one
      const existingConflict = conflicts.find(c => c.outletName === outletName);
      if (!existingConflict) {
        conflicts.push({
          outletName,
          canonical: canonicalLookup[outletName] || null,
          bww: bwwId,
          dtli: dtliId,
          note: 'BWW and DTLI disagree'
        });
      }
    }
  }

  // Remove duplicates from aliasesToAdd
  for (const canonicalId of Object.keys(aliasesToAdd)) {
    aliasesToAdd[canonicalId] = [...new Set(aliasesToAdd[canonicalId])];
    if (aliasesToAdd[canonicalId].length === 0) {
      delete aliasesToAdd[canonicalId];
    }
  }

  // Sort results
  conflicts.sort((a, b) => a.outletName.localeCompare(b.outletName));
  missingFromCanonical.sort((a, b) => a.outletName.localeCompare(b.outletName));

  // Build output
  const output = {
    summary: {
      totalConflicts: conflicts.length,
      missingFromCanonical: missingFromCanonical.length,
      scriptsAnalyzed: [
        'review-normalization.js',
        'extract-bww-reviews.js',
        'extract-dtli-reviews.js'
      ],
      generatedAt: new Date().toISOString()
    },
    conflicts,
    missingFromCanonical,
    aliasesToAdd
  };

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Write output
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output, null, 2));

  // Print summary
  console.log('='.repeat(60));
  console.log('NORMALIZATION AUDIT RESULTS');
  console.log('='.repeat(60));
  console.log('');

  console.log(`CONFLICTS: ${conflicts.length}`);
  if (conflicts.length > 0) {
    console.log('-'.repeat(40));
    for (const c of conflicts) {
      console.log(`  "${c.outletName}"`);
      console.log(`    canonical: ${c.canonical || '(not found)'}`);
      console.log(`    bww:       ${c.bww || '(not mapped)'}`);
      console.log(`    dtli:      ${c.dtli || '(not mapped)'}`);
      if (c.note) console.log(`    note:      ${c.note}`);
      console.log('');
    }
  }
  console.log('');

  console.log(`MISSING FROM CANONICAL: ${missingFromCanonical.length}`);
  if (missingFromCanonical.length > 0) {
    console.log('-'.repeat(40));
    for (const m of missingFromCanonical) {
      console.log(`  "${m.outletName}"`);
      if (m.bwwId) console.log(`    bww maps to: ${m.bwwId}`);
      if (m.dtliId) console.log(`    dtli maps to: ${m.dtliId}`);
    }
  }
  console.log('');

  if (Object.keys(aliasesToAdd).length > 0) {
    console.log('SUGGESTED ALIASES TO ADD TO CANONICAL:');
    console.log('-'.repeat(40));
    for (const [canonicalId, aliases] of Object.entries(aliasesToAdd)) {
      console.log(`  '${canonicalId}': add ${JSON.stringify(aliases)}`);
    }
    console.log('');
  }

  console.log(`Output saved to: ${OUTPUT_PATH}`);

  return output;
}

// Run
auditNormalization();
