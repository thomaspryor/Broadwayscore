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
 *
 *   The fence FAILS LOUD, by design (second-opinion 2026-08-02, blocker C1):
 *   an unclosed fence, a stray END, or both markers on one line used to leave
 *   the scanner blind for the rest of the file while still looking "balanced"
 *   to a naive open/close count. All three now produce a violation of their
 *   own, so the only way to silence the guard is a correct, closed fence.
 *
 * CLI
 *   node scripts/lib/headless-prompt-guard.js [--all | <file>...]
 *   Exits 1 with a report if any scanned prompt carries owner-handoff text, so
 *   a launcher can gate its own prompt at run time, not only in CI.
 */

const fs = require('fs');
const path = require('path');

// Directories whose *.md files are prompts fed to a headless `claude -p`.
// Globbed, not hand-listed: opening-night-monitor.sh builds `phase${N}.md`
// from an argument, so a future phase4.md is consumed automatically and a
// hand-maintained include list would silently miss it (blocker D2).
const PROMPT_GLOBS = [
  { dir: 'scripts/opening-night-prompts', match: (f) => f.endsWith('.md') },
  { dir: 'scripts/newsletter', match: (f) => /-prompt\.md$/.test(f) },
];

// Launcher sources that build a prompt inline (heredoc/template) rather than
// reading a .md file. They get scanned as text too — weekly-retro.sh writes
// its prompt into a mktemp file, so there is no prompt path to glob.
const INLINE_PROMPT_SOURCES = [
  'scripts/local-triggers/weekly-retro.sh',
];

const EXAMPLES_START = /<!--\s*prompt-guard:examples-start\s*-->/i;
const EXAMPLES_END = /<!--\s*prompt-guard:examples-end\s*-->/i;

const BANNED = [
  {
    pattern: /\b(open|raise|create|file|submit|put\s+up)(ing|s)?\s+(a|the|another)\s+(PR|pull request)\b/i,
    why: 'tells the run to open a PR instead of landing the fix',
  },
  {
    pattern: /\bgh\s+pr\s+create\b/i,
    why: 'opens a PR from an unattended run',
  },
  {
    pattern: /\b(leave|leaving|park|parking|keep|keeping)\b[^.\n]{0,60}\b(PR|pull request|branch)\b[^.\n]{0,40}\b(open|unmerged|for (the )?(owner|you|review))\b/i,
    why: 'leaves unmerged work sitting for the owner',
  },
  {
    pattern: /\bowner\s+(can\s+|will\s+|should\s+|to\s+)?(merge|merges|review|reviews|approve|approves)\b/i,
    why: 'defers the merge/review to the owner',
  },
  {
    pattern: /\bfor\s+(the\s+owner|you|your|his|her|their)\s+to\s+(review|merge|approve|look at)\b/i,
    why: 'defers review/merge to the owner',
  },
  {
    pattern: /\bready\s+for\s+(your|owner|his|her|their|)\s*review\b/i,
    why: 'asks the owner to review code',
  },
  {
    pattern: /\bwait(ing|s)?\s+for\b[^.\n]{0,40}\b(owner|your|their)\b[^.\n]{0,30}\b(approval|review|sign-?off|go-?ahead)\b/i,
    why: 'blocks the run on owner approval instead of landing the fix',
  },
  {
    pattern: /\bhand(ing|s)?\s+(the\s+)?(fix|change|work|it)\s+(off\s+)?(to|over to)\s+(the\s+)?(owner|you)\b/i,
    why: 'hands the work to the owner',
  },
  {
    pattern: /\bdo\s+not\s+merge\s+to\s+main\s+yourself\b/i,
    why: 'forbids the run from landing its own fix',
  },
];

/**
 * @param {string} text raw prompt file contents
 * @returns {{line:number, match:string, why:string}[]} violations, in file order
 */
