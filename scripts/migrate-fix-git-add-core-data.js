#!/usr/bin/env node
/**
 * Migration script: Fix git add commands to remove core data file references.
 *
 * After gitignoring core data files, `git add data/shows.json` will fail (exit 1).
 * This script strips core data paths from git add commands, keeping non-core paths.
 *
 * Usage: node scripts/migrate-fix-git-add-core-data.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

const WORKFLOW_DIR = path.join(__dirname, '..', '.github', 'workflows');

// Core data files that will be gitignored
const CORE_DATA_PATHS = new Set([
  'data/shows.json',
  'data/reviews.json',
  'data/grosses.json',
  'data/grosses-history.json',
  'data/commercial.json',
  'data/audience-buzz.json',
  'data/critic-consensus.json',
  'data/critic-registry.json',
  'data/outlet-registry.json',
]);

function processLine(line) {
  // Only process lines with git add that reference data/ paths
  if (!line.includes('git add') || !line.includes('data/')) return null;

  // Skip git add -A (works correctly with gitignored files)
  if (/git add -A/.test(line)) return null;

  // Skip comments
  if (line.trim().startsWith('#')) return null;

  // Check if any core data file is referenced
  const hasCoreData = Array.from(CORE_DATA_PATHS).some(p => line.includes(p));
  if (!hasCoreData) return null;

  // Extract the git add command and its paths
  // Pattern: git add PATH1 PATH2 PATH3 [suffix like 2>/dev/null || true]
  const match = line.match(/^(\s*)(git add\s+)(.+)$/);
  if (!match) return null;

  const indent = match[1];
  const gitAddPrefix = match[2];
  let pathsAndSuffix = match[3];

  // Separate trailing shell operators from paths
  let suffix = '';
  const suffixMatch = pathsAndSuffix.match(/(\s*(?:2>\/dev\/null\s*)?(?:\|\|\s*true)?\s*)$/);
  if (suffixMatch && suffixMatch[1].trim()) {
    suffix = suffixMatch[1];
    pathsAndSuffix = pathsAndSuffix.slice(0, -suffixMatch[1].length);
  }

  // Split into individual paths
  const allPaths = pathsAndSuffix.trim().split(/\s+/);

  // Filter out core data paths
  const remainingPaths = allPaths.filter(p => !CORE_DATA_PATHS.has(p));

  if (remainingPaths.length === 0) {
    // All paths were core data — replace with comment
    return `${indent}# Core data files pushed to private repo by push-core-data action`;
  }

  // Reconstruct with remaining paths
  return `${indent}${gitAddPrefix}${remainingPaths.join(' ')}${suffix}`;
}

function processWorkflow(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Quick check: does this file reference any core data in git add?
  const hasCoreGitAdd = Array.from(CORE_DATA_PATHS).some(p =>
    content.includes('git add') && content.includes(p)
  );
  if (!hasCoreGitAdd) return { modified: false, reason: 'no core data git add' };

  const lines = content.split('\n');
  let changes = 0;
  const changeDetails = [];

  for (let i = 0; i < lines.length; i++) {
    const newLine = processLine(lines[i]);
    if (newLine !== null && newLine !== lines[i]) {
      changeDetails.push({
        line: i + 1,
        old: lines[i].trim(),
        new: newLine.trim(),
      });
      if (!DRY_RUN) {
        lines[i] = newLine;
      }
      changes++;
    }
  }

  if (changes === 0) {
    return { modified: false, reason: 'no changes needed' };
  }

  if (!DRY_RUN) {
    fs.writeFileSync(filePath, lines.join('\n'));
  }

  return { modified: true, changes, details: changeDetails, dryRun: DRY_RUN };
}

// Main
const files = fs.readdirSync(WORKFLOW_DIR)
  .filter(f => f.endsWith('.yml'))
  .sort();

let modifiedCount = 0;
let totalChanges = 0;
const results = [];

for (const file of files) {
  const filePath = path.join(WORKFLOW_DIR, file);
  const result = processWorkflow(filePath);

  if (result.modified) {
    results.push(result);
    modifiedCount++;
    totalChanges += result.changes;
    console.log(`\n>> ${file}: ${result.changes} change(s)${result.dryRun ? ' [dry-run]' : ''}`);
    for (const d of result.details) {
      console.log(`   L${d.line}: ${d.old}`);
      console.log(`       → ${d.new}`);
    }
  }
}

console.log(`\n=== Git Add Fix Migration${DRY_RUN ? ' [DRY RUN]' : ''} ===`);
console.log(`Files modified: ${modifiedCount}`);
console.log(`Total changes: ${totalChanges}`);
