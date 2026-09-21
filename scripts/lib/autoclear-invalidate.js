/**
 * Shared scan primitives for scripts/lint-autoclear-invalidate.js (BRO-3908).
 *
 * BRO-3895 fixed a live main-red CI failure: 3 wrongProduction=true writers in
 * scripts/lib/review-file-writer.js never called
 * invalidateWrongProductionAutoClear before re-flagging, so a file re-flagged
 * after an earlier auto-clear ended up with `wrongProduction:true` sitting
 * beside a stale `wrongProductionAutoCleared` breadcrumb — the exact
 * self-contradictory-clear shape audit-self-contradictory-clear-drained.test.mjs
 * gates on. A full grep sweep (BRO-3908) found the same gap at 25 more
 * `.wrongProduction = true` write sites and 8 `.wrongShow = true` write sites
 * across scripts/ — every one fixed alongside this lint landing.
 *
 * invalidateWrongProductionAutoClear / invalidateWrongShowAutoClear
 * (scripts/lib/review-write-guard.js) already existed and were documented
 * ("every writer should call this") but nothing enforced it — each new writer
 * either remembered the pattern or didn't. This module is that enforcement:
 * static-scan primitives scripts/lint-autoclear-invalidate.js uses to fail CI
 * when a writer sets either flag with no invalidate call nearby.
 *
 * Reuses scripts/lib/wrongproduction-provenance.js's comment/comparison/
 * string-literal helpers and its wrongProduction assignment finder rather
 * than re-deriving them, so both lints agree on what counts as a real write.
 * Colocated scripts/lib/autoclear-invalidate.test.mjs (CLAUDE.md rule 15 —
 * require()s these functions, does not restate them).
 */

'use strict';

const {
  findWrongProductionAssignments,
  isCommentLine,
  isComparisonLine,
  isInsideStringLiteral,
} = require('./wrongproduction-provenance');

// Mirrors ASSIGNMENT_RE / OBJECT_LITERAL_RE in wrongproduction-provenance.js,
// substituting wrongShow for wrongProduction.
const WRONG_SHOW_ASSIGNMENT_RE = /\.wrongShow\s*=\s*true\b/;
const WRONG_SHOW_OBJECT_LITERAL_RE = /\bwrongShow\s*:\s*true\b/;

/**
 * Which 1-indexed lines START already inside an unterminated template
 * literal opened on an earlier line? Backtick-counting only (doesn't
 * distinguish a literal backtick inside a regular '/" string from one that
 * opens/closes a template) — same best-effort simplification class as
 * isInsideStringLiteral's documented KNOWN GAP. Needed because a multi-line
 * `USAGE = \`...\`` help-text block can legitimately contain
 * "wrongShow:true" as PROSE across many lines (e.g. audit-review-type-
 * wrong-show.js's `--apply   write wrongShow:true ... to matched files.`),
 * and isInsideStringLiteral alone can't see across the line boundary where
 * the template literal opened (single-line parity tracking only, by
 * design).
 */
function computeTemplateLiteralOpenLines(content) {
  const lines = content.split('\n');
  const openAtStart = new Set();
  let inTemplate = false;
  for (let i = 0; i < lines.length; i++) {
    if (inTemplate) openAtStart.add(i + 1);
    const line = lines[i];
    // A `//` comment (e.g. "// like a `pseudo-code` snippet") can carry an
    // odd number of backticks without ever opening a real template literal —
    // counting through it would desync `inTemplate` for the rest of the
    // file, hiding every later real write behind a false "inside a
    // template" (Codex adversarial ship-check finding, BRO-3908). Skipping
    // whole `//`-comment lines here isn't perfect (a `/* */` block comment
    // with a stray backtick has the same problem, and a `//` comment on the
    // SAME line as real code after an opened template is not specially
    // handled) — same accepted-limitation class as isInsideStringLiteral's
    // documented KNOWN GAP above, not a claim of full tokenization.
    if (isCommentLine(line)) continue;
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === '\\') { j++; continue; }
      if (c === '`') inTemplate = !inTemplate;
    }
  }
  return openAtStart;
}

/**
 * Find every real `.wrongShow = true` write in source text — member
 * assignment or object-literal construction — skipping comment lines,
 * `===`/`!==` comparisons, matches inside string/template literals (e.g.
 * `note: 'Already wrongShow:true (excluded)'` prose, common in this
 * corpus's cross-outlet-attribution fixup scripts), and matches inside a
 * multi-line template literal opened on an earlier line (help-text USAGE
 * blocks).
 */