function findOwnerHandoffViolations(text) {
  const lines = String(text).split('\n');
  const violations = [];
  let depth = 0;

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const hasStart = EXAMPLES_START.test(line);
    const hasEnd = EXAMPLES_END.test(line);

    // Both markers on one line used to latch inExamples=true forever while a
    // naive open/close tally still read 1/1. Treat it as malformed, loudly.
    if (hasStart && hasEnd) {
      violations.push({
        line: lineNo,
        match: line.trim().slice(0, 80),
        why: 'malformed prompt-guard fence: start and end markers on one line',
      });
      return;
    }
    if (hasStart) { depth += 1; return; }
    if (hasEnd) {
      depth -= 1;
      if (depth < 0) {
        violations.push({
          line: lineNo,
          match: line.trim().slice(0, 80),
          why: 'prompt-guard fence closed without being opened',
        });
        depth = 0;
      }
      return;
    }
    if (depth > 0) return;

    for (const { pattern, why } of BANNED) {
      const m = line.match(pattern);
      if (m) violations.push({ line: lineNo, match: m[0], why });
    }
  });

  if (depth > 0) {
    violations.push({
      line: lines.length,
      match: '<unclosed prompt-guard:examples fence>',
      why: 'fence opened and never closed — everything after it went unscanned',
    });
  }

  return violations;
}

/** Repo-relative paths of every prompt/launcher this guard scans. */
function discoverHeadlessPromptFiles(repoRoot) {
  const found = [];
  for (const { dir, match } of PROMPT_GLOBS) {
    const abs = path.join(repoRoot, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs).sort()) {
      if (match(f)) found.push(path.posix.join(dir, f));
    }
  }
  for (const rel of INLINE_PROMPT_SOURCES) {
    if (fs.existsSync(path.join(repoRoot, rel))) found.push(rel);
  }
  return found;
}

/**
 * Every .md path a launcher feeds to `claude -p`, derived from the launchers
 * themselves. Used to assert discoverHeadlessPromptFiles() has no blind spot:
 * a new prompt in a new directory shows up here even though no glob covers it.
 * Paths with shell interpolation (`phase${PHASE}.md`) resolve to their dir.
 */
function promptPathsReferencedByLaunchers(repoRoot) {
  const refs = new Set();
  const walk = (rel) => {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = path.posix.join(rel, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        walk(childRel);
      } else if (/\.(sh|js|mjs)$/.test(entry.name)) {
        if (childRel === 'scripts/lib/headless-prompt-guard.js') continue; // don't match our own regexes
        const src = fs.readFileSync(path.join(repoRoot, childRel), 'utf8');
        if (!/claude\b[^\n]*\s-p\b/.test(src) && !/PROMPT_FILE=/.test(src)) continue;
        for (const m of src.matchAll(/PROMPT_(?:FILE|DIR)="?([^"'\s]+)"?/g)) {
          refs.add(m[1]);
        }
      }
    }
  };
  walk('scripts');
  return [...refs];
}

function main(argv) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: node scripts/lib/headless-prompt-guard.js [--all | <file>...]');
    console.log('Scans headless-run prompt files for owner-handoff phrasing. Exit 1 if any found.');
    return 0;
  }
  const targets = args.length && args[0] !== '--all'
    ? args
    : discoverHeadlessPromptFiles(repoRoot);

  let bad = 0;
  for (const rel of targets) {
    const abs = path.isAbsolute(rel) ? rel : path.join(repoRoot, rel);
    if (!fs.existsSync(abs)) { console.error(`missing: ${rel}`); bad += 1; continue; }
    for (const v of findOwnerHandoffViolations(fs.readFileSync(abs, 'utf8'))) {
      console.error(`${rel}:${v.line}  "${v.match}" — ${v.why}`);
      bad += 1;
    }
  }
  if (bad) {
    console.error(`\n${bad} owner-handoff problem(s). Unattended runs land their own fixes.`);
    return 1;
  }
  console.log(`✓ ${targets.length} headless prompt(s) clean`);
  return 0;
}

module.exports = {
  findOwnerHandoffViolations,
  discoverHeadlessPromptFiles,
  promptPathsReferencedByLaunchers,
  PROMPT_GLOBS,
  INLINE_PROMPT_SOURCES,
  BANNED,
};

if (require.main === module) process.exit(main(process.argv));
