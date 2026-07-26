#!/usr/bin/env node
/**
 * Lint guard for the "cousin --help bug" class (#498): CLI scripts that
 * execute real side effects (network calls, corpus writes, child_process
 * dispatches) when invoked with `--help`/`-h` instead of printing usage.
 *
 * Fixed one-off nine times before this guard existed: autonomous-run.js +
 * autonomous-probe.js (#260/#263), autonomous-merge.js (#264),
 * audit-show-review-gap.js (#266), bsc-conductor.js + bsc-prune.js (#185),
 * and — the incident that triggered this card — collect-review-texts.js,
 * rebuild-all-reviews.js, fetch-show-images-auto.js (task #477 session log,
 * 2026-07-26: all three ran real network/filesystem work under --help before
 * being pkilled mid-execution).
 *
 * Two rules, both heuristic (regex + brace-matching, consistent with
 * audit-run-budget-coverage.js — false positives/negatives expected):
 *
 * RULE A (position bug, always blocking): a script that already ATTEMPTS a
 * --help/-h check (hasHelpFlag(...) or a literal '--help'/'-h' comparison)
 * but whose check sits textually AFTER a risky call (execSync/spawn/
 * child_process, saveShows/safeWriteReview, or a raw fs write/delete) that
 * runs unconditionally before it. This catches regressions in the 18 scripts
 * that already use the scripts/lib/cli-help.js convention.
 *
 * RULE B (missing entirely): a script that takes CLI args (references
 * process.argv) and does risky work, but has NO --help/-h check anywhere.
 * This is the actual shape of all nine prior incidents. The full corpus has
 * pre-existing debt here (~26 scripts as of 2026-07-26) — retrofitting all of
 * them is out of scope for this card. Pre-existing offenders are frozen in
 * scripts/.help-flag-safety-baseline.json and reported as tracked debt
 * (non-blocking); anything NOT in the baseline is a new regression and fails.
 *
 * Exemption (reviewed false positive, e.g. a "risky" call that's actually
 * read-only, or a script whose default behavior is genuinely harmless to
 * run twice): add  // hygiene-help-flag-ok: <reason>  anywhere in the file.
 *
 * Usage:
 *   node scripts/audit-help-flag-safety.js            check + report
 *   node scripts/audit-help-flag-safety.js --update-baseline
 *                                                      regenerate the baseline
 *                                                      from CURRENT missing-check
 *                                                      offenders (review the diff!)
 *   node scripts/audit-help-flag-safety.js --help, -h  print this usage and exit
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `audit-help-flag-safety.js — lint guard for scripts that do real work on --help.

Usage:
  node scripts/audit-help-flag-safety.js              check scripts/, report violations
  node scripts/audit-help-flag-safety.js --update-baseline
                                                       regenerate the pre-existing-debt
                                                       baseline from current findings
  node scripts/audit-help-flag-safety.js --help, -h    print this usage and exit
`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const SCRIPTS_DIR = __dirname;
const BASELINE_PATH = path.join(SCRIPTS_DIR, '.help-flag-safety-baseline.json');
const EXEMPTION = 'hygiene-help-flag-ok';

const HELP_CHECK_RE = /hasHelpFlag\s*\(|(['"])--help\1|(['"])-h\2(?=\s*[),;]|\s*===|\.includes)/;
// Real, consequential side effects: shelling out, the two corpus-write
// guards, destructive fs deletes, and bare network calls — NOT generic
// fs.writeFileSync/appendFileSync, which are also used for harmless
// audit/cache/report output all over scripts/ and would swamp this check
// with false positives (calibrated against the real corpus: including those
// two inflated Rule B from ~145 to 400+ hits, mostly on report-only scripts).
// rmSync/unlinkSync and axios/https/bare-fetch ARE included — 2 of the 3
// task #477 incidents were exactly this shape (adversarial review finding).
// fetchPage IS included — it's the mandated wrapper for BD/SB/Playwright
// network calls (CLAUDE.md §"Web Scraping": "all new scraping MUST use
// fetchPage() ... never call BD/SB APIs directly"), so it's the actual call
// site for every scraper's real work, not just a theoretical risky primitive
// (independent adversarial review finding, task #498: the original regex list
// missed it entirely, meaning the two scrapers this card exists to catch —
// collect-review-texts.js, fetch-show-images-auto.js — could reintroduce the
// same bug via fetchPage() and this guard would stay silent).
// NOTE: deliberately does NOT match `require('child_process')` itself — that's
// just an import statement (often destructured/renamed for later gated use,
// e.g. bsc-conductor.js's `spawnSync: realSpawnSync`), not a risky CALL, and
// matching it produced false positives on every already-fixed autonomous-*/
// bsc-* script (adversarial review follow-up, task #498).
const RISKY_CALL_RE = /\b(?:execSync|spawnSync|spawn|execFile(?:Sync)?)\s*\(|\bsaveShows\s*\(|\bsafeWriteReview\s*\(|\bfs\.(?:rmSync|unlinkSync|rmdirSync)\s*\(|\baxios\.\w+\s*\(|\bhttps?\.(?:request|get)\s*\(|\bfetchPage\s*\(|\bfetch\s*\(/g;
const ARGV_RE = /process\.argv/;
// A literal `--flag`-style comparison is the signal that a script has a real
// CLI flag surface (vs. one that only reads env vars / a bare positional id)
// — the shape every one of the nine prior --help incidents had.
const FLAG_STYLE_RE = /\.startsWith\(\s*['"]--|\.includes\(\s*['"]--|===\s*['"]--/;
const MAIN_FN_RE = /(?:async\s+)?function\s+main\s*\(/;

function loadBaseline() {
  try {
    return new Set(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')));
  } catch {
    return new Set();
  }
}

function firstIndex(re, src) {
  re.lastIndex = 0;
  const m = re.exec(src);
  return m ? m.index : -1;
}

/** Index of the char matching src[openIdx] (openChar), skipping comments and string/template literals. */
function findMatching(src, openIdx, openChar, closeChar) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length + 1 : end + 1;
      continue;
    }
    if (ch === '`' || ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < src.length && src[j] !== quote) { if (src[j] === '\\') j++; j++; }
      i = j;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) { depth--; if (depth === 0) return i; }
  }
  return null;
}

/**
 * Blanks comments only (space-fill, preserving offsets) so RISKY_CALL_RE
 * can't match a function name mentioned in a comment. Reproduced live during
 * review: audit-show-review-gap.js has `// Use execFileSync (no shell) so
 * ...` as a comment — "execFileSync (" matched the risky-call regex
 * verbatim. String/template literal CONTENT is deliberately left intact
 * (only skipped-over, not blanked) — FLAG_STYLE_RE/HELP_CHECK_RE need to see
 * the literal '--flag' text inside a real quoted CLI-flag string, and a
 * string containing a risky-looking function name as plain text is rare
 * enough that the heuristic accepts the false-negative risk (matches this
 * script's general "heuristic, false positives/negatives expected" stance).
 */
function stripCommentsAndStrings(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '/' && src[i + 1] === '/') {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      out += ' '.repeat(end - i);
      i = end - 1;
      continue;
    }
    if (ch === '/' && src[i + 1] === '*') {
      const closeIdx = src.indexOf('*/', i + 2);
      const end = closeIdx === -1 ? src.length : closeIdx + 2;
      out += ' '.repeat(end - i);
      i = end - 1;
      continue;
    }
    if (ch === '`' || ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < src.length && src[j] !== quote) { if (src[j] === '\\') j++; j++; }
      const end = j < src.length ? j + 1 : src.length;
      out += src.slice(i, end); // copy through unchanged — just skip past it correctly
      i = end - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

// Matches only up to and including the OPENING paren of a function/arrow's
// parameter list (function declarations, anonymous functions, and
// parenthesized arrow params). The real closing paren is then found via
// findMatching (paren-depth aware) — a naive `\([^)]*\)` here breaks on any
// parenthesized default parameter value like `function f(now = Date.now()) {`,
// where the FIRST `)` belongs to `Date.now(` not the parameter list
// (adversarial review follow-up, task #498: this exact shape left
// opening-night-monitor-launch.js's gcStateFiles() helper unstripped).
const FUNC_HEAD_PAREN_RE = /(?:async\s+)?function\s*[A-Za-z_$][\w$]*\s*\(|(?:async\s+)?function\s*\(|(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\(/g;
// Bare single-identifier arrow param (no parens at all — `x => { ... }`) has
// no nested-paren hazard, so it can go straight to matching the `{`.
const FUNC_HEAD_BAREARROW_RE = /(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?[A-Za-z_$][\w$]*\s*=>\s*\{/g;

/**
 * Blanks out (space-fills, preserving offsets) every function body in `src`
 * that is NOT immediately invoked. A function/arrow DECLARATION does not run
 * until something calls it by name — a risky call lexically inside one is
 * not "unconditional top-level work" unless that function is an IIFE
 * (`(() => { ... })()` / `(function(){ ... })()`), which DOES execute at
 * parse time and is deliberately left visible.
 *
 * Without this, scanning "everything before main()" for a risky call
 * produces false positives on every script whose fixed --help check sits
 * inside main() but which ALSO defines an unrelated helper function
 * (containing e.g. execSync) earlier in the file for main() to call AFTER
 * the gate — exactly the shape of all 16 already-fixed scripts plus this
 * task's own 2 main()-based fixes (adversarial review finding, task #498).
 */
function stripNonInvokedFunctionBodies(src) {
  const blankRanges = [];

  function recordBody(openBraceIdx, reToAdvance) {
    const closeBraceIdx = findMatching(src, openBraceIdx, '{', '}');
    if (closeBraceIdx == null) { reToAdvance.lastIndex = openBraceIdx + 1; return; }
    let after = closeBraceIdx + 1;
    while (after < src.length && /\s/.test(src[after])) after++;
    const isIIFE = /^\)\s*\(\s*\)/.test(src.slice(after));
    if (!isIIFE) blankRanges.push([openBraceIdx + 1, closeBraceIdx]);
    reToAdvance.lastIndex = closeBraceIdx + 1;
  }

  // Parenthesized headers: function decls, anonymous functions, arrow fns
  // with (...) params. Matches only up to the opening '(' — the real
  // closing paren is found via findMatching (paren-depth aware) so a
  // parenthesized default value (`now = Date.now()`) can't fool it.
  {
    const re = new RegExp(FUNC_HEAD_PAREN_RE.source, 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      const openParenIdx = m.index + m[0].length - 1;
      const closeParenIdx = findMatching(src, openParenIdx, '(', ')');
      if (closeParenIdx == null) { re.lastIndex = openParenIdx + 1; continue; }
      let k = closeParenIdx + 1;
      while (k < src.length && /\s/.test(src[k])) k++;
      if (src.slice(k, k + 2) === '=>') {
        k += 2;
        while (k < src.length && /\s/.test(src[k])) k++;
      }
      if (src[k] !== '{') { re.lastIndex = closeParenIdx + 1; continue; } // expression-body arrow, not a block
      recordBody(k, re);
    }
  }

  // Bare single-identifier arrow params (`x => { ... }`) — no parens, so no
  // nested-paren hazard; the regex already ends at the opening '{'.
  {
    const re = new RegExp(FUNC_HEAD_BAREARROW_RE.source, 'g');
    let m;
    while ((m = re.exec(src)) !== null) {
      recordBody(m.index + m[0].length - 1, re);
    }
  }

  blankRanges.sort((a, b) => a[0] - b[0]);
  let result = src;
  for (let i = blankRanges.length - 1; i >= 0; i--) {
    const [s, e] = blankRanges[i];
    result = result.slice(0, s) + ' '.repeat(e - s) + result.slice(e);
  }
  return result;
}

/**
 * Rule A checks ordering only WITHIN the window a human actually reads as
 * "runs before the gate" — from the start of main() (or file start, for
 * main()-less top-level-pipeline scripts like rebuild-all-reviews.js) up to
 * the help check itself. Scanning the WHOLE file for the first risky-call
 * regex hit (as an earlier draft of this script did) produced false
 * positives on every one of the 18 already-fixed scripts: a risky call
 * textually appearing in a LATER helper function (defined lexically before
 * main() but only invoked from within main() AFTER the --help gate) is not
 * actually reachable before the gate — source order isn't execution order.
 *
 * The help-check search is ALSO scoped to start at windowStart (not the
 * whole file) — an earlier version searched the whole file for the first
 * HELP_CHECK_RE hit, so a USAGE string containing a quoted '--help'/'-h'
 * token BEFORE main() would satisfy hasHelpCheck without there being any
 * real gate inside main() at all (adversarial review finding, task #498).
 *
 * A risky call BEFORE main() is declared (top-level, requires-adjacent) is
 * checked separately and unconditionally: it runs on module load regardless
 * of anything main() does — no --help check placed INSIDE main() can ever
 * prevent it. Reproduced live during review: execSync() placed at top level
 * before an otherwise-correct `if (hasHelpFlag(...))` inside main() sailed
 * through the windowed check because the window started at main().
 */
function checkOrdering(cleanSrc) {
  const helpAnywhere = HELP_CHECK_RE.test(cleanSrc);
  const mainMatch = MAIN_FN_RE.exec(cleanSrc);
  const windowStart = mainMatch ? mainMatch.index : 0;

  // Strip non-invoked function bodies before searching — a risky call INSIDE
  // a helper function defined lexically before main() is not "unconditional
  // top-level work" unless that helper is an IIFE (see
  // stripNonInvokedFunctionBodies doc comment).
  const topLevelRiskyIdx = firstIndex(RISKY_CALL_RE, stripNonInvokedFunctionBodies(cleanSrc.slice(0, windowStart)));
  if (topLevelRiskyIdx !== -1) {
    return { hasHelpCheck: helpAnywhere, riskyBeforeHelp: true, riskyIdx: topLevelRiskyIdx };
  }

  const windowText = cleanSrc.slice(windowStart);
  const helpMatch = new RegExp(HELP_CHECK_RE, 'g').exec(windowText);
  if (!helpMatch) return { hasHelpCheck: false };

  const beforeGate = stripNonInvokedFunctionBodies(windowText.slice(0, helpMatch.index));
  const riskyIdx = firstIndex(RISKY_CALL_RE, beforeGate);
  return { hasHelpCheck: true, riskyBeforeHelp: riskyIdx !== -1, riskyIdx: riskyIdx === -1 ? -1 : windowStart + riskyIdx };
}

function checkFile(file, src) {
  if (src.includes(EXEMPTION)) return null;

  // Comments/strings blanked ONCE up front — a function name mentioned in a
  // comment ("// uses execSync (no shell)...") or log message must not read
  // as a real call (adversarial review finding, task #498). Structural
  // regexes (MAIN_FN_RE, brace matching) are unaffected: blanking preserves
  // length/offsets and never touches braces.
  const cleanSrc = stripCommentsAndStrings(src);

  const takesCliArgs = ARGV_RE.test(cleanSrc) && FLAG_STYLE_RE.test(cleanSrc);
  const hasRiskyOp = RISKY_CALL_RE.test(cleanSrc);
  RISKY_CALL_RE.lastIndex = 0;

  const ordering = checkOrdering(cleanSrc);

  if (ordering.hasHelpCheck && ordering.riskyBeforeHelp) {
    return {
      file,
      rule: 'A',
      blocking: true,
      detail: `--help check exists but a risky call runs unconditionally before it (char ${ordering.riskyIdx})`,
    };
  }

  if (!ordering.hasHelpCheck && takesCliArgs && hasRiskyOp) {
    return { file, rule: 'B', blocking: true, detail: 'takes flagged CLI args + performs risky work (execSync/child_process/saveShows/safeWriteReview/fs delete/network call) with no --help/-h check anywhere' };
  }

  return null;
}

function main() {
  const updateBaseline = process.argv.includes('--update-baseline');
  const files = fs
    .readdirSync(SCRIPTS_DIR)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => f !== path.basename(__filename))
    .sort();

  const baseline = loadBaseline();
  const findings = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, file), 'utf8');
    const finding = checkFile(file, src);
    if (finding) findings.push(finding);
  }

  const ruleA = findings.filter((f) => f.rule === 'A');
  const ruleBAll = findings.filter((f) => f.rule === 'B');
  const ruleBNew = ruleBAll.filter((f) => !baseline.has(f.file));
  const ruleBBaselined = ruleBAll.filter((f) => baseline.has(f.file));

  if (updateBaseline) {
    const newBaseline = ruleBAll.map((f) => f.file).sort();
    const newSet = new Set(newBaseline);
    // Always print the diff — a shrinking baseline should be reviewed, not
    // silently trusted (a Rule-A bug "fixed" by deleting the check entirely
    // turns it into a Rule-B finding that would otherwise get silently
    // re-frozen as non-blocking debt; adversarial review finding, task #498).
    const added = newBaseline.filter((f) => !baseline.has(f));
    const removed = [...baseline].filter((f) => !newSet.has(f)).sort();
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(newBaseline, null, 2) + '\n');
    console.log(`Wrote ${newBaseline.length} entries to ${path.relative(process.cwd(), BASELINE_PATH)} (was ${baseline.size}).`);
    if (added.length) console.log(`  + added: ${added.join(', ')}`);
    if (removed.length) console.log(`  - removed: ${removed.join(', ')}`);
    return;
  }

  const blocking = [...ruleA, ...ruleBNew];
  const staleBaselineEntries = [...baseline].filter((f) => !ruleBAll.some((finding) => finding.file === f)).sort();

  if (ruleBBaselined.length > 0) {
    console.log(`ℹ️  ${ruleBBaselined.length} pre-existing script(s) tracked in ${path.basename(BASELINE_PATH)} (no --help check, not blocking) — fix opportunistically.`);
  }
  if (staleBaselineEntries.length > 0) {
    console.log(`ℹ️  ${staleBaselineEntries.length} baseline entr${staleBaselineEntries.length === 1 ? 'y' : 'ies'} already fixed — re-run with --update-baseline to shrink the list: ${staleBaselineEntries.join(', ')}`);
  }

  if (blocking.length === 0) {
    console.log(`✅ Help-flag safety guard: no violations (${files.length} scripts checked, ${ruleBBaselined.length} baselined).`);
    return;
  }

  console.log(`🚨 Help-flag safety guard: ${blocking.length} violation(s):\n`);
  for (const f of blocking) {
    console.log(`  [Rule ${f.rule}] ${f.file}`);
    console.log(`      ${f.detail}`);
  }
  console.log(`\nFix: check hasHelpFlag(argv) from scripts/lib/cli-help.js BEFORE any real work runs (print`);
  console.log(`usage + return/exit). See collect-review-texts.js / rebuild-all-reviews.js / fetch-show-images-auto.js`);
  console.log(`for the established pattern (task #498).`);
  console.log(`False positive? Add  // ${EXEMPTION}: <reason>  anywhere in the file.\n`);
  process.exitCode = 1;
}

main();
