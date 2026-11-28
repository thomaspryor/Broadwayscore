'use strict';

/**
 * BRO-3954: systemic half of the fix. scripts/audit-review-type-wrong-show.js
 * was ONE of ~30 top-level scripts/*.js files that support --apply and write
 * review-text JSON via safeWriteReview() — the exact shape that produced the
 * BRO-3862 incident (a write landed on local disk, the session claimed it
 * verified+pushed, and the data repo never received it). Wiring the new
 * verify-review-texts-pushed.js helper into that one script closes the
 * incident; this scan exists so the other ~30 don't stay an invisible,
 * one-off-fixed backlog — scripts/audit-apply-scripts-verify-pushed.js runs
 * it over the whole scripts/ directory and reports which scripts still lack
 * the safety net, so a NEW script can't quietly reintroduce the same gap.
 *
 * Pure text-scan, no AST — same tradeoff audit-push-retry-budgets.js accepts
 * for its YAML scan (no parser dependency, heuristic, advisory-only): the
 * three substring checks below don't understand control flow, so a script
 * that requires the helper but never actually CALLS it would false-negative
 * (report clean when it isn't). That's an acceptable heuristic for a report/
 * advisory signal, per this repo's existing precedent, not a hard gate.
 *
 * @param {{path: string, content: string}[]} files
 * @returns {{scanned: number, flagged: {path: string}[]}}
 */
function scanApplyScriptsForVerifyGap(files) {
  const flagged = [];
  for (const { path: filePath, content } of files) {
    const hasApplyFlag = /['"]--apply['"]/.test(content);
    const hasSafeWriteReview = /safeWriteReview/.test(content);
    const hasVerifyHelper = /verify-review-texts-pushed/.test(content);
    if (hasApplyFlag && hasSafeWriteReview && !hasVerifyHelper) {
      flagged.push({ path: filePath });
    }
  }
  return { scanned: files.length, flagged };
}

module.exports = { scanApplyScriptsForVerifyGap };
