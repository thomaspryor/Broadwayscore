#!/usr/bin/env node
/**
 * Repo-wide lint guard for the "indefinite network hang" class (#1862, BRO-108
 * follow-up): fetch()/https.get()/http.get()/https.request()/http.request()
 * call sites with no timeout protection can hang a script forever on a dead
 * socket, eating a whole cron run (or its 45-min job timeout) for one stuck
 * request. BRO-108 fixed this one file at a time in
 * scripts/discover-new-shows.js (PR 629); this is the generalization of that
 * fix's regression test into a scanner over the rest of scripts/.
 * https.request()/http.request() coverage was added later (BRO-3838): the
 * original scope missed it entirely, and an unprotected https.request() POST
 * to api.anthropic.com in scripts/batch-commercial-research.js hung a 60min
 * job for the full timeout (BRO-3832) without this scanner ever flagging it.
 *
 * Detection is heuristic (regex + acorn tokenizing, same class of tradeoff as
 * audit-help-flag-safety.js) — false positives/negatives expected, same as
 * every other audit-*.js in this repo. Protection matching is TIED to the
 * specific call site, not just "does a protection pattern appear anywhere in
 * the enclosing function": fetch()'s AbortSignal.timeout/AbortController
 * check is scoped to the exact `signal:` identifier that call passes, and
 * https.get()'s destroy-handler check is scoped to the exact request
 * variable that call assigns (or, for a chained call with no variable, to
 * just that chained statement). Without this, one call's real protection
 * silently masked a completely different, genuinely unprotected sibling call
 * in the same function — caught live by two independent adversarial reviews
 * (Claude + Codex) converging on the same finding, then confirmed against
 * the real corpus. Two independent protection shapes are recognized, both
 * real patterns in this codebase:
 *
 *   fetch(url, { signal: AbortSignal.timeout(N), ... })
 *
 *   https.get(url, { timeout: N }, (res) => { ... })
 *     .on('timeout', () => { req.destroy(); ... })
 *   -- OR --
 *   const req = https.get(url, (res) => { ... });
 *   req.setTimeout(N, () => { req.destroy(); ... })
 *
 * https.request()/http.request() are checked with the exact same two shapes
 * (they're the same underlying http.ClientRequest as https.get(), just used
 * for non-GET methods — POST bodies especially, which https.get() can't
 * send at all), just with the options object conventionally passed as the
 * call's only/first argument rather than a second positional arg after a URL
 * string. The options/destroy-handler checks below don't care about argument
 * position, so no separate detection logic was needed for that shape.
 *
 * The `{ timeout: N }` option alone does NOT protect a request — Node just
 * emits a 'timeout' event and does nothing further, so the socket hangs
 * forever unless something calls .destroy() on it (BRO-108, second commit:
 * this exact gap survived a first-pass fix in discover-new-shows.js and was
 * only caught by adversarial review). Both option-without-destroy and no
 * option at all are reported.
 *
 * Usage:
 *   node scripts/audit-fetch-timeouts.js                 scan scripts/, report all findings (exit 0 — informational, scale is too large to block on yet)
 *   node scripts/audit-fetch-timeouts.js --file=<path>    scan one file, exit 1 if it has any findings (for CI-gating already-clean files against regression)
 *   node scripts/audit-fetch-timeouts.js --json           machine-readable findings on stdout
 *   node scripts/audit-fetch-timeouts.js --help, -h        print this usage and exit
 *
 * Exemption (reviewed false positive — e.g. a call that's genuinely bounded
 * by an outer timeout, or read-only tooling run once by hand and watched):
 * add  // hygiene-fetch-timeout-ok: <reason>  anywhere in the file.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

const USAGE = `audit-fetch-timeouts.js — lint guard for fetch()/https.get()/http.get()/https.request()/http.request() call sites missing timeout protection.

Usage:
  node scripts/audit-fetch-timeouts.js                scan scripts/, report all findings (exit 0)
  node scripts/audit-fetch-timeouts.js --file=<path>   scan one file, exit 1 if it has any findings
  node scripts/audit-fetch-timeouts.js --json          machine-readable findings on stdout
  node scripts/audit-fetch-timeouts.js --help, -h       print this usage and exit
`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const SCRIPTS_DIR = path.join(__dirname);
const EXCLUDE_DIRS = new Set(['node_modules', '__pycache__', '.git']);
const EXEMPTION = 'hygiene-fetch-timeout-ok';
const SELF = path.basename(__filename);

const SCANNABLE_EXT_RE = /\.(js|mjs|ts)$/;
const TEST_FILE_RE = /\.(test|spec)\.(js|mjs|ts)$/;

function listScannableFiles(dir) {
  let out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue;
      out = out.concat(listScannableFiles(path.join(dir, entry.name)));
      continue;
    }
    if (!entry.isFile()) continue;
    if (!SCANNABLE_EXT_RE.test(entry.name)) continue;
    if (TEST_FILE_RE.test(entry.name)) continue;
    if (entry.name.endsWith('.d.ts')) continue;
    if (entry.name === SELF) continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

// Bare fetch( calls — excludes fetchPage(/fetchJSON(/etc. by requiring no
// preceding word char or dot immediately before "fetch(" (same shape as
// RISKY_CALL_RE in audit-help-flag-safety.js).
const FETCH_RE = /(?<![.\w])fetch\(/g;
const HTTP_GET_RE = /\bhttps?\.get\(/g;
// https.request()/http.request() — same underlying http.ClientRequest as
// https.get(), just used for non-GET methods (POST bodies especially, which
// https.get() can't send at all): options-object shape, destroy-handler
// shape, and the "timeout option alone doesn't protect anything without a
// destroy() call" gap are all identical, so this reuses checkGetOrRequestCall
// wholesale rather than a parallel implementation (BRO-3838 — this call was
// entirely outside the scanner's scope, which is how BRO-3832's unprotected
// https.request() POST to api.anthropic.com in
// scripts/batch-commercial-research.js hung a 60min job and was never
// caught). One difference from https.get(): the options object is
// conventionally the CALL's first (often only) argument rather than a second
// positional arg after a URL string — but every check below (inline
// `timeout:` text anywhere in the call's own args, identifier-based options
// lookup, destroy-handler search) is already position-agnostic, so no
// separate logic is needed for that shape difference.
const HTTP_REQUEST_RE = /\bhttps?\.request\(/g;

/** Index of the char matching src[openIdx] (openChar), by simple depth counting. Callers pass a blanked view (strings/comments space-filled) so stray brackets inside string content can't desync it. */
function findMatchingBracket(src, openIdx, openChar, closeChar) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (ch === openChar) depth++;
    else if (ch === closeChar) { depth--; if (depth === 0) return i; }
  }
  return null;
}

