/**
 * Set-difference helpers for validate-data.js output — distinguish "this run
 * introduced a NEW error" from "a pre-existing, unrelated error is still
 * present." Both update-show-status.yml's discovery commit gate and
 * enrich-ibdb-dates.js's date-enrichment commit gate use this so neither
 * discards good writes over an error they didn't cause. Task #649.
 */

const ERROR_LINE_RE = /^❌ ERROR:\s*(.+)$/;

// Extracts and normalizes the `❌ ERROR: <msg>` lines validate-data.js prints
// (see scripts/validate-data.js's `error()` helper). Order-independent —
// callers only care about set membership, not sequence or duplicate count.
function parseErrorLines(text) {
  if (!text) return [];
  const out = [];
  for (const rawLine of text.split('\n')) {
    const m = rawLine.trim().match(ERROR_LINE_RE);
    if (m) out.push(m[1].trim());
  }
  return out;
}

// Errors present in postErrors but not in preErrors — genuinely introduced by
// whatever ran between the two validate-data.js invocations.
function computeNewErrors(preErrors, postErrors) {
  const preSet = new Set(preErrors);
  return postErrors.filter((e) => !preSet.has(e));
}

// True when postErrors adds nothing over preErrors — safe to commit even when
// postErrors itself is non-empty (pre-existing, unrelated breakage).
function shouldCommitDespiteValidationErrors(preErrors, postErrors) {
  return computeNewErrors(preErrors, postErrors).length === 0;
}

// Full commit decision, with a safety net around parseErrorLines: a crash or
// output-format change in validate-data.js can exit non-zero while printing
// nothing that matches `❌ ERROR:` (e.g. its uncaughtException handler dumps
// a raw Error object, not the normal error() line format). Pure text-diffing
// alone would read that as "0 new errors" and wrongly commit. postExitCode is
// optional for callers that don't have it (falls back to pure set-diff, same
// as shouldCommitDespiteValidationErrors) — pass it whenever available.
function evaluateCommitDecision({ preErrors, postErrors, postExitCode }) {
  const newErrors = computeNewErrors(preErrors, postErrors);
  if (postExitCode !== undefined && postExitCode !== 0 && postErrors.length === 0) {
    return {
      shouldCommit: false,
      newErrors,
      reason: `validate-data.js exited ${postExitCode} but produced no parseable "❌ ERROR:" lines — likely a crash or output-format change, not a clean pass.`,
    };
  }
  if (newErrors.length > 0) {
    return {
      shouldCommit: false,
      newErrors,
      reason: `${newErrors.length} new validation error(s) introduced.`,
    };
  }
  return {
    shouldCommit: true,
    newErrors,
    reason: postErrors.length > 0 ? `${postErrors.length} pre-existing error(s) ignored.` : 'clean.',
  };
}

module.exports = {
  parseErrorLines,
  computeNewErrors,
  shouldCommitDespiteValidationErrors,
  evaluateCommitDecision,
};
