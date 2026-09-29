/**
 * notion-write-paths-audit.js — pure, no-I/O source-text checks for BRO-3430.
 *
 * Three code paths kept writing to the retired Notion board (CLAUDE.md §6:
 * Notion mirror froze 2026-08-20) after the Linear cutover:
 *   1. A script calling @notionhq/client's `.pages.create()` directly,
 *      bypassing notion-brain.js's exit-6 read-only guard entirely.
 *   2. A caller shelling out to a board CLI for card-filing whose non-zero
 *      exit was logged and swallowed, so a refused/failed create never
 *      failed the job.
 *   3. notion-brain.js's `update` command left ungated with no documented
 *      reason, next to `create`'s guard.
 *
 * These functions take source text (the caller reads real files) and return
 * findings/booleans — no fs, no process.exit — so
 * scripts/tests/notion-write-paths-retired.test.mjs can require() them
 * directly (CLAUDE.md rule 15) instead of restating the regexes.
 */

'use strict';

// (1) — a file "creates Notion pages directly" if it both pulls in the
// Notion SDK and calls `.pages.create(`. Comments are stripped first so a
// doc comment merely mentioning the pattern (this file's own header, or
// notion-brain.js's guard comments) never false-positives.
function createsNotionPagesDirectly(source) {
  const importsNotionSdk = /require\(\s*['"]@notionhq\/client['"]\s*\)/.test(source);
  if (!importsNotionSdk) return false;
  const stripped = source
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return /\.pages\.create\s*\(/.test(stripped);
}

// Returns the source between a `{` at `openIdx` and its matching `}`
// (brace-depth counted, so nested blocks inside don't truncate the capture —
// a naive non-greedy regex like `\{([\s\S]*?)\}` stops at the FIRST closing
// brace it sees, silently truncating any block containing a nested if/loop),
// plus the index immediately after the closing `}`. Ignores braces inside
// string/template literals well enough for this repo's plain control-flow
// shape (not a full parser — good enough for the two known call sites this
// guards, same tradeoff as audit-linear-issuecreate-chokepoint.js).
function matchBalancedBrace(source, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return { body: source.slice(openIdx + 1, i), endIdx: i + 1 };
    }
  }
  return null;
}

// (2) — does any `.status`-checked child-process result get swallowed, i.e.
// its failure branch only logs instead of throwing / exiting non-zero?
// Handles both shapes seen in this repo:
//   if (x.status === 0) { ...success... } else { ...failure... }
//   if (x.status !== 0) { ...failure... }
// A file can guard several spawnSync calls, so this scans every occurrence
// and returns true (a violation) if ANY of them swallows its failure.
// Returns null when no such `.status` guard is present at all.
function swallowsChildExit(source) {
  const ifRe = /if\s*\(\s*\w+\.status\s*(===|!==)\s*0\s*\)\s*\{/g;
  let m;
  let sawGuard = false;
  while ((m = ifRe.exec(source))) {
    const openIdx = m.index + m[0].length - 1;
    const ifMatch = matchBalancedBrace(source, openIdx);
    if (!ifMatch) continue; // unbalanced source — nothing sane to check
    sawGuard = true;
    const op = m[1];
    let elseBlock = '';
    const afterIf = source.slice(ifMatch.endIdx, ifMatch.endIdx + 200);
    const elseMatch = /^\s*else\s*\{/.exec(afterIf);
    if (elseMatch) {
      const elseOpenIdx = ifMatch.endIdx + elseMatch[0].length - 1;
      const elseBraceMatch = matchBalancedBrace(source, elseOpenIdx);
      if (elseBraceMatch) elseBlock = elseBraceMatch.body;
    }
    const failBlock = op === '===' ? elseBlock : ifMatch.body;
    const failHandled = /\bthrow\b/.test(failBlock) || /process\.exit\(\s*[1-9]/.test(failBlock);
    if (!failHandled) return true;
    // Advance past this if/else so the next search doesn't re-scan inside it.
    ifRe.lastIndex = Math.max(ifRe.lastIndex, ifMatch.endIdx);
  }
  return sawGuard ? false : null;
}

// (3) — notion-brain.js's `update` command must either refuse the same way
// `create` does, or the ~25 lines immediately above its definition must
// explicitly document why it stays open (pointing at the shared rationale
// in notion-write-guard.js, not just any comment).
function updateCommandDocumentsExemption(source) {
  const idx = source.indexOf('async function updateCard(');
  if (idx === -1) return false;
  const refusesLikeCreate = /notionCreateVerdict|process\.exit\(6\)/.test(source.slice(idx, idx + 2000));
  if (refusesLikeCreate) return true;
  const precedingBlock = source.slice(0, idx).split('\n').slice(-25).join('\n');
  return (
    /notion-write-guard\.js/i.test(precedingBlock) &&
    /(exempt|deliberately|intentional)/i.test(precedingBlock)
  );
}

module.exports = { createsNotionPagesDirectly, swallowsChildExit, updateCommandDocumentsExemption };
