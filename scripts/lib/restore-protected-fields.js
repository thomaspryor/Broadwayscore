#!/usr/bin/env node
/**
 * Restore manually-set protected fields after a git rebase/merge.
 *
 * When push-with-retry.sh rebases with -X theirs, conflicts are resolved
 * by keeping the CI's version. This silently drops manual corrections
 * (humanReviewScore, manualContentTier, etc.) that were pushed to origin.
 *
 * This script compares each JSON file between the remote ref and HEAD.
 * If the remote version had manual correction fields that are now missing,
 * it restores them into the local file.
 *
 * Usage: node scripts/lib/restore-protected-fields.js <remote-ref>
 *
 * Exit codes:
 *   0 = no changes needed (or changes applied successfully)
 *   Prints count of restored files to stdout (for caller to check).
 */

const fs = require('fs');
const { execSync } = require('child_process');

// Fields that are ONLY set by manual human corrections, never by CI pipelines.
// If the remote has these and local doesn't, it's ALWAYS correct to restore them.
// humanReviewedWrongProduction: false is the linchpin guard for opening night —
// CI rebases dropped it during DoaS Apr 9-10, causing CV-promotion to re-flag
// human-verified files as wrongProduction. See memory/project_doas_opening_night_issues.md.
const MANUAL_FIELDS = [
  'humanReviewScore',
  'manualContentTier',
  'wrongProductionManualClear',
  'wrongProductionOverride',
  'humanReviewedWrongProduction',
  'allowEarlyDate',
];

// Nested fields under contentVerification that are manually set
const MANUAL_CV_FIELDS = [
  'wrongProduction',
  'wrongArticle',
];

const remoteRef = process.argv[2];
if (!remoteRef) {
  console.log('0');
  process.exit(0);
}

try {
  // Get JSON files that differ between remote and HEAD
  const diffOutput = execSync(
    `git diff --name-only ${remoteRef}..HEAD -- '*.json'`,
    { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
  ).trim();

  if (!diffOutput) {
    console.log('0');
    process.exit(0);
  }

  const files = diffOutput.split('\n').filter(f =>
    f.endsWith('.json') &&
    !f.includes('package') &&
    !f.includes('tsconfig') &&
    !f.includes('node_modules') &&
    !f.includes('failed-fetches')
  );

  let restoredCount = 0;

  for (const f of files) {
    try {
      // Read local version
      if (!fs.existsSync(f)) continue;
      const local = JSON.parse(fs.readFileSync(f, 'utf8'));

      // Read remote version
      let remoteContent;
      try {
        remoteContent = execSync(`git show ${remoteRef}:${f}`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch {
        continue; // File doesn't exist in remote — new file, skip
      }

      const remote = JSON.parse(remoteContent);
      let modified = false;

      // Restore top-level manual fields
      for (const field of MANUAL_FIELDS) {
        if (
          remote[field] !== undefined &&
          remote[field] !== null &&
          (local[field] === undefined || local[field] === null)
        ) {
          local[field] = remote[field];
          modified = true;
          process.stderr.write(`  Restored ${field} in ${f}\n`);
        }
      }

      // Restore nested contentVerification manual fields
      if (remote.contentVerification) {
        for (const key of MANUAL_CV_FIELDS) {
          const remoteVal = remote.contentVerification[key];
          if (remoteVal === undefined || remoteVal === null) continue;

          if (!local.contentVerification) local.contentVerification = {};
          const localVal = local.contentVerification[key];

          if (localVal === undefined || localVal === null) {
            local.contentVerification[key] = remoteVal;
            modified = true;
            process.stderr.write(`  Restored contentVerification.${key} in ${f}\n`);
          }
        }
      }

      if (modified) {
        fs.writeFileSync(f, JSON.stringify(local, null, 2) + '\n');
        restoredCount++;
      }
    } catch {
      // Parse error or other issue — skip this file
    }
  }

  console.log(String(restoredCount));
} catch (e) {
  // If git diff fails (e.g., remote ref doesn't exist), just exit cleanly
  console.log('0');
}
