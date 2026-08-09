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
 *
 * KNOWN LIMIT — argv assembled at runtime. `execFileSync('node', [...args,
 * 'generate.mjs'])` and `argv.concat(x)` are invisible to any text scanner,
 * so a spawn written that way is NOT checked. A fail-closed net for it was
 * tried and removed: keyed on the assembly markers it false-positived on
 * create-broadcast-draft.mjs (which spreads argv and separately names the
 * generator in an error string), and a guard that cries wolf on correct code
 * gets ignored, which costs more than the shape it would catch — nothing in
 * this repo builds a generator argv dynamically. Keep the generator path a
 * literal in the argv array and this guard can see it.
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
 * Blank out comments, preserving offsets and line count so reported line
 * numbers stay accurate.
 *
 * Two reasons this is load-bearing, not cosmetic:
 *  - An apostrophe in a comment inside a call's arguments ("// don't forget")
 *    reads as an unterminated string to the bracket matcher, which then finds
 *    no closing paren and SKIPS the call — a guard that silently passes the
 *    exact code it exists to catch.
 *  - A comment mentioning NEWSLETTER_EDITION next to an unpinned spawn would
 *    otherwise satisfy the pin check.
 */
function stripComments(src) {
  let out = '';
  let quote = null;
  let quoteStart = 0;
  let prevMeaningful = '';
  const stringSpans = [];
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next === undefined ? '' : next; i++; continue; }
      // `${...}` inside a template literal is CODE, not string content — a
      // spawn nested in an interpolation is a real call site. Close the string
      // span before it and reopen after, so the span list doesn't swallow it.
      if (quote === '`' && ch === '$' && next === '{') {
        const close = matchBracket(src, i + 1);
        if (close !== -1) {
          stringSpans.push([quoteStart, i]);
          const inner = src.slice(i + 1, close + 1);
          // Lex the interpolation as code in its own right, so string literals
          // NESTED inside it are still recorded as strings. Without this, a
          // quoted spawn-call snippet inside an interpolation reads as live
          // code and reddens CI (Codex round 4, 2026-08-09).
          const innerLexed = stripComments(inner);
          out += innerLexed.code;
          for (const [s, e] of innerLexed.stringSpans) stringSpans.push([s + i + 1, e + i + 1]);
          i = close;
          quoteStart = i;          // remainder of the template is string again
          continue;
        }
      }
      if (ch === quote) { stringSpans.push([quoteStart, i]); quote = null; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; quoteStart = i; out += ch; prevMeaningful = ch; continue; }
    // `//` and `/*` are unambiguously comments — no regex literal can begin
    // with a second slash or a star — so these are checked before the regex
    // branch and never consult the regex heuristic.
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      out += '\n';
      prevMeaningful = '';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
      i--;
      continue;
    }
    // Regex literal: copy it through verbatim so its contents (which routinely
    // include //, quotes and brackets — /[//]/, /['"]/) are never mistaken for
    // a comment or a string. Getting this wrong is the DANGEROUS direction:
    // a mis-lexed regex blanks the rest of the line, hiding any unpinned spawn
    // that follows it (Codex adversarial finding, verified 2026-08-09).
    if (ch === '/' && regexCanStartAfter(prevMeaningful, wordBefore(src, i))) {
      const end = scanRegexLiteral(src, i);
      if (end !== -1) {
        out += src.slice(i, end + 1);
        i = end;
        prevMeaningful = '/';
        continue;
      }
    }
    out += ch;
    if (!/\s/.test(ch)) prevMeaningful = ch;
  }
  // Offsets are preserved (comments are blanked, never removed), so the spans
  // index into `out` as well as `src`. Sharing this single regex-aware pass is
  // what keeps the span list from mistaking a quote INSIDE a regex character
  // class (/['"]/) for the start of a string and swallowing the code after it.
  return { code: out, stringSpans };
}

/**
 * Can a `/` at this position start a regex literal rather than division?
 * Standard heuristic: regex may follow an operator/punctuator or nothing,
 * never an operand (identifier char, closing bracket, quote).
 */
