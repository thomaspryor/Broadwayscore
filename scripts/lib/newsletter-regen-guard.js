/**
 * newsletter-regen-guard.js — structural guard: every spawn of the newsletter
 * generator must pin NEWSLETTER_EDITION.
 *
 * WHY THIS EXISTS (2026-08-09)
 * scripts/newsletter/generate.mjs writes the draft IN PLACE and defaults to the
 * Broadway edition when NEWSLETTER_EDITION is unset. So any child-process spawn
 * of it that inherits an incomplete env silently rewrites a West End draft as the
 * Broadway edition. That is exactly what happened on 2026-08-08 and 2026-07-25:
 * newsletter-draft.yml's "Pre-send check" step omitted NEWSLETTER_EDITION, the
 * coverage-swap regeneration inside pre-send-check.mjs inherited the gap, the WE
 * draft came back as Broadway, send-test.mjs's edition guard failed the run, and
 * the West End broadcast draft never reached Resend at all. The owner got no West
 * End newsletter for two of three weeks and nothing said why.
 *
 * The per-call fix is to SET the edition on the spawn env rather than hope the
 * caller exported it. This guard is what stops the NEXT spawn from forgetting:
 * a workflow-env lint could not do it (the defect can live in a shell script or a
 * launchd job just as easily as in YAML), so the invariant is enforced where it
 * can actually be violated — at the call site, in source.
 *
 * Deliberately a text scanner, not an AST parse: it has to run over .mjs and .js
 * alike with no parser dependency, and the shapes it must catch are narrow.
 * Matches the established scripts/lib/*-guard.js convention (see
 * unbounded-fetch-guard.js, shallow-fetch-args.js).
 */

'use strict';

// The generator filename as it appears in an argv element. Call sites build the
// path with path.join(__dirname, 'generate.mjs'), so match the argv STRING
// LITERAL, never a bare substring of the whole file — 'generate.mjs' also occurs
// inside error-message text (create-broadcast-draft.mjs) and comments, and
// flagging those would train people to ignore this guard.
const GENERATOR_BASENAME = 'generate.mjs';

const SPAWN_FNS = ['execFileSync', 'execFile', 'spawnSync', 'spawn', 'execSync', 'exec'];

/**
 * Find the index of the character closing the bracket opened at `openIdx`.
 * Skips over string literals and template literals so a bracket inside a string
 * doesn't end the scan early. Returns -1 if unbalanced.
 */
function matchBracket(src, openIdx) {
  const open = src[openIdx];
  const close = { '(': ')', '[': ']', '{': '}' }[open];
  if (!close) return -1;
  let depth = 0;
  let quote = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    const prev = src[i - 1];
    if (quote) {
      if (ch === quote && prev !== '\\') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Is NEWSLETTER_EDITION pinned for this spawn?
 *
 * Two shapes count, because both are legitimate and both appear in this repo:
 *   1. inline    — env: { ...process.env, NEWSLETTER_EDITION: x }
 *   2. by name   — env: regenEnv, where regenEnv is built above the call
 * For (2) the identifier is resolved against the whole file: its object-literal
 * initializer, or any later `ident.NEWSLETTER_EDITION = ...` assignment, both
 * count. Resolving by name is what keeps the guard from forcing call sites to
 * inline an env object they build in a loop.
 */
function editionIsPinned(sourceText, callText) {
  if (/\bNEWSLETTER_EDITION\b/.test(callText)) return true;

  const byName = /\benv\s*:\s*([A-Za-z_$][\w$]*)\s*[,}]/.exec(callText);
  if (!byName) return false;
  const ident = byName[1];
  if (ident === 'process') return false; // `env: process.env` pins nothing

  // Direct property assignment anywhere in the file.
  const assignRe = new RegExp(`\\b${ident}\\s*(\\.NEWSLETTER_EDITION\\b|\\[\\s*['"\`]NEWSLETTER_EDITION['"\`]\\s*\\])`);
  if (assignRe.test(sourceText)) return true;

  // Object-literal initializer: const ident = { ... }
  const initRe = new RegExp(`\\b${ident}\\s*=\\s*\\{`, 'g');
  let init;
  while ((init = initRe.exec(sourceText)) !== null) {
    const braceIdx = sourceText.indexOf('{', init.index);
    const end = matchBracket(sourceText, braceIdx);
    if (end === -1) continue;
    if (/\bNEWSLETTER_EDITION\b/.test(sourceText.slice(braceIdx, end + 1))) return true;
  }
  return false;
}

/**
 * Scan one source file for spawns of generate.mjs that don't pin the edition.
 *
 * @param {string} sourceText  file contents
 * @param {string} filename    for the reported message only
 * @returns {Array<{line: number, fn: string, reason: string}>} one entry per violation
 */
function findUnpinnedGenerateSpawns(sourceText, filename = '<source>') {
  const violations = [];
  if (typeof sourceText !== 'string' || !sourceText) return violations;

  for (const fn of SPAWN_FNS) {
    // Word-boundary so `execFile` doesn't also match inside `execFileSync`.
    const callRe = new RegExp(`\\b${fn}\\s*\\(`, 'g');
    let m;
    while ((m = callRe.exec(sourceText)) !== null) {
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = matchBracket(sourceText, openIdx);
      if (closeIdx === -1) continue;
      const callText = sourceText.slice(openIdx, closeIdx + 1);

      // Only care about calls that actually run the generator. Require the
      // basename as its own quoted argv token or the tail of a quoted path.
      const runsGenerator = new RegExp(
        `['"\`][^'"\`]*(^|[/'"\`])${GENERATOR_BASENAME.replace('.', '\\.')}['"\`]`,
        'm'
      ).test(callText);
      if (!runsGenerator) continue;

      if (!editionIsPinned(sourceText, callText)) {
        violations.push({
          line: sourceText.slice(0, m.index).split('\n').length,
          fn,
          reason: `${filename}: ${fn}() spawns ${GENERATOR_BASENAME} without setting NEWSLETTER_EDITION in its env. generate.mjs defaults to the Broadway edition and overwrites the draft in place, so this silently rewrites a West End draft as Broadway. Pin it: env: { ...process.env, NEWSLETTER_EDITION: <the edition this draft already is> }.`,
        });
      }
    }
  }
  return violations;
}

module.exports = { findUnpinnedGenerateSpawns, GENERATOR_BASENAME, SPAWN_FNS };
