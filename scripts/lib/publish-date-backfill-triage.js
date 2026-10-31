'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

// Omitted scope preserves the standalone CLI's whole-corpus mode.
// An explicitly empty scope must never expand to the whole corpus.
function scopeCrossProductionIssues(issues, touchedFiles) {
  if (touchedFiles == null) return issues;
  const scope = new Set(touchedFiles);
  return issues.filter(issue => scope.has(issue.file));
}

/** Refresh date-dependent evidence, apply scoped flags, then fail closed on
 * contamination. Call after date writes and before reporting batch completion.
 * The audit remains corpus-wide so same-URL siblings in other shows are visible.
 */
function runPublishDateBackfillTriage({
  touchedFiles, dryRun = false,
  repoRoot = path.resolve(__dirname, '..', '..'),
  run = spawnSync,
}) {
  const files = [...new Set(touchedFiles)].sort();
  if (dryRun || files.length === 0) return;

  const auditDir = path.join(repoRoot, 'data', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  // A manifest avoids OS argument limits for thousand-review batches.
  const tempDir = fs.mkdtempSync(path.join(auditDir, '.publish-date-triage-'));
  try {
    const manifest = path.join(tempDir, 'files.json');
    fs.writeFileSync(manifest, JSON.stringify(files));
    const steps = [
      ['audit-cross-production.js'],
      ['auto-triage-cross-production.js', '--apply', `--files-from=${manifest}`],
      ['audit-review-contamination.js', '--gate'],
    ];
    for (const [script, ...args] of steps) {
      const result = run(process.execPath, [path.join(repoRoot, 'scripts', script), ...args], {
        cwd: repoRoot, stdio: 'inherit',
      });
      if (result.error || result.status !== 0) {
        const reason = result.error?.message || result.signal || `exit ${result.status}`;
        throw new Error(`publishDate backfill safety check failed: ${script} (${reason})`);
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = { runPublishDateBackfillTriage, scopeCrossProductionIssues };