function regexCanStartAfter(prevMeaningful, prevWord) {
  // `return /re/`, `typeof /re/`, `case /re/` … a keyword is an operator
  // position, not an operand. Missing these lexed `return /[.!?]/` as division,
  // which opened a phantom string that blanked 200+ lines of a swept file from
  // the guard — coverage lost silently, the exact vacuous-pass this file exists
  // to avoid (code-review HIGH, 2026-08-09).
  if (prevWord && REGEX_PRECEDING_KEYWORDS.has(prevWord)) return true;
  if (!prevMeaningful) return true;
  return '(,=:[!&|?{};+-*%<>~^'.includes(prevMeaningful);
}

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/** The identifier/keyword immediately before position `i`, or '' if none. */
function wordBefore(src, i) {
  let end = i;
  while (end > 0 && /\s/.test(src[end - 1])) end--;
  let start = end;
  while (start > 0 && /[A-Za-z_$]/.test(src[start - 1])) start--;
  // A PROPERTY named like a keyword is an operand, so what follows is division,
  // not a regex: `obj.return / x`. Misreading it started a phantom regex that
  // ran to the next slash and then opened a phantom string, swallowing the rest
  // of the template — a missed spawn (Codex round 5, 2026-08-09).
  if (start > 0 && src[start - 1] === '.') return '';
  return src.slice(start, end);
}

/** End index of the regex literal starting at `start`, or -1 if unterminated. */
function scanRegexLiteral(src, start) {
  let inClass = false;
  for (let i = start + 1; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '\n') return -1;            // regex literals can't span lines
    if (ch === '[') inClass = true;
    else if (ch === ']') inClass = false;
    else if (ch === '/' && !inClass) {
      let j = i + 1;                        // consume flags
      while (j < src.length && /[a-z]/i.test(src[j])) j++;
      return j - 1;
    }
  }
  return -1;
}

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
  let prevMeaningful = '';
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      // Consume the escaped char outright — `prev !== '\\'` mis-reads an even
      // run of backslashes (cwd: "\\\\") as escaping the closing quote, which
      // desynchronises the scan and makes the whole call get skipped.
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; prevMeaningful = ch; continue; }
    // Comments and regex literals must be skipped here too, not just in
    // stripComments: this runs on RAW source when delimiting a `${...}`, and a
    // template holding `.replace(/"/g, '\\"')` otherwise leaves a dangling
    // quote that ran the span 80+ lines past the interpolation and hid every
    // spawn inside it (code-review HIGH, 2026-08-09).
    if (ch === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i++; prevMeaningful = ''; continue; }
    if (ch === '/' && next === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 1; continue; }
    if (ch === '/' && regexCanStartAfter(prevMeaningful, wordBefore(src, i))) {
      const e = scanRegexLiteral(src, i);
      if (e !== -1) { i = e; prevMeaningful = '/'; continue; }
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    if (!/\s/.test(ch)) prevMeaningful = ch;
  }
  return -1;
}

/** Every string/template-literal body in a snippet, without its quotes. */
function stringLiteralsIn(src) {
  const out = [];
  let quote = null;
  let buf = '';
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') { buf += src[i + 1] || ''; i++; continue; }
      if (ch === quote) { out.push(buf); buf = ''; quote = null; continue; }
      buf += ch;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
  }
  return out;
}

/** Text up to the first comma that isn't inside brackets or a string. */
function topLevelFirstElement(body) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) return body.slice(0, i);
  }
  return body;
}

/**
 * Does this call actually run the generator?
 *
 * True for the two real shapes:
 *   argv array  — execFileSync('node', [path.join(dir, 'generate.mjs'), week])
 *                 including `const gen = path.join(dir, 'generate.mjs')` and
 *                 then `[gen, week]`, resolved through the identifier
 *   shell string — execSync(`node scripts/newsletter/generate.mjs ${week}`)
 *
 * False when the basename is merely DATA rather than the program — e.g.
 * `execFileSync('node', ['scripts/tool.mjs', 'generate.mjs'])`, where tool.mjs
 * is what runs. Hence "first argv element only" for the array form.
 */
