'use strict';
// BRO-7849: is a .tsx/.jsx edit provably NON-RENDERING? Used by .claude/hooks/pre-push-visual-gate.sh, right after the
// text-only exemption (visual-text-only-diff.js, BRO-5844), to skip the owner-approval gate for edits that cannot change
// a pixel (an analytics filter inside useEffect, a type widening, an import of a .ts helper). Fail closed: any doubt,
// parse error, missing side or missing typescript package keeps the file gated.
//
// A file is exempt only if ALL hold:
//   1. both sides parse cleanly as TSX;
//   2. the outermost JSX nodes are identical before and after (whitespace-collapsed);
//   3. after erasing types (annotations, interfaces, type aliases, type-only imports, `declare` blocks) every remaining
//      changed line is either (a) an ADDED line of an import of a .ts/.js module or bare package (never .tsx/.css/side-effect
//      imports; a removed, re-aliased or re-pointed import keeps the file gated, and every newly imported name may be
//      used only inside an allowed guard), or (b) inside a guard that sits in the FIRST argument of useEffect or
//      useLayoutEffect: `if (<pure condition>) return [null|undefined|false];` (no else) or an array of only
//      string/regex literals (ignoreErrors/denyUrls style lists). Anything else in an effect body stays gated: an AST
//      allowlist, not a blacklist, because aliases and calls (`const s = setX; s(1)`) defeat a per-line regex;
//   4. no changed line matches a DOM/state/class pattern (belt and braces on top of 3);
//   5. the 'use client' / 'use server' directive is untouched.
// CSS / Tailwind / PostCSS and new, deleted or renamed files are never exempt.

const path = require('path');

let _ts = null;
function loadTs() {
  if (_ts) return _ts;
  // Only the detector's own checkout: a pushed branch must not supply the parser.
  try { _ts = require(require.resolve('typescript', { paths: [__dirname] })); return _ts; } catch { return null; }
}

// useInsertionEffect injects styles, so it is never exempt.
const EFFECT_HOOKS = new Set(['useEffect', 'useLayoutEffect']);
const SAFE_METHODS = new Set(['test', 'includes', 'startsWith', 'endsWith', 'some', 'every', 'has', 'indexOf']);
// Changed lines matching any of these can alter what is on screen even inside an effect: state setters, DOM writes,
// class/style writes, imperative render calls.
const FORBIDDEN_LINE_RE = new RegExp([
  String.raw`\bset[A-Z]\w*\s*\(`, String.raw`\bdispatch\s*\(`, String.raw`\bdocument\.`, String.raw`\.style\b`, 'classList', 'innerHTML', 'outerHTML',
  'appendChild', 'insertAdjacent', String.raw`\.(append|prepend|replaceWith|remove)\s*\(`, 'className', 'dangerouslySetInnerHTML', 'textContent',
  'flushSync', 'createPortal', 'createRoot', String.raw`\.render\s*\(`, String.raw`\bReactDOM\b`, String.raw`['"]use (client|server)['"]`,
].join('|'));

const norm = (s) => s.replace(/\s+/g, ' ').trim();

function parse(ts, file, text) {
  const kind = /\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  // parseDiagnostics is not public API: if a TypeScript release drops it, fail closed instead of reading undefined as clean.
  if (!Array.isArray(sf.parseDiagnostics) || sf.parseDiagnostics.length) return null;
  return sf;
}

function hasDeclare(ts, node) {
  return !!(node.modifiers && node.modifiers.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword));
}

/** Type-only ranges [start,end) that can be blanked without changing runtime behaviour. */
function typeRanges(ts, sf) {
  const out = [];
  const K = ts.SyntaxKind;
  const visit = (n) => {
    if (ts.isTypeNode(n) && n.kind !== K.ExpressionWithTypeArguments) { out.push([n.getStart(sf), n.end]); return; }
    if (ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) { out.push([n.getFullStart(), n.end]); return; }
    if (ts.isImportDeclaration(n) && n.importClause && n.importClause.isTypeOnly) { out.push([n.getFullStart(), n.end]); return; }
    if (ts.isModuleDeclaration(n) && hasDeclare(ts, n)) { out.push([n.getFullStart(), n.end]); return; }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function erase(text, ranges) {
  if (!ranges.length) return text;
  const chars = text.split('');
  for (const [s, e] of ranges) for (let i = s; i < e && i < chars.length; i++) if (chars[i] !== '\n') chars[i] = ' ';
  return chars.join('');
}

/** Outermost JSX node texts, in source order. */
function jsxTexts(ts, sf) {
  const out = [];
  const visit = (n, inJsx) => {
    const isJsx = ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n);
    if (isJsx && !inJsx) out.push(norm(n.getText(sf)));
    ts.forEachChild(n, (c) => visit(c, inJsx || isJsx));
  };
  visit(sf, false);
  return out;
}

function importBindings(ts, sf) {
  // local name -> module specifier, for every value import (type-only imports carry no runtime binding)
  const m = new Map();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause || st.importClause.isTypeOnly) continue;
    const spec = ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : '';
    const c = st.importClause;
    if (c.name) m.set(c.name.text, spec);
    if (c.namedBindings) {
      if (ts.isNamespaceImport(c.namedBindings)) m.set(c.namedBindings.name.text, spec);
      else for (const e of c.namedBindings.elements) m.set(e.name.text, spec);
    }
  }
  return m;
}

