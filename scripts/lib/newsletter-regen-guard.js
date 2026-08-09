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
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') { out += next === undefined ? '' : next; i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; out += ch; continue; }
    if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') { out += ' '; i++; }
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) out += src[i] === '\n' ? '\n' : ' ';
      i--;
      continue;
    }
    out += ch;
  }
  return out;
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
  const sourceText = stripComments(rawSource);

  for (const fn of SPAWN_FNS) {
    // Word-boundary so `execFile` doesn't also match inside `execFileSync`.
    const callRe = new RegExp(`\\b${fn}\\s*\\(`, 'g');
    let m;
    while ((m = callRe.exec(sourceText)) !== null) {
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
