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
 * RULE B (missing entirely): a script that does risky work but has NO
 * --help/-h check anywhere. Pre-existing debt here is frozen in
 * scripts/.help-flag-safety-baseline.json and reported as tracked debt
 * (non-blocking); anything NOT in the baseline is a new regression and fails.
 *
 * Until #551 (2026-07-26), Rule B also required evidence of a literal
 * `--flag`-style CLI parser (process.argv + a `--`-prefixed comparison)
 * before it would flag a script — on the theory that a script with no flag
 * surface at all has nothing for a stray `--help` to collide with. That
 * theory is backwards: scripts/recover-wayback-reviews.js (env-var-only
 * config, zero process.argv references) proved the OPPOSITE — a script that
 * never inspects argv at all is the most exposed shape there is, since
 * `--help` is silently ignored as a no-op positional and main() always runs.
 * That gate made 80 risky+unguarded scripts invisible to this whole audit
 * (confirmed by re-running the check with the gate removed, #551). Rule B
 * now fires on any risky-work-without-a-help-check script, full stop.
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
const MAIN_FN_RE = /(?:async\s+)?function\s+main\s*\(/;

function loadBaseline() {
  try {
    return new Set(JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')));
  } catch {
    return new Set();
  }
}

// RISKY_CALL_RE is a /g regex shared across all 800 files in main()'s loop, so
// lastIndex MUST be left at 0 on both sides of every use. Resetting only
// BEFORE exec() left it advanced afterwards, and the next file's
// `RISKY_CALL_RE.test(...)` in checkFile then resumed from that stale offset —
// an order- and length-dependent false negative that could silently drop a
// script out of Rule B entirely (caught by the unit test added in task #684:
// a short Rule B fixture passed alone and failed after a Rule A case ran).
function firstIndex(re, src) {
  re.lastIndex = 0;
  const m = re.exec(src);
  re.lastIndex = 0;
  return m ? m.index : -1;
}

// A `/` opens a regex literal (not division) when the preceding non-space
// token can't be an operand — the standard "operand can't precede a regex"
// heuristic. Ported from scripts/audit-run-budget-coverage.js (BRO-109):
// unskipped, a brace/paren inside a regex character class (e.g. the
// `.replace(/\{\{/g, '')` markup scrubbers in scripts/lib/wiki-utils.js)
// desyncs `depth` exactly like an unskipped string would.
const REGEX_PRECEDING_CHAR_RE = /[([{,;:=!&|?+\-*%~^]$/;
const REGEX_PRECEDING_KEYWORD_RE = /(?:^|[^\w$])(return|typeof|instanceof|in|of|new|delete|void|yield|case|do|else)$/;

/** True if the `/` at src[slashIdx] plausibly opens a regex literal (vs. division), by inspecting the preceding token. */
function looksLikeRegexStart(src, slashIdx) {
  let k = slashIdx - 1;
  while (k >= 0 && /\s/.test(src[k])) k--;
  if (k < 0) return true; // nothing before it — can't be a binary division operator
  if (REGEX_PRECEDING_CHAR_RE.test(src[k])) return true;
  return REGEX_PRECEDING_KEYWORD_RE.test(src.slice(Math.max(0, k - 12), k + 1));
}

/**
 * Index just past a regex literal (and its flags) starting at src[startIdx]
 * (`src[startIdx] === '/'`), honoring backslash escapes and `[...]`
 * character classes (where an unescaped `/` does NOT end the literal).
 * Returns null if no unescaped, non-class closing `/` is found before a
 * newline (bails rather than guessing).
 */
function skipRegexLiteral(src, startIdx) {
  let i = startIdx + 1;
  let inClass = false;
  while (i < src.length && src[i] !== '\n') {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') { inClass = true; i++; continue; }
    if (c === ']') { inClass = false; i++; continue; }
    if (c === '/' && !inClass) {
      i++;
      while (i < src.length && /[a-z]/i.test(src[i])) i++; // flags: g, i, m, ...
      return i;
    }
    i++;
  }
  return null;
}

/** Index of the char matching src[openIdx] (openChar), skipping comments, string/template literals, and regex literals. */
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
    if (ch === '/' && looksLikeRegexStart(src, i)) {
      const end = skipRegexLiteral(src, i);
      if (end != null) { i = end - 1; continue; }
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

/**
 * Second view of the source, used ONLY for RISKY_CALL_RE scanning: blanks the
 * CONTENT of every string/template literal (space-fill, preserving offsets and
 * the quote characters themselves).
 *
 * stripCommentsAndStrings deliberately leaves string content intact because
 * HELP_CHECK_RE/FLAG_STYLE_RE must see the literal '--help' text inside a
 * quoted CLI-flag string. Its doc comment accepted the converse risk — a
 * string whose plain text happens to contain a risky-looking function name —
 * as "rare enough". It isn't: any script whose USAGE/log text DESCRIBES the
 * scraping stack trips it. Reproduced live (run 30681490240, task #684):
 * audit-direct-provider-calls.js's USAGE string reads "...bypassing
 * fetchPage()/fetchJSON()..." and `fetchPage(` matched the risky-call regex
 * verbatim at char 1753, failing Lint Workflows on main with a Rule A
 * violation against a script that does no unconditional work at all.
 *
 * Splitting the views resolves the tension instead of trading one blind spot
 * for the other: help-check detection keeps the intact strings, risky-call
 * detection gets the blanked ones.
 *
 * Template-literal `${...}` substitutions are deliberately PRESERVED — those
 * are real evaluated expressions, so `${execSync('x')}` is a genuine
 * unconditional call and must stay visible to the scan.
 *
 * REGEX-LITERAL AWARE, and additionally NEWLINE-SCOPED for '/". A quote
 * character inside a regex — `.replace(/&quot;/g, '"')` in
 * adjudicate-seat-research.js — would otherwise open a phantom string.
 * Unbounded, that phantom swallowed 4,800 chars of real code and hid a genuine
 * `await fetchPage(url, {})` call (caught by before/after parity, task #684).
 *
 * A false NEGATIVE here is far worse than a false positive: this guard exists
 * to stop DESTRUCTIVE scripts from running real work under `--help`, so hiding
 * a real execSync is the failure mode that matters. Newline-scoping alone did
 * NOT close it — backticks legitimately span lines, so a BACKTICK inside a
 * regex character class (`.replace(/[;&|\`$()]/g, '')` — a shell-arg sanitizer,
 * exactly the shape that then calls execSync) opened a phantom template
 * literal that ran to EOF. Live instances: execute-approved-fix.js,
 * fetch-show-images-auto.js (one of the very scripts this guard was built for,
 * task #477). So regex literals are consumed as units FIRST; the newline scope
 * on '/" stays as defence-in-depth for any residual desync.
 */

/**
 * Exact implementation, via acorn's tokenizer. Hand-rolled string scanning was
 * tried twice and desynced twice (regex literal containing a quote; regex
 * character class containing a BACKTICK), each time BLANKING REAL CODE — the
 * false-negative direction, which is the dangerous one for this guard. A real
 * lexer knows regex-vs-division from parser context, so the whole desync class
 * disappears instead of being patched case by case.
 *
 * FAILS OPEN: if acorn is unavailable or the file does not tokenize, return the
 * source UNCHANGED. That resurfaces the string-text false positive (loud, and
 * fixable with the documented `hygiene-help-flag-ok` exemption) rather than
 * silently hiding a real execSync.
 */
function blankStringContentsViaAcorn(src) {
  let acorn;
  try { acorn = require('acorn'); } catch { return null; }

  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k++) {
      if (out[k] !== '\n') out[k] = ' '; // keep newlines so line numbers survive
    }
  };

  try {
    // Tokenize the RAW source, and blank comments here too rather than relying
    // on stripCommentsAndStrings' naive `//` scan — that scan treats the `//`
    // inside a regex like /https?:\/\// as a line comment and erases the rest
    // of the line, which left 53 of 800 files unparseable (they then fell open
    // and never got the false-positive fix).
    const onComment = (block, text, start, end) => blank(start, end);
    const tokenizer = acorn.tokenizer(src, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowSuperOutsideMethod: true,
      onComment,
    });
    for (const tok of tokenizer) {
      const label = tok.type.label;
      if (label === 'string' || label === 'regexp') {
        blank(tok.start + 1, tok.end - 1); // keep the delimiters
      } else if (label === 'template' || label === 'invalidTemplate') {
        // Only the literal chunks are `template` tokens; `${ ... }` expression
        // tokens are separate and are deliberately left visible — they are
        // evaluated code, so `${execSync('x')}` must stay scannable.
        blank(tok.start, tok.end);
      }
    }
  } catch {
    return null; // unparseable → fail open
  }
  return out.join('');
}

function blankStringContents(src) {
  const exact = blankStringContentsViaAcorn(src);
  if (exact !== null) return exact;
  return src; // fail open — never silently blank real code
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
function checkOrdering(cleanSrc, riskySrc = blankStringContents(cleanSrc)) {
  const helpAnywhere = HELP_CHECK_RE.test(cleanSrc);
  const mainMatch = MAIN_FN_RE.exec(cleanSrc);
  const windowStart = mainMatch ? mainMatch.index : 0;

  // A top-level help gate placed BEFORE main() is declared gates everything
  // that follows in module-load order — the window-scoped search below never
  // sees it and flagged such scripts as "no --help check anywhere"
  // (enrich-fallback-ticket-links.js, run 30658402896: gate at top, main()
  // declared later). Recognize it, requiring only that no risky top-level
  // call precedes the gate itself.
  if (windowStart > 0) {
    const topHelp = new RegExp(HELP_CHECK_RE, 'g').exec(cleanSrc.slice(0, windowStart));
    if (topHelp) {
      // Gate position comes from cleanSrc (needs the intact '--help' string);
      // the risky-call scan reads riskySrc at the SAME offsets (both views are
      // length-preserving), so string CONTENT can't fake a call.
      const beforeGate = stripNonInvokedFunctionBodies(riskySrc.slice(0, topHelp.index));
      const riskyIdx = firstIndex(RISKY_CALL_RE, beforeGate);
      return { hasHelpCheck: true, riskyBeforeHelp: riskyIdx !== -1, riskyIdx };
    }
  }

  // Strip non-invoked function bodies before searching — a risky call INSIDE
  // a helper function defined lexically before main() is not "unconditional
  // top-level work" unless that helper is an IIFE (see
  // stripNonInvokedFunctionBodies doc comment).
  const topLevelRiskyIdx = firstIndex(RISKY_CALL_RE, stripNonInvokedFunctionBodies(riskySrc.slice(0, windowStart)));
  if (topLevelRiskyIdx !== -1) {
    return { hasHelpCheck: helpAnywhere, riskyBeforeHelp: true, riskyIdx: topLevelRiskyIdx };
  }

  const windowText = cleanSrc.slice(windowStart);
  const helpMatch = new RegExp(HELP_CHECK_RE, 'g').exec(windowText);
  if (!helpMatch) return { hasHelpCheck: false };

  const beforeGate = stripNonInvokedFunctionBodies(riskySrc.slice(windowStart).slice(0, helpMatch.index));
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

  // Deliberately UNSCOPED (whole file, any function, invoked or not) —
  // unlike checkOrdering()'s stripNonInvokedFunctionBodies pass. Tried
  // scoping this the same way (#551 adversarial review follow-up: a risky
  // call inside a truly-dead/never-called helper shouldn't count) and it
  // collapsed Rule B from 207 candidates to 33, because
  // stripNonInvokedFunctionBodies only recognizes IIFEs
  // (`(function(){...})()`) as "invoked" — it blanks every ordinary
  // `function main() { ... }` body too, since `main()` is called SEPARATELY
  // at the bottom of the file, not as an immediate IIFE. That's correct for
  // Rule A (main()'s body genuinely doesn't run before its own --help gate
  // fires) but wrong for Rule B, where the question is "does this script
  // EVER do risky work", and main()'s body obviously does. The theoretical
  // false-positive this scoping would have prevented (a risky call sitting
  // in a truly dead, never-invoked-by-anyone helper) has no instance in the
  // current corpus (verified) and is already covered by the
  // `// hygiene-help-flag-ok: <reason>` exemption if one ever appears.
  // Risky-call scans read a SECOND view with string content blanked too — a
  // USAGE/log string that merely NAMES a risky function is not a call
  // (task #684; see blankStringContents). Built from the RAW source so acorn
  // sees real syntax; only if that fails do we fall back to the heuristic
  // scanner over cleanSrc.
  const riskySrc = blankStringContentsViaAcorn(src) ?? blankStringContents(cleanSrc);

  RISKY_CALL_RE.lastIndex = 0; // defensive: /g state must not leak in either direction
  const hasRiskyOp = RISKY_CALL_RE.test(riskySrc);
  RISKY_CALL_RE.lastIndex = 0;

  const ordering = checkOrdering(cleanSrc, riskySrc);

  if (ordering.hasHelpCheck && ordering.riskyBeforeHelp) {
    return {
      file,
      rule: 'A',
      blocking: true,
      detail: `--help check exists but a risky call runs unconditionally before it (char ${ordering.riskyIdx})`,
    };
  }

  if (!ordering.hasHelpCheck && hasRiskyOp) {
    return { file, rule: 'B', blocking: true, detail: 'performs risky work (execSync/child_process/saveShows/safeWriteReview/fs delete/network call) with no --help/-h check anywhere' };
  }

  return null;
}

/**
 * Is the acorn tokenizer (the precise string-blanking path) actually usable
 * in THIS process? blankStringContentsViaAcorn() falls back to the naive
 * hand-rolled scanner when acorn cannot be required — and that fallback is
 * NOT harmless. Measured 2026-08-12 on a checkout with no node_modules:
 * two clean files (audit-digest-clip-safety.js, audit-fetchpage-cleanup.js)
 * were reported as blocking Rule A / Rule B violations, exit 1, byte-identical
 * scripts/ tree to a checkout that passed. The doc comment above calls that
 * "FAILS OPEN"; from CI's point of view it fails CLOSED, and it points the
 * next session at two files that have nothing wrong with them.
 *
 * lint-workflows already runs `npm ci` for exactly this reason (task #684),
 * so this guard should never fire there. It exists so that when the install
 * step is skipped, cached wrong, or the audit is run from a fresh clone, the
 * failure names its real cause instead of manufacturing file-level findings.
 */
function tokenizerStatus() {
  try {
    require.resolve('acorn');
    return { ok: true, detail: 'acorn resolved — precise tokenizer path active' };
  } catch {
    return {
      ok: false,
      detail:
        'acorn is not installed, so string CONTENT cannot be told apart from a real call. ' +
        'Any Rule A/Rule B findings from this run would be unreliable. Run `npm ci` and re-run.',
    };
  }
}

function main() {
  const updateBaseline = process.argv.includes('--update-baseline');

  const tokenizer = tokenizerStatus();
  if (!tokenizer.ok) {
    console.error(`🚨 Help-flag safety guard cannot run: ${tokenizer.detail}`);
    process.exitCode = 1;
    return;
  }

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

// Only run the audit when executed directly — `require()`d from a unit test,
// the module must expose its decision functions without scanning the repo
// (CLAUDE.md §15: tests require() the real function, never a copy of it).
if (require.main === module) main();

module.exports = {
  checkFile,
  checkOrdering,
  tokenizerStatus,
  stripCommentsAndStrings,
  blankStringContents,
  blankStringContentsViaAcorn,
  RISKY_CALL_RE,
  findMatching,
  stripNonInvokedFunctionBodies,
};
