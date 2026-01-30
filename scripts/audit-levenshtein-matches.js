#!/usr/bin/env node

/**
 * Audit Levenshtein Matches
 *
 * This script identifies all critic pairs that are currently matched by
 * Levenshtein distance in areCriticsSimilar(). This audit is needed BEFORE
 * removing Levenshtein matching so we can add true positive typos to CRITIC_ALIASES.
 *
 * Usage:
 *   node scripts/audit-levenshtein-matches.js
 *
 * Output:
 *   data/audit/levenshtein-matches.json
 */

const fs = require('fs');
const path = require('path');
const {
  areCriticsSimilar,
  normalizeCritic,
  levenshteinDistance,
  CRITIC_ALIASES,
} = require('./lib/review-normalization');

const REVIEW_TEXTS_DIR = path.join(__dirname, '..', 'data', 'review-texts');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'audit', 'levenshtein-matches.json');

/**
 * Extract critic name from filename.
 * Format: {outlet}--{critic}.json -> critic
 */
function extractCriticFromFilename(filename) {
  if (!filename.endsWith('.json')) return null;
  if (filename === 'failed-fetches.json') return null;

  const match = filename.match(/^.+?--(.+)\.json$/);
  if (!match) return null;

  // Convert slug back to readable name
  return match[1].replace(/-/g, ' ');
}

/**
 * Determine WHY two critics match in areCriticsSimilar().
 * Returns: 'exact' | 'alias' | 'levenshtein' | 'none'
 */
function determineMatchType(critic1, critic2) {
  const c1 = critic1.toLowerCase().trim();
  const c2 = critic2.toLowerCase().trim();

  // Check exact match
  if (c1 === c2) {
    return 'exact';
  }

  // Check if normalized forms match (includes alias lookup)
  const n1 = normalizeCritic(critic1);
  const n2 = normalizeCritic(critic2);

  // If normalized forms are identical, check if it's due to an alias
  if (n1 === n2) {
    // Check if either name is in CRITIC_ALIASES
    const isAlias1 = Object.values(CRITIC_ALIASES).some(aliases =>
      aliases.includes(c1)
    );
    const isAlias2 = Object.values(CRITIC_ALIASES).some(aliases =>
      aliases.includes(c2)
    );

    if (isAlias1 || isAlias2) {
      return 'alias';
    }

    // Both names normalize to the same slug but not via alias
    // This means they're essentially the same name (e.g., "John Smith" and "john smith")
    return 'exact';
  }

  // Check Levenshtein match (the problematic case we're auditing)
  if (c1.length > 5 && c2.length > 5) {
    const distance = levenshteinDistance(c1, c2);
    if (distance <= 2) {
      return 'levenshtein';
    }
  }

  return 'none';
}

/**
 * Get all unique critic names from a show directory.
 */
function getCriticsFromShow(showDir) {
  const critics = new Set();

  try {
    const files = fs.readdirSync(showDir);
    for (const file of files) {
      const critic = extractCriticFromFilename(file);
      if (critic) {
        critics.add(critic);
      }
    }
  } catch (err) {
    console.error(`Error reading directory ${showDir}: ${err.message}`);
  }

  return Array.from(critics);
}

/**
 * Get files for a critic in a show directory.
 */
function getFilesForCritic(showDir, criticSlug) {
  const files = [];
  const allFiles = fs.readdirSync(showDir);

  for (const file of allFiles) {
    if (file.includes(`--${criticSlug}.json`)) {
      files.push(file);
    }
  }

  return files;
}

/**
 * Main audit function.
 */