function findWrongShowAssignments(content) {
  const lines = content.split('\n');
  const templateOpenLines = computeTemplateLiteralOpenLines(content);
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isCommentLine(line) || isComparisonLine(line)) continue;
    if (templateOpenLines.has(i + 1)) continue;
    for (const re of [WRONG_SHOW_ASSIGNMENT_RE, WRONG_SHOW_OBJECT_LITERAL_RE]) {
      const m = re.exec(line);
      if (m && !isInsideStringLiteral(line, m.index)) {
        hits.push({ line: i + 1, text: line.trim() });
        break;
      }
    }
  }
  return hits;
}

// How far (in lines, either direction) from the write site to look for the
// matching invalidate call. Most fixes landed alongside this lint call
// invalidate on the very next line (mirroring
// scripts/lib/review-write-guard.js's stampWrongProductionFromGuard closure),
// but this codebase's convention is heavy WHY-comments — e.g.
// adjudicate-review-queue.js has a real invalidateWrongProductionAutoClear
// call 27 lines after its flag assignment, separated by an 11-line comment
// explaining why. 40 gives real same-function calls plenty of margin without
// spanning into an unrelated function (this file's shortest function is
// well over 40 lines).
const INVALIDATE_WINDOW_LINES = 40;

/**
 * Does a call to `fnName(...)` appear within `windowLines` of the given
 * 1-indexed line number? Comment lines inside the window are excluded so a
 * doc-comment mention (e.g. this file's own docstring) can't paper over a
 * real gap.
 *
 * KNOWN GAP (Codex adversarial ship-check finding, BRO-3908): a pure
 * line-window can't distinguish "this write site's OWN call" from "a
 * DIFFERENT write site's call that happens to sit nearby" — e.g. two
 * sequential, mutually-exclusive `if`/`else if` branches each ~15-30 lines
 * apart (classify-wrong-production.js:615/646) could, in principle, mask a
 * regression that deletes one branch's own call while the sibling's call
 * stays in range. A tighter, per-hit-bounded window was tried and reverted:
 * it broke the OTHER legitimate pattern this corpus uses just as often —
 * multiple mutually-exclusive branches sharing ONE invalidate call placed
 * after all of them (verify-existing-reviews.js:220-232, the same
 * "flag-during-branches, invalidate-once-after" shape as BRO-3895's own
 * fix) — which a bounded window incorrectly flagged as missing for the
 * earlier branch. Distinguishing "shared call after a branch group" from
 * "sibling call for an unrelated site" needs real control-flow parsing, not
 * text proximity; accepted as a scanner limitation, same class as
 * isInsideStringLiteral's documented KNOWN GAP in the sibling lint.
 */
function hasNearbyInvalidateCall(content, lineNumber, fnName, windowLines = INVALIDATE_WINDOW_LINES) {
  const lines = content.split('\n');
  const idx = lineNumber - 1;
  const start = Math.max(0, idx - windowLines);
  const end = Math.min(lines.length, idx + windowLines + 1);
  const window = lines.slice(start, end)
    .filter((l) => !isCommentLine(l))
    .join('\n');
  return window.includes(`${fnName}(`);
}

/**
 * Full violation scan for one file's source text: every wrongProduction/
 * wrongShow write with no matching invalidate call nearby.
 */
function scanFileForInvalidateViolations(content, relPath) {
  const violations = [];
  const templateOpenLines = computeTemplateLiteralOpenLines(content);
  for (const hit of findWrongProductionAssignments(content)) {
    if (templateOpenLines.has(hit.line)) continue;
    if (!hasNearbyInvalidateCall(content, hit.line, 'invalidateWrongProductionAutoClear')) {
      violations.push({ file: relPath, line: hit.line, text: hit.text, flag: 'wrongProduction', fn: 'invalidateWrongProductionAutoClear' });
    }
  }
  for (const hit of findWrongShowAssignments(content)) {
    if (!hasNearbyInvalidateCall(content, hit.line, 'invalidateWrongShowAutoClear')) {
      violations.push({ file: relPath, line: hit.line, text: hit.text, flag: 'wrongShow', fn: 'invalidateWrongShowAutoClear' });
    }
  }
  return violations;
}

module.exports = {
  WRONG_SHOW_ASSIGNMENT_RE,
  WRONG_SHOW_OBJECT_LITERAL_RE,
  computeTemplateLiteralOpenLines,
  findWrongShowAssignments,
  INVALIDATE_WINDOW_LINES,
  hasNearbyInvalidateCall,
  scanFileForInvalidateViolations,
};