function isReturnOfNothing(ts, st) {
  if (ts.isBlock(st)) return st.statements.length === 1 && isReturnOfNothing(ts, st.statements[0]);
  if (!ts.isReturnStatement(st)) return false;
  const e = st.expression;
  return !e || e.kind === ts.SyntaxKind.NullKeyword || e.kind === ts.SyntaxKind.FalseKeyword || (ts.isIdentifier(e) && e.text === 'undefined');
}

/** A side-effect-free condition: names, property reads, literals, operators, calls to imported helpers or pure string/array tests. */
function safeCond(ts, n, imported) {
  const K = ts.SyntaxKind;
  if (ts.isIdentifier(n)) return true;
  if (ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isRegularExpressionLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true;
  if (n.kind === K.NullKeyword || n.kind === K.TrueKeyword || n.kind === K.FalseKeyword) return true;
  if (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isTypeOfExpression(n)) return safeCond(ts, n.expression, imported);
  if (ts.isPropertyAccessExpression(n)) return safeCond(ts, n.expression, imported);
  if (ts.isElementAccessExpression(n)) return ts.isNumericLiteral(n.argumentExpression) && safeCond(ts, n.expression, imported);
  if (ts.isPrefixUnaryExpression(n)) return (n.operator === K.ExclamationToken || n.operator === K.MinusToken) && safeCond(ts, n.operand, imported);
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    if (op >= K.FirstAssignment && op <= K.LastAssignment) return false;
    if (op === K.CommaToken) return false;
    return safeCond(ts, n.left, imported) && safeCond(ts, n.right, imported);
  }
  if (ts.isCallExpression(n)) {
    const c = n.expression;
    const okCallee = (ts.isIdentifier(c) && imported.has(c.text)) || (ts.isPropertyAccessExpression(c) && SAFE_METHODS.has(c.name.text) && safeCond(ts, c.expression, imported));
    return okCallee && n.arguments.every((a) => safeCond(ts, a, imported));
  }
  return false;
}

/** Guards in the first argument of an effect hook where a changed line is allowed. */
function guardRanges(ts, sf) {
  const imported = new Set(importBindings(ts, sf).keys());
  const out = [];
  const visitInside = (n) => {
    if (ts.isIfStatement(n) && !n.elseStatement && isReturnOfNothing(ts, n.thenStatement) && safeCond(ts, n.expression, imported)) { out.push([n.getStart(sf), n.end]); return; }
    if (ts.isArrayLiteralExpression(n) && n.elements.every((e) => ts.isRegularExpressionLiteral(e) || ts.isStringLiteral(e))) { out.push([n.getStart(sf), n.end]); return; }
    ts.forEachChild(n, visitInside);
  };
  const visit = (n) => {
    if (ts.isCallExpression(n) && n.arguments.length) {
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : (ts.isPropertyAccessExpression(callee) ? callee.name.text : '');
      const a = n.arguments[0];
      if (EFFECT_HOOKS.has(name) && (ts.isArrowFunction(a) || ts.isFunctionExpression(a))) visitInside(a);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Import declarations whose added lines are allowed (known .ts/.js module or bare package, never css/tsx/unresolved). */
function importRanges(ts, sf, resolveImport) {
  const out = [];
  for (const n of sf.statements) {
    if (!ts.isImportDeclaration(n) || !n.importClause) continue;
    const spec = ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : null;
    if (spec && importIsTs(spec, resolveImport)) out.push([n.getStart(sf), n.end]);
  }
  return out;
}

function importIsTs(spec, resolveImport) {
  if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|json)$/.test(spec)) return false;
  const isBare = !spec.startsWith('.') && !spec.startsWith('@/') && !spec.startsWith('~/');
  if (isBare) return true; // npm package: harmless unless used, and every use is checked
  try { return resolveImport(spec) === 'ts'; } catch { return false; }
}

/** Ranges where `//` at line start is NOT a comment (strings, templates, JSX text, regex). */
function nonCodeRanges(ts, sf) {
  const K = ts.SyntaxKind; const out = [];
  const kinds = new Set([K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateHead, K.TemplateMiddle, K.TemplateTail, K.JsxText, K.RegularExpressionLiteral]);
  const visit = (n) => { if (kinds.has(n.kind)) out.push([n.getStart(sf), n.end]); ts.forEachChild(n, visit); };
  visit(sf);
  return out;
}

/** Changed line indexes: { removed: old line idx[], added: new line idx[] }, or null if the diff is too big to trust. */
function diffLines(a, b) {
  const A = a.split('\n').map(norm); const B = b.split('\n').map(norm);
  let s = 0; while (s < A.length && s < B.length && A[s] === B[s]) s++;
  let ea = A.length; let eb = B.length;
  while (ea > s && eb > s && A[ea - 1] === B[eb - 1]) { ea--; eb--; }
  const n = ea - s; const m = eb - s;
  if (n * m > 16_000_000) return null;
  const w = m + 1; const L = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = A[s + i] === B[s + j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1]);
  const removed = []; const added = []; let i = 0; let j = 0;
  while (i < n && j < m) {
    if (A[s + i] === B[s + j]) { i++; j++; } else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) removed.push(s + i++); else added.push(s + j++);
  }
  while (i < n) removed.push(s + i++);
  while (j < m) added.push(s + j++);
  return { removed, added };
}