// Past a parameter list's closing paren, skips an optional TypeScript
// return-type annotation (`: Promise<X>`) plus surrounding whitespace,
// tracking <>/()/[] depth so a generic like `Promise<KimiScoringOutcome>`
// doesn't confuse the scan. Without this, kimi-scorer.ts's
// `async scoreReview(...): Promise<KimiScoringOutcome> {` (and any TS arrow
// with an explicit return type) never matched — the `{`/`=>` check that
// confirms a real function head landed on the return-type text, not the
// body opener, silently dropping the boundary (caught live: KimiScorer had
// only its constructor recognized, scoreReview()'s fetch() call fell back to
// file-wide scope).
function skipReturnTypeAnnotation(src, idx) {
  let k = idx;
  while (k < src.length && /\s/.test(src[k])) k++;
  if (src[k] !== ':') return k;
  k++;
  let depth = 0;
  for (; k < src.length; k++) {
    const ch = src[k];
    if (ch === '<' || ch === '(' || ch === '[') depth++;
    else if (ch === '>' || ch === ')' || ch === ']') depth--;
    else if (depth <= 0 && (ch === '{' || ch === ';' || ch === '=')) break;
  }
  return k;
}

// Function-boundary starts, used to scope each call site's search to "rest
// of its enclosing function" (BRO-108, second commit: a fixed character
// window either misses handlers in long functions or, widened enough to
// cover them, bleeds into an unrelated later call's handler and masks a
// real gap). Three shapes, all requiring paren-matching precision to avoid
// false boundaries:
//   1. function declarations / exports.foo|module.exports.foo|const-let-var
//      assignments to `function(...)` — unambiguous (literal keyword),
//      optionally preceded by `export `/`export default ` (TS files use
//      this — missed entirely before, collapsing scripts/llm-scoring/
//      batch-clients.ts's 7 exported functions into ONE scope with zero
//      boundaries, confirmed live by two independent adversarial reviews).
//   2. const/let/var assigned to an arrow function `(...) => {` — confirmed
//      via findMatchingBracket that `=>` actually follows the close-paren,
//      not just "next char after = is (": a naive version of this pattern
//      also matches ordinary parenthesized expressions like
//      `const n = (s.displayName || s.name || '').toLowerCase()`, which
//      cut searchTodayTixByTitle's scope 53 lines short of its real handler
//      (caught live). Paren-matching closes that hole.
//   3. class-method shorthand `[async ][static ]name(...) {` — kimi-scorer.ts's
//      KimiScorer.scoreReview() is exactly this shape, zero `function`
//      keyword in the whole file otherwise (also caught live). Excludes
//      control-flow keywords (if/for/while/switch/catch/function) so
//      `if (x) {` isn't mistaken for a method header.
const FUNC_KEYWORD_HEAD_RE = /^[ \t]*(?:export\s+(?:default\s+)?)?(?:(?:async\s+)?function\s+[\w$]+\s*\(|(?:module\.exports(?:\.[\w$]+)?|exports\.[\w$]+|(?:const|let|var)\s+[\w$]+)\s*=\s*(?:async\s*)?function\s*\()/gm;
const ARROW_HEAD_RE = /^[ \t]*(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?\(/gm;
const METHOD_SHORTHAND_HEAD_RE = /^[ \t]*(?:static\s+)?(?:async\s+)?(?:\*\s*)?(?!if\b|for\b|while\b|switch\b|catch\b|function\b|return\b)[\w$]+\s*\(/gm;

// Full [start, end) extent of each function found (start = head match index,
// end = index just past its own matching closing brace), computed via real
// brace-depth matching rather than "distance to the next head match". A
// prior point-boundary version treated ANY nested `const x = (...) => {...}`
// inside an outer function as ending the OUTER function's scope early — real
// gap found live: audit-show-score-url-redirects.js's fetchTitle() declares
// `const req = https.get(...)`, then LATER (after an unrelated nested
// `const finish = () => {...}` helper) attaches `req.on('error', ...)` +
// `req.setTimeout(...destroy())`. The point-boundary version cut
// enclosingFunctionScope off at `finish`'s head, before ever reaching the
// real destroy handler — a false positive on already-correct code. Brace
// matching is immune: nesting depth, not head-match order, decides the
// extent, so a helper declared anywhere inside the outer function can never
// truncate it.
function functionExtents(source) {
  const extents = [];

  // headBodyStart: index of the block body's opening `{` for a
  // function-keyword or method-shorthand head (directly after the
  // params/return-type, no `=>` in between).
  function addExtentDirectBrace(headStart, openParenIdx) {
    const closeParenIdx = findMatchingBracket(source, openParenIdx, '(', ')');
    if (closeParenIdx == null) return;
    const k = skipReturnTypeAnnotation(source, closeParenIdx + 1); // handles `async scoreReview(...): Promise<X> {`
    if (source[k] !== '{') return;
    const closeBraceIdx = findMatchingBracket(source, k, '{', '}');
    if (closeBraceIdx == null) return;
    extents.push({ start: headStart, end: closeBraceIdx + 1 });
  }

  // Arrow heads: params/return-type are followed by `=>` THEN the block body
  // (or an expression body, which has no brace to bound and isn't tracked).
  function addExtentArrow(headStart, openParenIdx) {
    const closeParenIdx = findMatchingBracket(source, openParenIdx, '(', ')');
    if (closeParenIdx == null) return;
    const afterParams = skipReturnTypeAnnotation(source, closeParenIdx + 1); // handles `(x: string): Promise<void> => {`
    if (source.slice(afterParams, afterParams + 2) !== '=>') return;
    let k = afterParams + 2;
    while (k < source.length && /\s/.test(source[k])) k++;
    if (source[k] !== '{') return; // expression-bodied arrow — no block to bound
    const closeBraceIdx = findMatchingBracket(source, k, '{', '}');
    if (closeBraceIdx == null) return;
    extents.push({ start: headStart, end: closeBraceIdx + 1 });
  }

  for (const m of source.matchAll(new RegExp(FUNC_KEYWORD_HEAD_RE.source, 'gm'))) {
    addExtentDirectBrace(m.index, m.index + m[0].length - 1);
  }

  for (const m of source.matchAll(new RegExp(ARROW_HEAD_RE.source, 'gm'))) {
    addExtentArrow(m.index, m.index + m[0].length - 1);
  }

  for (const m of source.matchAll(new RegExp(METHOD_SHORTHAND_HEAD_RE.source, 'gm'))) {
    addExtentDirectBrace(m.index, m.index + m[0].length - 1);
  }

  return extents.sort((a, b) => a.start - b.start);
}

// Whole enclosing function, not just "from the call forward" — a timeout
// setup can legitimately be declared BEFORE the call it protects (the
// AbortController + setTimeout(() => controller.abort(), N) pattern always
// is: controller/timer are created, then passed into fetch(...)), so
// scanning only forward from the call site missed every one of the 15 files
// using that shape (backfill-pv-critics.js: false positive, caught live).
//
// Picks the INNERMOST extent (smallest span) that actually contains index —
// extents nest (a named function containing a helper arrow further down is
// two extents, one inside the other), and the innermost one containing the
// call is always the function that lexically owns it. Falls back to "index
// to end of source" only when no extent contains it at all (e.g. top-level
// module code with no enclosing function head matched).
function enclosingFunctionScope(source, extents, index) {
  let best = null;
  for (const e of extents) {
    if (e.start <= index && index < e.end) {
      if (!best || (e.end - e.start) < (best.end - best.start)) best = e;
    }
  }
  return best ? source.slice(best.start, best.end) : source.slice(index);
}

function isCommentLine(source, index) {
  const lineStart = source.lastIndexOf('\n', index) + 1;
  return source.slice(lineStart, index).trimStart().startsWith('//');
}

function lineOf(source, index) {
  return source.slice(0, index).split('\n').length;
}

/**
 * Two views of the same source, both via acorn's tokenizer, both preserving
 * offsets/newlines (space-fill only) so line numbers and cross-view indices
 * stay valid:
 *
 *   stripComments(src)          — blanks comments only, string/template
 *                                  CONTENT stays intact.
 *   blankStringsAndComments(src) — blanks comments AND string/template
 *                                  content.
 *
 * Two different scans need two different views, exactly the cleanSrc/
 * riskySrc split in audit-help-flag-safety.js (reimplemented standalone here
 * rather than require()'d — that module runs a --help gate as a MODULE-LOAD
 * side effect, which would hijack this script's own --help handling):
 *
 *   Call-site matching (does "fetch(" / "https.get(" text here refer to a
 *   real call?) needs the FULLY blanked view — prose that happens to contain
 *   the literal text "fetch(" reads as a real call otherwise. Reproduced
 *   live: backlog-drain.js has a template string
 *   `` `, ${n} card fetch(es) FAILED...` `` that matched FETCH_RE verbatim.
 *
 *   Protection-pattern matching (does the enclosing function contain
 *   `.on('timeout', ...)`, etc?) needs strings INTACT — the 'timeout' event
 *   name IS a string literal, and blanking it made a real, working
 *   `req.on('timeout', () => { req.destroy(); ... })` handler in
 *   discover-new-shows.js invisible to its own regex, a false positive
 *   caught immediately by re-running this script against a file it had
 *   already verified clean. Comments still get blanked here too, for the
 *   same reason as the call-site view: a comment merely NAMING a protection
 *   pattern ("remember to add AbortSignal.timeout here") must not satisfy
 *   the check for a genuinely unprotected call.
 *
 * FAILS OPEN: acorn unavailable, or the file doesn't parse (e.g. most .ts
 * files — acorn has no native TS support) → returns source UNCHANGED. The
 * per-match isCommentLine() check below still catches the common `//` case
 * in that fallback; string-literal false positives are accepted as a known
 * gap for unparseable files, consistent with this repo's "heuristic, false
 * positives/negatives expected" stance for audit-*.js tools.
 */
function tokenizeAcorn(src, onToken) {
  let acorn;
  try { acorn = require('acorn'); } catch { return false; }
  try {
    const tokenizer = acorn.tokenizer(src, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
      allowSuperOutsideMethod: true,
      onComment: (block, text, start, end) => onToken({ type: { label: 'comment' }, start, end }),
    });
    for (const tok of tokenizer) onToken(tok);
  } catch {
    return false; // unparseable — caller falls back to raw source
  }
  return true;
}

function blanker(src) {
  const out = src.split('');
  return {
    blank(from, to) {
      for (let k = from; k < to && k < out.length; k++) {
        if (out[k] !== '\n') out[k] = ' ';
      }
    },
    result: () => out.join(''),
  };
}

function stripComments(src) {
  const b = blanker(src);
  const ok = tokenizeAcorn(src, (tok) => {
    if (tok.type.label === 'comment') b.blank(tok.start, tok.end);
  });
  return ok ? b.result() : src;
}

function blankStringsAndComments(src) {
  const b = blanker(src);
  const ok = tokenizeAcorn(src, (tok) => {
    const label = tok.type.label;
    if (label === 'comment') b.blank(tok.start, tok.end);
    else if (label === 'string' || label === 'regexp') b.blank(tok.start + 1, tok.end - 1); // keep delimiters
    else if (label === 'template' || label === 'invalidTemplate') b.blank(tok.start, tok.end); // ${...} substitutions are separate tokens, untouched
  });
  return ok ? b.result() : src;
}

/**
 * Scans one file's source for unprotected fetch()/https.get()/http.get()/
 * https.request()/http.request() call sites. Returns an array of findings
 * (empty if none / file exempted).
 */
// True when the file declares its own `function fetch(...)`, shadowing the
// global. 6 files do this (fetch-bww-roundups.js, fetch-from-wayback.js,
// scripts/lib/author-pages/{muckrack,bww,nysr,nysun}.js) — each wraps
// https.get() in a hand-rolled retry/redirect helper named `fetch` for
// readability at call sites. Every `fetch(` in such a file, including the
// declaration itself, refers to that local wrapper, never the global
// AbortSignal-based fetch() API — flagging them as "missing
// AbortSignal.timeout" is not just a false positive, it's inapplicable
// advice (the fix moves to the file's own https.get() call, already
// separately scanned by HTTP_GET_RE).
const LOCAL_FETCH_SHADOW_RE = /(?:^|\n)[ \t]*(?:async\s+)?function\s+fetch\s*\(/;

// Span of a call's own argument list, e.g. `fetch(` at callOpenParenIdx-1 →
// returns [callOpenParenIdx, matching close paren]. Used to check patterns
// that must be part of THIS call's own arguments (the { timeout: N } option,
// an inline AbortSignal.timeout(...)) — narrower and safer than the whole
// enclosing-function scope, which two independent adversarial reviews (Claude
// + Codex, task #1862) both confirmed lets ONE call's protection silently
// mask a DIFFERENT, genuinely unprotected call in the same function.
function callArgSpan(source, callOpenParenIdx) {
  const close = findMatchingBracket(source, callOpenParenIdx, '(', ')');
  return { start: callOpenParenIdx, end: close === null ? source.length : close + 1 };
}

// Splits a call's argument list into top-level (depth-0) argument spans —
// depth counting (on the blanked-strings view, so a stray bracket inside a
// string can't desync it) ensures a comma nested inside an inline options
// object or callback body never splits an argument in two. Real false
// positive found live (Codex adversarial review, BRO-2383): scanning
// ownArgsText for ANY identifier occurring ANYWHERE in the call's arguments —
// including deep inside a callback function BODY — let an unrelated
// same-named variable satisfy the options-by-reference check, e.g.
// `const metadata = { timeout: 15000 }; https.get(url, {}, res =>
// console.log(metadata))` read as protected because `metadata` merely
// APPEARS in the call text, despite never being the options argument at all.
// Restricting the identifier check to args whose ENTIRE top-level span is a
// bare identifier (see checkSource below) closes that gap.
function splitTopLevelArgs(source, openParenIdx, closeParenIdx) {
  const args = [];
  let depth = 0;
  let start = openParenIdx + 1;
  for (let i = openParenIdx + 1; i < closeParenIdx; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') depth--;
    else if (ch === ',' && depth === 0) {
      args.push({ start, end: i });
      start = i + 1;
    }
  }
  if (start < closeParenIdx) args.push({ start, end: closeParenIdx });
  return args;
}

// Extends a call's own argument span through any immediately-chained
// `.identifier(...)` segments — `https.get(url, cb).on('error', x).on('timeout', y)`
// is one statement/expression, and BRO-108's own real code (fetch-bww-roundups.js,
// audit-we-reviews.js, etc.) always chains protection handlers directly onto
// a request with no intermediate variable. Scoping to just this chain (rather
// than the whole enclosing function) is exact for this shape — no risk of
// borrowing an unrelated call's handler.
function chainedCallSpanEnd(source, callOpenParenIdx) {
  let end = callArgSpan(source, callOpenParenIdx).end;
  for (;;) {
    let k = end;
    while (k < source.length && /\s/.test(source[k])) k++;
    if (source[k] !== '.') break;
    k++;
    while (k < source.length && /[\w$]/.test(source[k])) k++;
    while (k < source.length && /\s/.test(source[k])) k++;
    if (source[k] !== '(') break;
    const close = findMatchingBracket(source, k, '(', ')');
    if (close === null) break;
    end = close + 1;
  }
  return end;
}

// If a call at matchIndex is the RHS of `const/let/var NAME = <call>`,
// returns NAME; otherwise null. Ties https.get()'s protection search to the
// SPECIFIC request object (`req.on('timeout', ...)` must reference the same
// `req` this call created), instead of "any .on('timeout',...destroy() text
// anywhere in the function" — the fix for the same cross-call-contamination
// risk described on callArgSpan above, for the assigned-to-a-variable shape.
function assignedVarName(source, matchIndex) {
  const before = source.slice(Math.max(0, matchIndex - 200), matchIndex); // bounded tail — assignment is always immediately before the call
  const m = /(?:const|let|var)\s+([\w$]+)\s*=\s*(?:await\s+)?$/.exec(before);
  return m ? m[1] : null;
}

// Real gap found live: discover-dtli-slugs.js and fetch-images.js both pass a
// pre-built options object by reference — `const options = { timeout: N,
// ... }; https.get(url, options, cb)` — instead of inlining `{ timeout: N }`
// in the call. The call's own argument text then contains only the bare
// identifier `options`, no literal "timeout:", so the inline check alone
// treated fully-protected code as a gap. Ties the lookup to the SPECIFIC
// identifier passed at this call site (same cross-call-contamination
// discipline as every other check here): finds `ident`'s own `{...}`
// declaration in the enclosing scope via brace matching, and only that
// object's own contents count.
function identifierOptionsHasTimeout(scope, ident) {
  const identRe = ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declMatch = new RegExp(`\\b(?:const|let|var)\\s+${identRe}\\s*=\\s*\\{`).exec(scope);
  if (!declMatch) return false;
  const openBraceIdx = declMatch.index + declMatch[0].length - 1;
  const closeBraceIdx = findMatchingBracket(scope, openBraceIdx, '{', '}');
  if (closeBraceIdx == null) return false;
  return /\btimeout\s*:\s*[\w.]+/.test(scope.slice(openBraceIdx, closeBraceIdx + 1));
}

function checkSource(file, source) {
  if (source.includes(EXEMPTION)) return []; // checked on RAW source — a blanked comment can't hide the exemption from itself

  // Two views, same offsets — see the doc comment on blankStringsAndComments
  // for why call-site matching and protection-pattern matching need
  // different ones (strings blanked vs. strings intact).
  const scanSrc = blankStringsAndComments(source); // for finding call sites
  const scopeSrc = stripComments(source); // for reading protection patterns out of the enclosing function
  const extents = functionExtents(scanSrc);
  const findings = [];
  const shadowsFetch = LOCAL_FETCH_SHADOW_RE.test(scanSrc);

  for (const match of (shadowsFetch ? [] : scanSrc.matchAll(FETCH_RE))) {
    if (isCommentLine(scanSrc, match.index)) continue;
    const openParenIdx = match.index + match[0].length - 1; // bracket-matching runs on scanSrc — strings are blanked there, so a User-Agent string containing literal "(" can't desync the depth count
    const ownArgs = callArgSpan(scanSrc, openParenIdx);
    const ownArgsText = scopeSrc.slice(ownArgs.start, ownArgs.end); // strings intact — a signal variable name is real code, not string content, but kept consistent with the rest of the scan

    // Inline AbortSignal.timeout(...) — tied to THIS call's own arguments,
    // not "anywhere in the function", so it can never borrow a sibling
    // call's protection (the false-negative both Claude and Codex adversarial
    // review independently confirmed for functions with 2+ fetch() calls).
    const hasInlineAbortSignal = /AbortSignal\.timeout\(\s*[\w.]+/.test(ownArgsText);

    let protectedCall = hasInlineAbortSignal;
    if (!protectedCall) {
      // signal: someVar / signal: controller.signal — captures the base
      // identifier only, then requires ANY protection for THAT SPECIFIC name
      // in the enclosing function: either it's itself assigned
      // AbortSignal.timeout(...), or it's an AbortController whose signal is
      // aborted from a setTimeout(...) referencing the SAME name. Ties the
      // check to one variable so a DIFFERENT fetch()'s controller in the same
      // function can't satisfy this one.
      const sigMatch = /signal\s*:\s*([\w$]+)/.exec(ownArgsText);
      if (sigMatch) {
        const ident = sigMatch[1];
        const scope = enclosingFunctionScope(scopeSrc, extents, match.index);
        const identRe = ident.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const isSignalItself = new RegExp(`\\b${identRe}\\b\\s*=\\s*AbortSignal\\.timeout\\(`).test(scope);
        const isControllerTied = new RegExp(`\\b${identRe}\\b\\s*=\\s*new\\s+AbortController\\(\\)`).test(scope)
          && new RegExp(`setTimeout\\([\\s\\S]*?\\b${identRe}\\b\\.abort\\(`).test(scope);
        protectedCall = isSignalItself || isControllerTied;
      }
    }

    if (!protectedCall) {
      findings.push({
        file,
        line: lineOf(scanSrc, match.index),
        call: 'fetch()',
        detail: 'no AbortSignal.timeout(...) signal or AbortController+setTimeout(...abort()) pattern tied to this call\'s signal found',
      });
    }
  }

  for (const match of scanSrc.matchAll(HTTP_GET_RE)) {
    checkGetOrRequestCall(file, scanSrc, scopeSrc, extents, match, 'https.get()/http.get()', findings);
  }

  for (const match of scanSrc.matchAll(HTTP_REQUEST_RE)) {
    checkGetOrRequestCall(file, scanSrc, scopeSrc, extents, match, 'https.request()/http.request()', findings);
  }

  return findings;
}

// Shared by the HTTP_GET_RE and HTTP_REQUEST_RE scans below (BRO-3838) — both
// are the same underlying http.ClientRequest shape (options object + a
// `{ timeout: N }` that does nothing without a paired destroy handler), so
// the options-lookup and destroy-handler-search logic is identical; only the
// finding's `call` label differs. Mutates `findings` in place, matching the
// call-site loop style above.
function checkGetOrRequestCall(file, scanSrc, scopeSrc, extents, match, callLabel, findings) {
  if (isCommentLine(scanSrc, match.index)) return;
  const openParenIdx = match.index + match[0].length - 1;
  const ownArgs = callArgSpan(scanSrc, openParenIdx);
  const ownArgsText = scopeSrc.slice(ownArgs.start, ownArgs.end);

  // { timeout: N } is usually part of THIS call's own options object —
  // tying it to the call's own arguments (not the whole enclosing
  // function) costs nothing and closes off any chance of a sibling call's
  // option satisfying this one. When the options are passed as a bare
  // identifier instead (`const options = {...}; https.get(url, options, cb)`,
  // or, for https.request(), `const options = {...}; https.request(options, cb)`),
  // fall back to resolving that specific identifier's own declaration. This
  // check is already position-agnostic (it doesn't care whether the options
  // object is the 1st or 2nd argument), so https.request()'s conventional
  // "options is the only/first argument" shape needs no separate handling.
  let hasTimeoutOption = /timeout\s*:\s*[\w.]+/.test(ownArgsText);
  if (!hasTimeoutOption) {
    const scope = enclosingFunctionScope(scopeSrc, extents, match.index);
    // Only a top-level argument whose ENTIRE span is a bare identifier
    // counts — never an identifier merely mentioned inside a callback body
    // (see splitTopLevelArgs doc comment for the false positive this fixes).
    const argSpans = splitTopLevelArgs(scanSrc, openParenIdx, ownArgs.end - 1);
    hasTimeoutOption = argSpans.some((span) => {
      const identMatch = /^([A-Za-z_$][\w$]*)$/.exec(scanSrc.slice(span.start, span.end).trim());
      return identMatch && identifierOptionsHasTimeout(scope, identMatch[1]);
    });
  }

  // Destroy-handler search is tied to the SPECIFIC request object: if the
  // call is assigned to a variable (`const req = https.get(...)`), the
  // handler must reference that same variable name, searched across the
  // whole enclosing function (a real handler can legitimately sit many
  // lines after the call — discover-new-shows.js's searchTodayTixByTitle
  // has one 53 lines down). If NOT assigned (chained directly onto the
  // call, e.g. `https.get(url, cb).on('error', x).on('timeout', y)`), the
  // handler is always part of the SAME statement in every real instance
  // here, so the search narrows to just that chained expression — either
  // way, a DIFFERENT call's handler can no longer satisfy this one.
  const varName = assignedVarName(scanSrc, match.index);
  let destroySearchText;
  let destroyRe, setTimeoutRe;
  if (varName) {
    destroySearchText = enclosingFunctionScope(scopeSrc, extents, match.index);
    const identRe = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    destroyRe = new RegExp(`\\b${identRe}\\b\\.on\\(\\s*['"]timeout['"]\\s*,[\\s\\S]*?\\.destroy\\(`);
    setTimeoutRe = new RegExp(`\\b${identRe}\\b\\.setTimeout\\(\\s*[\\w.]+[\\s\\S]*?\\.destroy\\(`);
  } else {
    const chainEnd = chainedCallSpanEnd(scanSrc, openParenIdx);
    destroySearchText = scopeSrc.slice(match.index, chainEnd);
    destroyRe = /\.on\(\s*['"]timeout['"]\s*,[\s\S]*?\.destroy\(/;
    setTimeoutRe = /\.setTimeout\(\s*[\w.]+[\s\S]*?\.destroy\(/;
  }
  const hasOnTimeoutDestroy = destroyRe.test(destroySearchText);
  const hasSetTimeoutDestroy = setTimeoutRe.test(destroySearchText);

  const protectedCall = hasSetTimeoutDestroy || (hasTimeoutOption && hasOnTimeoutDestroy);
  if (protectedCall) return;

  let detail;
  if (!hasTimeoutOption && !hasSetTimeoutDestroy) {
    detail = 'no { timeout: N } option or req.setTimeout(N, ...) found for this call';
  } else {
    detail = 'timeout option set but no .on(\'timeout\', ...) handler calling .destroy() found for this specific request — the socket will hang forever on fire';
  }
  findings.push({ file, line: lineOf(scanSrc, match.index), call: callLabel, detail });
}

function checkFile(absPath) {
  const source = fs.readFileSync(absPath, 'utf8');
  const relPath = path.relative(path.join(SCRIPTS_DIR, '..'), absPath);
  return checkSource(relPath, source);
}

function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const fileArg = args.find((a) => a.startsWith('--file='));

  if (fileArg) {
    const target = fileArg.slice('--file='.length);
    const absPath = path.isAbsolute(target) ? target : path.join(process.cwd(), target);
    if (!fs.existsSync(absPath)) {
      console.error(`No such file: ${target}`);
      process.exitCode = 1;
      return;
    }
    const findings = checkFile(absPath);
    if (jsonOut) {
      console.log(JSON.stringify(findings, null, 2));
    } else if (findings.length === 0) {
      console.log(`✅ ${target}: no unprotected fetch()/https.get()/http.get()/https.request()/http.request() call sites.`);
    } else {
      console.log(`🚨 ${target}: ${findings.length} unprotected call site(s):\n`);
      for (const f of findings) console.log(`  ${f.file}:${f.line} [${f.call}] ${f.detail}`);
    }
    process.exitCode = findings.length > 0 ? 1 : 0;
    return;
  }

  const files = listScannableFiles(SCRIPTS_DIR);
  const findings = files.flatMap((f) => checkFile(f));

  if (jsonOut) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  if (findings.length === 0) {
    console.log(`✅ Fetch-timeout audit: no unprotected call sites (${files.length} files scanned).`);
    return;
  }

  console.log(`ℹ️  Fetch-timeout audit: ${findings.length} unprotected call site(s) across ${byFile.size} file(s) (${files.length} files scanned).`);
  console.log(`   Non-blocking — this is a repo-wide audit surfacing pre-existing debt (#1862), not yet gated in CI.\n`);
  for (const [file, fFindings] of [...byFile.entries()].sort()) {
    for (const f of fFindings) console.log(`  ${file}:${f.line} [${f.call}] ${f.detail}`);
  }
  console.log(`\nFix: add AbortSignal.timeout(N) to fetch() calls, or { timeout: N } + a .on('timeout', ...) handler`);
  console.log(`that calls .destroy() (or req.setTimeout(N, cb) with cb calling .destroy()) to https.get()/http.get()/https.request()/http.request() calls.`);
  console.log(`See scripts/discover-new-shows.js for the established pattern (BRO-108, PR 629).`);
  console.log(`False positive? Add  // ${EXEMPTION}: <reason>  anywhere in the file.`);
  // Non-blocking by design (suggested approach step 2 of #1862): 100+ files
  // can't all be fixed in one session. Use --file=<path> to gate an
  // individual already-clean file against regression in CI.
}

if (require.main === module) main();

module.exports = {
  checkSource,
  checkFile,
  functionExtents,
  enclosingFunctionScope,
  listScannableFiles,
  FETCH_RE,
  HTTP_GET_RE,
  HTTP_REQUEST_RE,
};