function runsGenerator(sourceText, callText) {
  const gen = GENERATOR_BASENAME.replace('.', '\\.');
  const namesGenerator = (s) => new RegExp(`(^|[/\\s])${gen}(\\s|$)`).test(s);

  // Shell-string form: the command string names it anywhere.
  const argsInner = callText.slice(1, -1);
  const arrStart = argsInner.indexOf('[');
  if (arrStart === -1) return stringLiteralsIn(argsInner).some(namesGenerator);

  // Array form: only the FIRST element is the program being run. Split on the
  // first TOP-LEVEL comma — `path.join(__dirname, 'generate.mjs')` is one
  // element, and a naive split on ',' would cut it in half.
  const arrEnd = matchBracket(argsInner, arrStart);
  const arrBody = argsInner.slice(arrStart + 1, arrEnd === -1 ? undefined : arrEnd);
  const firstElem = topLevelFirstElement(arrBody);
  if (stringLiteralsIn(firstElem).some(namesGenerator)) return true;

  // First element is a bare identifier — resolve its initializer in the file.
  const bare = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(firstElem);
  if (bare) {
    const declRe = new RegExp(`\\b${bare[1]}\\s*=\\s*([^;\\n]+)`);
    const decl = declRe.exec(sourceText);
    if (decl && stringLiteralsIn(decl[1]).some(namesGenerator)) return true;
  }
  // Anything before the array (e.g. execSync's command string) still counts.
  return stringLiteralsIn(argsInner.slice(0, arrStart)).some(namesGenerator);
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

  // Identifiers worth resolving: `env: someEnv` and `env: { ...someEnv, ... }`.
  // process.env is deliberately not one — spreading it pins nothing.
  const idents = [];
  const byName = /\benv\s*:\s*([A-Za-z_$][\w$]*)\s*[,})]/.exec(callText);
  if (byName && byName[1] !== 'process') idents.push(byName[1]);
  const envObj = /\benv\s*:\s*\{/.exec(callText);
  if (envObj) {
    const braceIdx = callText.indexOf('{', envObj.index);
    const end = matchBracket(callText, braceIdx);
    const body = end === -1 ? callText.slice(braceIdx) : callText.slice(braceIdx, end + 1);
    for (const m of body.matchAll(/\.\.\.\s*([A-Za-z_$][\w$]*)\b/g)) {
      if (m[1] !== 'process') idents.push(m[1]);
    }
  }
  if (!idents.length) return false;

  return idents.some((ident) => {
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
  });
}

/**
 * Scan one source file for spawns of generate.mjs that don't pin the edition.
 *
 * @param {string} sourceText  file contents
 * @param {string} filename    for the reported message only
 * @returns {Array<{line: number, fn: string, reason: string}>} one entry per violation
 */
function findUnpinnedGenerateSpawns(rawSource, filename = '<source>') {
  const violations = [];
  if (typeof rawSource !== 'string' || !rawSource) return violations;
  const { code: sourceText, stringSpans: spans } = stripComments(rawSource);

  for (const fn of SPAWN_FNS) {
    // Word-boundary so `execFile` doesn't also match inside `execFileSync`.
    const callRe = new RegExp(`\\b${fn}\\s*\\(`, 'g');
    let m;
    while ((m = callRe.exec(sourceText)) !== null) {
      // A spawn call that only APPEARS inside a string — a doc snippet, a
      // fixture, a generated-code sample — is text, not a call site. Flagging
      // it would redden CI on code that spawns nothing.
      if (spans.some(([s, e]) => m.index > s && m.index < e)) continue;
      const openIdx = m.index + m[0].length - 1;
      const closeIdx = matchBracket(sourceText, openIdx);
      if (closeIdx === -1) continue;
      const callText = sourceText.slice(openIdx, closeIdx + 1);

      if (!runsGenerator(sourceText, callText)) continue;

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