function lineSpan(text, idx) {
  let off = 0; const lines = text.split('\n');
  for (let i = 0; i < idx; i++) off += lines[i].length + 1;
  const raw = lines[idx];
  const lead = raw.length - raw.trimStart().length;
  return { start: off + lead, end: off + raw.trimEnd().length, text: raw };
}

const covered = (span, ranges) => ranges.some(([s, e]) => span.start >= s && span.end <= e);

function isNonRenderingChange({ file, oldSource, newSource, resolveImport }) {
  const no = (reason) => ({ exempt: false, reason });
  try {
    if (!/\.(tsx|jsx)$/.test(file || '')) return no('not a .tsx/.jsx file');
    if (typeof oldSource !== 'string' || typeof newSource !== 'string') return no('file is new, deleted or renamed');
    const ts = loadTs();
    if (!ts) return no('typescript package not available (fail closed)');
    const oSf = parse(ts, file, oldSource); const nSf = parse(ts, file, newSource);
    if (!oSf || !nSf) return no('parse error (fail closed)');
    const oJsx = jsxTexts(ts, oSf); const nJsx = jsxTexts(ts, nSf);
    if (oJsx.length !== nJsx.length || oJsx.some((t, i) => t !== nJsx[i])) return no('JSX changed');
    const oErased = erase(oldSource, typeRanges(ts, oSf)); const nErased = erase(newSource, typeRanges(ts, nSf));
    const d = diffLines(oErased, nErased);
    if (!d) return no('diff too large to analyse');
    const oImp = importRanges(ts, oSf, resolveImport); const nImp = importRanges(ts, nSf, resolveImport);
    const oGuard = guardRanges(ts, oSf); const nGuard = guardRanges(ts, nSf);
    const oNon = nonCodeRanges(ts, oSf); const nNon = nonCodeRanges(ts, nSf);
    // Imports: only ADDED names. A name present on both sides must point at the same module (no alias/path swap).
    const oB = importBindings(ts, oSf); const nB = importBindings(ts, nSf);
    for (const [name, mod] of oB) if (nB.has(name) && nB.get(name) !== mod) return no(`import ${name} now points at a different module`);
    const added = new Set([...nB.keys()].filter((k) => !oB.has(k)));
    if (added.size) {
      const inGuard = (id) => nGuard.some(([s0, e0]) => id.getStart(nSf) >= s0 && id.end <= e0);
      let bad = null;
      const visit = (n) => {
        if (ts.isImportDeclaration(n)) return;
        if (ts.isIdentifier(n) && added.has(n.text) && !inGuard(n)) bad = bad || n.text;
        ts.forEachChild(n, visit);
      };
      visit(nSf);
      if (bad) return no(`newly imported name ${bad} is used outside an allowed guard`);
    }
    const sides = [[d.removed, oErased, [], oGuard, oNon, 'removed'], [d.added, nErased, nImp, nGuard, nNon, 'added']];
    let changed = 0;
    for (const [idxs, text, imps, guards, non, label] of sides) {
      for (const idx of idxs) {
        const span = lineSpan(text, idx);
        const t = span.text.trim();
        if (!t) continue;
        if (/^\/\//.test(t) && !non.some(([s0, e0]) => span.start >= s0 && span.start < e0)) continue; // whole-line comment
        changed++;
        if (FORBIDDEN_LINE_RE.test(span.text)) return no(`${label} line ${idx + 1} touches DOM/state/class code: ${t.slice(0, 60)}`);
        if (!covered(span, guards) && !covered(span, imps)) return no(`${label} line ${idx + 1} is outside added imports, types and effect guards: ${t.slice(0, 60)}`);
      }
    }
    return { exempt: true, reason: changed ? `${changed} changed line(s), all in type/import/effect-only code` : 'no executable change' };
  } catch (err) {
    return no(`detector error (fail closed): ${err && err.message}`);
  }
}

/** Candidate resolver for the CLI: reads the pushed tree via git, never the working copy. */
function makeGitResolver(run) {
  return (spec) => {
    let base;
    if (spec.startsWith('@/')) base = 'src/' + spec.slice(2);
    else if (spec.startsWith('~/')) return 'unknown';
    else return 'unknown'; // relative specifiers resolved per file by the caller
    return probe(base, run);
  };
}
function probe(base, run) {
  for (const [ext, kind] of [['.ts', 'ts'], ['.js', 'ts'], ['.mjs', 'ts'], ['/index.ts', 'ts'], ['/index.js', 'ts'], ['.tsx', 'tsx'], ['.jsx', 'tsx'], ['/index.tsx', 'tsx']]) {
    if (run(base + ext)) return kind;
  }
  return 'unknown';
}

/**
 * files: repo-relative paths; read(side, file) -> string|null ('old' = merge-base, 'new' = pushed ref); returns the files to KEEP gated.
 * log(line) is called once per exemption.
 */
function filterFiles(files, read, resolveImportFor, log) {
  // Kill switch (rollback without a revert): RENDER_IMPACT_DISABLED=1 keeps every file gated, in the hook and in visual-approval.js.
  if (process.env.RENDER_IMPACT_DISABLED === '1') return files.slice();
  return files.filter((f) => {
    if (!/^src\/.*\.(tsx|jsx)$/.test(f)) return true;
    try {
      const resolveImport = (spec) => {
        if (spec.startsWith('.')) return resolveImportFor(path.posix.normalize(path.posix.join(path.posix.dirname(f), spec)).replace(/^/, '@rel:'));
        return resolveImportFor(spec);
      };
      const r = isNonRenderingChange({ file: f, oldSource: read('old', f), newSource: read('new', f), resolveImport });
      if (r.exempt) { try { log(`${f}: ${r.reason}`); } catch { /* logging must not change the verdict */ } return false; }
      return true;
    } catch { return true; }
  });
}

/** Git-backed filter for a `base...head` range: the one entry point for the push gate AND visual-approval.js (BRO-7849: one exemption list). */
function filterRange(range, files, cwd, log = null) {
  const { execFileSync } = require('child_process');
  try {
    const git = (args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const [baseRef, headRef] = range.split('...');
    const base = git(['merge-base', baseRef, headRef]).trim();
    const show = (ref, f) => { try { return git(['show', `${ref}:${f}`]); } catch { return null; } };
    const exists = (f) => { try { git(['cat-file', '-e', `${headRef}:${f}`]); return true; } catch { return false; } };
    const resolve = (spec) => (spec.startsWith('@rel:') ? probe(spec.slice(5), exists) : makeGitResolver(exists)(spec));
    return filterFiles(files, (side, f) => show(side === 'old' ? base : headRef, f), resolve, log || (() => {}));
  } catch { return files; } // fail closed
}

module.exports = { isNonRenderingChange, filterFiles, filterRange };

if (require.main === module && process.argv[2] === '--filter') {
  const fs = require('fs');
  const files = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean);
  const logFile = process.env.VISUAL_RENDER_IMPACT_LOG || path.join(process.env.CLAUDE_LOG_DIR || require('os').homedir() + '/.claude/logs', 'visual-gate-bypass.log');
  const log = (m) => { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${Math.floor(Date.now() / 1000)}\trender-impact-exempt\t${m}\n`); } catch { /* best effort: an audit trail, not a gate */ } };
  process.stdout.write(filterRange(process.argv[3], files, process.cwd(), log).map((f) => f + '\n').join(''));
}
