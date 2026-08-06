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
 * isUsableReviewOutput() is the one gate that must sit between "the reviewer
 * process exited" and "the reviewer's coverage line says it ran": empty,
 * whitespace-only, or marker-only text (the CLI chrome with the actual reply
 * missing) must be reported as a coverage FAILURE, never folded into a quiet
 * single-model degrade.
 */

'use strict';

// Lines that are pure CLI/session chrome with no reviewer content of their
// own. If everything surviving the awk filter is one of these, the filter
// caught only scaffolding — not an empty-but-valid "no findings" reply
// (a real "no findings" reply is prose, not a bare marker line).
const MARKER_ONLY_LINES = new Set([
  'codex',
  'tokens used',
]);

const HOOK_LOG_RE = /^hook: /;

/**
 * @param {unknown} text - raw (post-awk-filter) reviewer output
 * @returns {boolean} true when `text` contains real reviewer content
 */
function isUsableReviewOutput(text) {
  if (typeof text !== 'string') return false;
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  const meaningfulLines = trimmed
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !HOOK_LOG_RE.test(line))
    .filter((line) => !MARKER_ONLY_LINES.has(line));

  return meaningfulLines.length > 0;
}

module.exports = { isUsableReviewOutput };
