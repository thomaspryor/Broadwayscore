#!/usr/bin/env node
/**
 * Rollback for migrate-reroute-backlog.js.
 * Reads the migration log and moves every file back to its original directory,
 * restoring the full "before" snapshot (including wrongProduction flag).
 *
 * Usage: node scripts/rollback-reroute-backlog.js
 */
const fs = require('fs');
const path = require('path');

const REPO_ROOT = '/Users/tompryor/Broadwayscore';
const LOG_PATH = path.join(REPO_ROOT, 'data', 'reroute-migration-log.json');

if (!fs.existsSync(LOG_PATH)) {
  console.error('No migration log found at', LOG_PATH);
  process.exit(1);
}

const log = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'));
console.log(`Rolling back ${log.length} moves...\n`);

let rolled = 0, skipped = 0, failed = 0;

// Process in reverse order
for (let i = log.length - 1; i >= 0; i--) {
  const entry = log[i];
  const { sourcePath, targetPath, before, sourceShowId, file } = entry;

  // Target should still exist
  if (!fs.existsSync(targetPath)) {
    console.log(`  SKIP ${sourceShowId}/${file}: target already gone`);
    skipped++;
    continue;
  }
  // Source should NOT exist (we're restoring it)
  if (fs.existsSync(sourcePath)) {
    console.log(`  SKIP ${sourceShowId}/${file}: source already exists (manual restore?)`);
    skipped++;
    continue;
  }

  try {
    // Restore the full "before" snapshot at the source path
    const sourceDir = path.dirname(sourcePath);
    if (!fs.existsSync(sourceDir)) fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(sourcePath, JSON.stringify(before, null, 2) + '\n');
    fs.unlinkSync(targetPath);
    rolled++;
  } catch (e) {
    console.error(`  FAIL ${sourceShowId}/${file}: ${e.message}`);
    failed++;
  }
}

console.log(`\nRollback complete: ${rolled} restored, ${skipped} skipped, ${failed} failed.`);
process.exit(failed > 0 ? 1 : 0);
