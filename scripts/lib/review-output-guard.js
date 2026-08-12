/**
 * Review Output Guard
 *
 * /ship-check's adversarial reviewer (Codex, or its gpt-5.4-mini/Claude
 * fallbacks) pipes its raw CLI output through an awk marker filter to strip
 * the CLI chrome (banner, hook logs, token-usage footer). When the underlying
 * CLI exits 0 but produces no assistant text — observed with `codex exec`
 * (task #1081, Notion 3b4637c5) — the awk filter has nothing to extract and
 * silently returns an empty string. `command -v codex` was READY and the
 * process exit code was 0, so nothing upstream signals failure; the empty
 * result looks identical to "the reviewer ran and found nothing to say."
 *
 * checkReviewOutput() (and its boolean wrapper isUsableReviewOutput()) is the
 * one gate that must sit between "the reviewer process exited" and "the
 * reviewer's coverage line says it ran": empty, whitespace-only, marker-only
 * text (the CLI chrome with the actual reply missing), or a reviewer
 * REFUSAL — observed live 2026-08-12 (task #1320): Codex was asked to review
 * and instead returned "Blocked by required data preflight ... Per repo
 * instructions, I must stop rather than review without data." That refusal
 * is long, well-formed prose, so it passed every prior length/shape check
 * and printed CODEX_USABLE — indistinguishable from a genuine clean review.
 * All of these must be reported as a coverage FAILURE, never folded into a
 * quiet single-model degrade.
 */

'use strict';

// Lines that are pure CLI/session chrome with no reviewer content of their
// own. ship-check.md's awk filter (`/^codex$/{flag=1;next} /^tokens used$/
// {flag=0} flag`) already excludes these two exact lines from what reaches
// this function on the Codex path — this set is defense-in-depth for callers
// that don't go through that exact filter (e.g. a future fallback path with
// different chrome, or a change to the awk pattern), not a case the current
// pipeline can trigger. Kept because a marker line slipping through a changed
// filter is exactly the silent-degrade shape task #1081 exists to catch.
const MARKER_ONLY_LINES = new Set([
  'codex',
  'tokens used',
]);

const HOOK_LOG_RE = /^hook: /;

// First-person refusal phrasing an external reviewer emits when it declines
// to review instead of reviewing — same problem shape as
// synopsis-validation.js's REFUSAL_PATTERNS (an LLM refuses generation
// instead of generating), mirrored here for review declines. Anchored
// phrases, not a loose keyword scan, so ordinary review prose ("this design
// blocks the happy path") doesn't trip the gate. Drawn from the observed
// refusal (task #1320) plus adjacent phrasings reviewers are likely to use,
// since wording will drift over time.
const REFUSAL_PATTERNS = [
  /\bmust stop\b/i,
  /\bblocked by\b/i,
  /\bcannot review\b/i,
  /\bcan't review\b/i,
  /\brather than review\b/i,
  /\bper repo instructions\b/i,
  /\bdeclin(?:e|ed|ing) to review\b/i,
  /\bwithout reviewing\b/i,
  /\bunable to review\b/i,
  /\bI'm unable to\b/i,
  /\bI am unable to\b/i,
  /\bwon'?t review\b/i,
  /\bskipping (?:the )?review\b/i,
  /\bnot able to review\b/i,
  /\bmust decline\b/i,
  /\brefus(?:e|ed|ing) to review\b/i,
];

// A path:line citation ("src/lib/scoring.ts:42") is the positive signal a
// real finding almost always carries — both ship-check.md's and
// plan-review.md's adversarial prompts instruct "reference specific files
// (path:line) for every finding." A refusal never has one. Used as a
// tiebreaker, not the primary gate: a pure "require path:line" rule would
// misclassify a real zero-findings review like "No issues found." (no
// citation, not a refusal) as unusable.
const PATH_LINE_RE = /[\w./-]+\.\w{1,10}:\d+/;

// How far into the (chrome-stripped) text to look for refusal phrasing.
// Refusals front-load the decline; a genuine review that discusses being
// "blocked by CI" deep in its findings shouldn't be misread as a refusal.
const REFUSAL_WINDOW_CHARS = 500;

/**
 * @param {unknown} text - raw (post-awk-filter) reviewer output
 * @returns {{usable: boolean, kind: 'ok'|'non-string'|'empty'|'marker'|'refused', reason: string}}
 */
function checkReviewOutput(text) {
  if (typeof text !== 'string') {
    return { usable: false, kind: 'non-string', reason: 'non-string input' };
  }
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { usable: false, kind: 'empty', reason: 'empty output' };
  }

  const meaningfulLines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !HOOK_LOG_RE.test(line))
    .filter((line) => !MARKER_ONLY_LINES.has(line));

  if (meaningfulLines.length === 0) {
    return { usable: false, kind: 'marker', reason: 'marker-only or whitespace-only output' };
  }

  const meaningfulText = meaningfulLines.join('\n');
  const refusalWindow = meaningfulText.slice(0, REFUSAL_WINDOW_CHARS);
  const looksLikeRefusal = REFUSAL_PATTERNS.some((pattern) => pattern.test(refusalWindow));
  const hasPathLineCitation = PATH_LINE_RE.test(meaningfulText);

  if (looksLikeRefusal && !hasPathLineCitation) {
    return {
      usable: false,
      kind: 'refused',
      reason: `refused: ${meaningfulLines[0].slice(0, 200)}`,
    };
  }

  return { usable: true, kind: 'ok', reason: 'ok' };
}

/**
 * @param {unknown} text - raw (post-awk-filter) reviewer output
 * @returns {boolean} true when `text` contains real reviewer content
 */
function isUsableReviewOutput(text) {
  return checkReviewOutput(text).usable;
}

module.exports = { isUsableReviewOutput, checkReviewOutput };