function auditLevenshteinMatches() {
  console.log('Auditing Levenshtein matches in areCriticsSimilar()...\n');

  const results = {
    generatedAt: new Date().toISOString(),
    summary: {
      totalPairsChecked: 0,
      exactMatches: 0,
      aliasMatches: 0,
      levenshteinMatches: 0,
    },
    levenshteinMatches: [],
  };

  // Get all show directories
  const showDirs = fs.readdirSync(REVIEW_TEXTS_DIR)
    .filter(f => {
      const fullPath = path.join(REVIEW_TEXTS_DIR, f);
      return fs.statSync(fullPath).isDirectory();
    });

  console.log(`Found ${showDirs.length} show directories\n`);

  // Track all Levenshtein matches globally (to find cross-show patterns)
  const allLevenshteinPairs = new Map(); // "name1|name2" -> [occurrences]

  for (const showId of showDirs) {
    const showDir = path.join(REVIEW_TEXTS_DIR, showId);
    const critics = getCriticsFromShow(showDir);

    // Check all pairs of critics in this show
    for (let i = 0; i < critics.length; i++) {
      for (let j = i + 1; j < critics.length; j++) {
        const critic1 = critics[i];
        const critic2 = critics[j];

        results.summary.totalPairsChecked++;

        // Check if areCriticsSimilar returns true
        if (areCriticsSimilar(critic1, critic2)) {
          const matchType = determineMatchType(critic1, critic2);

          switch (matchType) {
            case 'exact':
              results.summary.exactMatches++;
              break;
            case 'alias':
              results.summary.aliasMatches++;
              break;
            case 'levenshtein':
              results.summary.levenshteinMatches++;

              // Get the files for these critics
              const slug1 = normalizeCritic(critic1);
              const slug2 = normalizeCritic(critic2);
              const files1 = getFilesForCritic(showDir, slug1);
              const files2 = getFilesForCritic(showDir, slug2);

              const distance = levenshteinDistance(
                critic1.toLowerCase().trim(),
                critic2.toLowerCase().trim()
              );

              // Create a canonical key for this pair
              const pairKey = [critic1, critic2].sort().join('|');

              if (!allLevenshteinPairs.has(pairKey)) {
                allLevenshteinPairs.set(pairKey, []);
              }

              allLevenshteinPairs.get(pairKey).push({
                showId,
                files: [...files1, ...files2],
              });

              break;
          }
        }
      }
    }
  }

  // Consolidate Levenshtein matches
  for (const [pairKey, occurrences] of allLevenshteinPairs) {
    const [name1, name2] = pairKey.split('|');
    const distance = levenshteinDistance(
      name1.toLowerCase().trim(),
      name2.toLowerCase().trim()
    );

    // Collect all shows and files
    const shows = occurrences.map(o => o.showId);
    const allFiles = occurrences.flatMap(o => o.files);

    results.levenshteinMatches.push({
      name1,
      name2,
      distance,
      showCount: shows.length,
      shows: shows.slice(0, 5), // Limit to first 5 shows for brevity
      sampleFiles: allFiles.slice(0, 4), // Limit to first 4 files
      verdict: 'unknown', // To be manually determined
    });
  }

  // Sort by distance (lower = more likely to be same person)
  results.levenshteinMatches.sort((a, b) => a.distance - b.distance);

  return results;
}

/**
 * Main entry point.
 */
function main() {
  try {
    // Ensure audit directory exists
    const auditDir = path.dirname(OUTPUT_FILE);
    if (!fs.existsSync(auditDir)) {
      fs.mkdirSync(auditDir, { recursive: true });
    }

    const results = auditLevenshteinMatches();

    // Write results
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));

    // Print summary
    console.log('\n=== AUDIT SUMMARY ===');
    console.log(`Total pairs checked: ${results.summary.totalPairsChecked}`);
    console.log(`Exact matches: ${results.summary.exactMatches}`);
    console.log(`Alias matches: ${results.summary.aliasMatches}`);
    console.log(`Levenshtein matches: ${results.summary.levenshteinMatches}`);
    console.log(`\nUnique Levenshtein-matched pairs: ${results.levenshteinMatches.length}`);

    if (results.levenshteinMatches.length > 0) {
      console.log('\n=== LEVENSHTEIN MATCHES (need manual review) ===');
      for (const match of results.levenshteinMatches) {
        console.log(`\n  "${match.name1}" vs "${match.name2}"`);
        console.log(`    Distance: ${match.distance}`);
        console.log(`    Shows: ${match.shows.join(', ')}${match.showCount > 5 ? ` (+${match.showCount - 5} more)` : ''}`);
      }
    } else {
      console.log('\nNo Levenshtein-only matches found!');
    }

    console.log(`\nResults saved to: ${OUTPUT_FILE}`);

  } catch (err) {
    console.error('Error during audit:', err);
    process.exit(1);
  }
}

main();
