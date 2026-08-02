'use strict';
/**
 * headless-prompt-guard.js — keep scheduled/headless prompts from handing the
 * owner a code review.
 *
 * WHY THIS EXISTS
 *   2026-08-02: the Sunday 9am newsletter review emailed the owner "when you
 *   have a minute, PR #518 fixes the underlying cause" and left the branch
 *   unmerged. The model did exactly what it was told —
 *   scripts/newsletter/sunday-review-prompt.md said "open a PR rather than
 *   committing straight to main" and "leave the PR open and mention it in the
 *   summary email so the owner merges". The standing owner rule is the
 *   opposite: an unattended run fixes the root cause and lands it; it never
 *   asks the owner to review or merge anything.
 *
 *   That rule lived only in the owner's head and in CLAUDE.md prose, so a
 *   prompt file could contradict it silently for weeks. This makes it
 *   mechanical: every prompt file a headless launcher feeds to `claude -p` is
 *   scanned in CI.
 *
 * ESCAPE HATCH
 *   A prompt legitimately needs to quote the banned phrasing in order to ban
 *   it. Wrap those lines in:
 *       <!-- prompt-guard:examples-start -->
 *       ...
 *       <!-- prompt-guard:examples-end -->
 *   Fenced regions are stripped before scanning. This is deliberately explicit
 *   — there is no "it looked like a negation" heuristic, because the original
 *   offending text contained "do NOT push directly to main" two clauses after
 *   "open a PR" and would have sailed through one.
 */

// Prompt files fed to a headless `claude -p` by a launcher/cron. Paths are
// repo-relative. Add new ones here when a new unattended prompt ships.
const HEADLESS_PROMPT_FILES = [
  'scripts/newsletter/sunday-review-prompt.md',
  'scripts/opening-night-prompts/phase1.md',
  'scripts/opening-night-prompts/phase2.md',
  'scripts/opening-night-prompts/phase3.md',
  'scripts/opening-night-prompts/monitor-v2.md',
];

const EXAMPLES_START = /<!--\s*prompt-guard:examples-start\s*-->/i;
const EXAMPLES_END = /<!--\s*prompt-guard:examples-end\s*-->/i;

const BANNED = [
  { pattern: /\bopen(ing)?\s+(a|the)\s+(PR|pull request)\b/i, why: 'tells the run to open a PR instead of landing the fix' },
  { pattern: /\bleave\s+the\s+(PR|pull request|branch)\s+open\b/i, why: 'leaves unmerged work for the owner' },
  { pattern: /\bgh\s+pr\s+create\b/i, why: 'opens a PR from an unattended run' },
  { pattern: /\bso\s+the\s+owner\s+(can\s+)?merge/i, why: 'defers the merge to the owner' },
  { pattern: /\bfor\s+the\s+owner\s+to\s+(review|merge)\b/i, why: 'defers review/merge to the owner' },
  { pattern: /\bready\s+for\s+(your|owner|his|her|their)\s+review\b/i, why: 'asks the owner to review code' },
  { pattern: /\bdo\s+not\s+merge\s+to\s+main\s+yourself\b/i, why: 'forbids the run from landing its own fix' },
];

/**
 * @param {string} text raw prompt file contents
 * @returns {{line:number, match:string, why:string}[]} violations, in file order
 */
function findOwnerHandoffViolations(text) {
  const lines = String(text).split('\n');
  const violations = [];
  let inExamples = false;

  lines.forEach((line, i) => {
    if (EXAMPLES_START.test(line)) { inExamples = true; return; }
    if (EXAMPLES_END.test(line)) { inExamples = false; return; }
    if (inExamples) return;

    for (const { pattern, why } of BANNED) {
      const m = line.match(pattern);
      if (m) violations.push({ line: i + 1, match: m[0], why });
    }
  });

  return violations;
}

module.exports = { HEADLESS_PROMPT_FILES, findOwnerHandoffViolations, BANNED };
