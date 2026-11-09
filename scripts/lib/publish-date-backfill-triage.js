'use strict';

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { STRICT_CLASSES, countsTowardStrict } = require('./contamination-gate');

// Omitted scope preserves the standalone CLI's whole-corpus mode.
// An explicitly empty scope must never expand to the whole corpus.
function scopeCrossProductionIssues(issues, touchedFiles) {
  if (touchedFiles == null) return issues;
  const scope = new Set(touchedFiles);
  return issues.filter(issue => scope.has(issue.file));
}

/**
 * BRO-6707: the touched files ("<showId>/<file>") the contamination gate blocks
 * on. A strict-counting hit (class A cross-market among them) names showId +
 * file (C2-style hits name file1/file2). Only files this batch wrote count, so
 * a pre-existing leak elsewhere in the corpus is never "fixed" by a revert here.
 * @param {{hits?: Record<string, object[]>}} audit parsed `audit-review-contamination.js --json`
 * @param {Iterable<string>} touchedFiles
 * @returns {string[]} sorted, de-duplicated
 */
function findGateBlockers(audit, touchedFiles) {
  const scope = new Set(touchedFiles || []);
  const out = new Set();
  const hardOut = new Set(); // class A / A2: what the gate itself trips on
  const hits = (audit && audit.hits) || {};
  for (const [key, arr] of Object.entries(hits)) {
    const cls = key.split('_')[0];
    if (!STRICT_CLASSES.has(cls) || !Array.isArray(arr)) continue;
    for (const h of arr) {
      if (!h || !h.showId || !countsTowardStrict(cls, h)) continue;
      for (const f of [h.file, h.file1, h.file2]) {
        if (!f || !scope.has(`${h.showId}/${f}`)) continue;
        out.add(`${h.showId}/${f}`);
        if (cls === 'A' || cls === 'A2') hardOut.add(`${h.showId}/${f}`);
      }
    }
  }
  // A batch with a class A leak reverts only those files: a single C/E/F hit on
  // another touched file comes from the domain or an empty body, not the date.
  return [...(hardOut.size ? hardOut : out)].sort();
}

/**
 * BRO-6707: the record written back when the contamination gate rejects a date
 * this batch wrote: the pre-write record, the page date kept as a candidate for
 * a person to judge (same shape as the 'page-date-diverges' path), and the
 * sweep's attempt marker so the next run moves on to other files.
 * @param {object} original record as it was before the batch wrote it
 * @param {string} pageDate the date the batch found
 * @param {string} pageDateSource where it came from (html-cookies, ...)
 * @param {{recheck?: boolean, now?: string}} [opts] recheck: true for --recheck-dates
 * @returns {object}
 */
function buildGateRevertedRecord(original, pageDate, pageDateSource, { recheck = true, now = new Date().toISOString() } = {}) {
  const out = { ...original, pageDateCandidate: pageDate, pageDateCandidateSource: pageDateSource };
  if (recheck) {
    out.needsDateRecheck = true;
    out.dateRecheckAttempted = now;
    out.dateRecheckAttemptReason = 'contamination-gate-blocked';
  } else {
    out.dateBackfillAttempted = now;
    out.dateBackfillAttemptReason = 'contamination-gate-blocked';
  }
  return out;
}

/** Refresh date-dependent evidence, apply scoped flags, then fail closed on
 * contamination. Call after date writes and before reporting batch completion.
 * The audit remains corpus-wide so same-URL siblings in other shows are visible.
 *
 * BRO-6707: with `revertBlockers`, a gate failure caused by files THIS batch
 * dated reverts just those files (the caller restores their old record and
 * marks them attempted) and re-runs the gate once. Without it, one newly
 * revealed cross-market review aborted every daily run from 2026-11-03 on: the
 * same 40 files were refetched each day and none of the batch's confirmed dates
 * or attempt markers was ever committed. The gate still fails closed when the
 * leak is not this batch's, when the audit cannot be read, or on a crash.
 * @returns {{reverted: string[]}}
 */
function runPublishDateBackfillTriage({
  touchedFiles, dryRun = false,
  repoRoot = path.resolve(__dirname, '..', '..'),
  run = spawnSync,
  revertBlockers = null,
}) {
  const files = [...new Set(touchedFiles)].sort();
  if (dryRun || files.length === 0) return { reverted: [] };

  const auditDir = path.join(repoRoot, 'data', 'audit');
  fs.mkdirSync(auditDir, { recursive: true });
  // A manifest avoids OS argument limits for thousand-review batches.
  const tempDir = fs.mkdtempSync(path.join(auditDir, '.publish-date-triage-'));
  const scriptPath = (name) => path.join(repoRoot, 'scripts', name);
  const failure = (name, result) => {
    const reason = result.error?.message || result.signal || `exit ${result.status}`;
    return new Error(`publishDate backfill safety check failed: ${name} (${reason})`);
  };
  try {
    const manifest = path.join(tempDir, 'files.json');
    fs.writeFileSync(manifest, JSON.stringify(files));
    const steps = [
      ['audit-cross-production.js'],
      ['auto-triage-cross-production.js', '--apply', `--files-from=${manifest}`],
    ];
    for (const [name, ...args] of steps) {
      const result = run(process.execPath, [scriptPath(name), ...args], { cwd: repoRoot, stdio: 'inherit' });
      if (result.error || result.status !== 0) throw failure(name, result);
    }
    const gate = 'audit-review-contamination.js';
    const runGate = () => run(process.execPath, [scriptPath(gate), '--gate'], { cwd: repoRoot, stdio: 'inherit' });
    let result = runGate();
    if (!result.error && result.status === 0) return { reverted: [] };
    // Only a clean "gate says no" (exit 1) is attributable; a crash or signal fails closed.
    if (typeof revertBlockers !== 'function' || result.error || result.status !== 1) throw failure(gate, result);
    const json = run(process.execPath, [scriptPath(gate), '--json'], {
      cwd: repoRoot, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', maxBuffer: 512 * 1024 * 1024,
    });
    let audit = null;
    try { audit = JSON.parse(json.stdout); } catch { /* unreadable: fail closed below */ }
    const blockers = audit ? findGateBlockers(audit, files) : [];
    if (blockers.length === 0) throw failure(gate, result);
    console.log(`[publish-date-triage] contamination gate blocked on ${blockers.length} file(s) this batch dated; reverting them: ${blockers.join(', ')}`);
    revertBlockers(blockers);
    result = runGate();
    if (result.error || result.status !== 0) throw failure(gate, result);
    return { reverted: blockers };
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

module.exports = { runPublishDateBackfillTriage, scopeCrossProductionIssues, findGateBlockers, buildGateRevertedRecord };
