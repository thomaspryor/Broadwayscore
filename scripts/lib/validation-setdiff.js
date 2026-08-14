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
const PAREN_GROUP_RE = /\(([^()]+)\)/g;

function extractQuotedTokens(text) {
  const out = [];
  let m;
  QUOTED_TOKEN_RE.lastIndex = 0;
  while ((m = QUOTED_TOKEN_RE.exec(text)) !== null) out.push(m[1]);
  return out;
}

// Some error() call sites (mostly the awards.json/tony.season family, e.g.
// `awards.json: "galileo-2026" tony.season=...`) quote the show ID directly.
// Most of validate-data.js's per-show error() calls instead quote the show
// TITLE and put the id unquoted in parens right after, e.g.
// `Show "${show.title}" (${show.id}) missing required field: venue` or
// `... (${show.id}, status=${show.status}) has category=...`. Splitting each
// paren group on commas catches the id in both the single-value and
// multi-value-parenthetical shapes. Without this, attribution only works for
// the minority of error sites that quote the id itself, and every other
// per-show error in this file falls through to allAttributed=false — the
// discovery gate's own error surface (task #1439).
function extractCandidateTokens(text) {
  const out = extractQuotedTokens(text);
  let m;
  PAREN_GROUP_RE.lastIndex = 0;
  while ((m = PAREN_GROUP_RE.exec(text)) !== null) {
    for (const part of m[1].split(',')) out.push(part.trim());
  }
  return out;
}

// Attribute each new validation error to the show ID(s) a batch write
// touched. Returns which candidate IDs are implicated, and whether EVERY new
// error could be pinned to a candidate.
//
// Collects EVERY candidate token an error names, not just the first — some
// validate-data.js errors name two shows at once (e.g. duplicate-ID or
// duplicate-match pairs), and blocking only the first-mentioned show would
// let the second implicated show commit unblocked.
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
    const tokens = extractCandidateTokens(err);
    const hits = tokens.filter((t) => candidateSet.has(t));
    if (hits.length > 0) {
      hits.forEach((h) => blockedIds.add(h));
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
  extractCandidateTokens,
  attributeNewErrorsToShowIds,
  evaluatePerShowCommitDecision,
};
