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

const QUOTED_TOKEN_RE = /"([^"]+)"/g;

function extractQuotedTokens(text) {
  const out = [];
  let m;
  QUOTED_TOKEN_RE.lastIndex = 0;
  while ((m = QUOTED_TOKEN_RE.exec(text)) !== null) out.push(m[1]);
  return out;
}

// Attribute each new validation error to one of the show IDs a batch write
// touched (validate-data.js quotes the show ID in nearly every per-show
// error, e.g. `awards.json: "galileo-2026" tony.season=...`). Returns which
// candidate IDs are implicated, and whether EVERY new error could be pinned
// to a candidate.
//
// allAttributed=false means at least one new error names something outside
// this batch's candidateIds (or names nothing at all) — its cause is
// untraceable from here, so the caller should fall back to blocking the
// whole batch rather than guess it's unrelated.
function attributeNewErrorsToShowIds(newErrors, candidateIds) {
  const candidateSet = new Set(candidateIds);
  const blockedIds = new Set();
  let allAttributed = true;
  for (const err of newErrors) {
    const tokens = extractQuotedTokens(err);
    const hit = tokens.find((t) => candidateSet.has(t));
    if (hit) {
      blockedIds.add(hit);
    } else {
      allAttributed = false;
    }
  }
  return { blockedIds, allAttributed };
}

// Per-show commit decision: card #1426 found that enrich-ibdb-dates.js's
// weekly run collected valid openingDate values for 11 shows, but 3 of them
// (galileo-2026, inter-alia-2026, paranormal-activity-2026) had a stale
// awards.json tony.season placeholder that the NOW-real openingDate made
// inconsistent — a genuinely new validation error. evaluateCommitDecision's
// all-or-nothing gate then discarded ALL 11 shows' writes, including 8 with
// zero problems of their own, and the sentinel it left behind blocked that
// week's push entirely.
//
// This partitions instead: candidateIds are the show IDs a batch touched.
// Shows whose ID isn't named by any new error commit; shows named by a new
// error are held back for a human/future run. If any new error can't be
// attributed to a candidate at all, this falls back to the original
// shouldCommit=false-for-everything behavior — an error with an untraceable
// cause is not safe to write past.
function evaluatePerShowCommitDecision({ preErrors, postErrors, postExitCode, candidateIds }) {
  const base = evaluateCommitDecision({ preErrors, postErrors, postExitCode });
  if (base.shouldCommit) {
    return { ...base, blockedIds: new Set() };
  }
  // The postExitCode crash-safety branch (no parseable error lines at all)
  // has nothing to attribute — always blocks everything, same as before.
  if (base.newErrors.length === 0) {
    return { ...base, blockedIds: new Set() };
  }
  const { blockedIds, allAttributed } = attributeNewErrorsToShowIds(base.newErrors, candidateIds);
  if (!allAttributed) {
    return { ...base, blockedIds: new Set() };
  }
  const committableCount = candidateIds.length - blockedIds.size;
  return {
    shouldCommit: committableCount > 0,
    newErrors: base.newErrors,
    blockedIds,
    reason: `${blockedIds.size} of ${candidateIds.length} show(s) held back (new validation error attributed to them); ${committableCount} committed.`,
  };
}

module.exports = {
  parseErrorLines,
  computeNewErrors,
  shouldCommitDespiteValidationErrors,
  evaluateCommitDecision,
  attributeNewErrorsToShowIds,
  evaluatePerShowCommitDecision,
};
