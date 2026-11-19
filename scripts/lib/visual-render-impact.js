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
const SAFE_METHODS = new Set(['test', 'includes', 'startsWith', 'endsWith', 'has', 'indexOf']);
// Telemetry SDK filter hooks: they receive an event and return it or null. They cannot change what is on screen, but only
// when their whole body is inert (see inertFn). Anything else (event handlers, effect bodies) is never a guard host.
const FILTER_HOOKS = new Set(['beforeSend', 'beforeSendTransaction', 'beforeBreadcrumb', 'beforeSendSpan']);
// Config properties whose value is a list of patterns that only suppress telemetry.
const TELEMETRY_GLOBALS = new Set(['Sentry', 'posthog']);
const PATTERN_LISTS = new Set(['ignoreErrors', 'denyUrls', 'allowUrls', 'ignoreTransactions']);
// Array methods that are pure when given an inert callback; string/regexp tests that are pure on any input.
const CALLBACK_METHODS = new Set(['some', 'every', 'filter', 'map', 'find', 'findIndex']);
// Imported helpers called in a guard condition must be named like predicates.
const PREDICATE_NAME = /^(is|has|should|can|matches)[A-Z0-9_]|(Scrub|Redact|Sanitize)$/;
// Extra markers that make a function body non-pure for the declaration-only module check.
// Browser globals and window-reaching property names: a local named like one, or a property chain through one, is never trusted.
const GLOBAL_NAMES = /^(window|globalThis|self|top|parent|frames|document|location|history|navigator|opener|view|defaultView|ownerDocument|contentWindow|contentDocument|localStorage|sessionStorage)$/;
const GLOBAL_LOCALS = /^(window|globalThis|self|top|parent|document|location|history|navigator|opener|localStorage|sessionStorage)$/;
const IMPURE_RE = /\b(window|globalThis|self|localStorage|sessionStorage|navigator|fetch|XMLHttpRequest|require|import|Function|eval|Reflect|Proxy)\b/;
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

/** Names declared anywhere under node (variables, parameters, functions, classes, destructured bindings), NOT import specifiers. */
function declaredNames(ts, node) {
  const out = new Set();
  const addName = (nm) => {
    if (!nm) return;
    if (ts.isIdentifier(nm)) out.add(nm.text);
    else if (ts.isObjectBindingPattern(nm) || ts.isArrayBindingPattern(nm)) for (const e of nm.elements) if (!ts.isOmittedExpression(e)) addName(e.name);
  };
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n)) addName(n.name);
    else if ((ts.isFunctionDeclaration(n) || ts.isFunctionExpression(n) || ts.isClassDeclaration(n) || ts.isClassExpression(n)) && n.name) out.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** True when fn declares a local named like a browser global (so a later bare use could be the real global), or has a parameter called `frames`. */
function shadowsGlobal(ts, fn) {
  if ([...declaredNames(ts, fn)].some((nm) => GLOBAL_LOCALS.test(nm))) return true;
  let hit = false;
  (function v(n) { if (ts.isParameter(n) && ts.isIdentifier(n.name) && n.name.text === 'frames') hit = true; ts.forEachChild(n, v); })(fn);
  return hit;
}

/** Scope facts for one filter hook: imported helpers (minus any name also declared in the file) and names local to the hook. */
function hookCtx(ts, sf, fn, resolveImport) {
  const shadowed = declaredNames(ts, sf);
  const all = [...importBindings(ts, sf)].filter(([k]) => !shadowed.has(k));
  const imported = new Set(all.map(([k]) => k)); // loose: may be called from the hook's unchanged statements (predicate/scrub-named only)
  // strict: names from a project module that resolves to a declaration-only .ts file; the only imports a guard CONDITION may use
  const strict = new Set(all.filter(([, spec]) => importIsTs(spec, resolveImport)).map(([k]) => k));
  const locals = declaredNames(ts, fn);
  return { imported, strict, locals };
}

/** root of a.b.c / a?.[0] / (a)! / "lit" / /re/ chains, or null when the root is something else (call, this, new ...). */
function chainRoot(ts, n) {
  for (;;) {
    if (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n)) n = n.expression;
    else if (ts.isPropertyAccessExpression(n)) n = n.expression;
    else if (ts.isElementAccessExpression(n)) { if (!ts.isNumericLiteral(n.argumentExpression)) return null; n = n.expression; } else return n;
  }
}
function rootOk(ts, n, ctx) {
  const r = chainRoot(ts, n);
  if (!r) return false;
  if (ts.isIdentifier(r)) return r.text === 'undefined' || ctx.locals.has(r.text) || ctx.imported.has(r.text);
  return ts.isStringLiteral(r) || ts.isNoSubstitutionTemplateLiteral(r) || ts.isRegularExpressionLiteral(r);
}
/** A call that cannot have side effects on the page: predicate/scrub-named imported helper, or a pure array/string/regexp method on a hook-local value. */
function callOk(ts, n, ctx, argOk) {
  const c = n.expression;
  if (ts.isIdentifier(c)) return ctx.imported.has(c.text) && PREDICATE_NAME.test(c.text) && n.arguments.every(argOk);
  if (!ts.isPropertyAccessExpression(c) || !rootOk(ts, c.expression, ctx)) return false;
  const r0 = chainRoot(ts, c.expression); // a method on an imported object runs that module's code: only hook-local receivers
  if (r0 && ts.isIdentifier(r0) && ctx.imported.has(r0.text) && !ctx.locals.has(r0.text)) return false;
  const m = c.name.text;
  if (CALLBACK_METHODS.has(m)) {
    // The callback body is held to the same rules as the condition itself: plain identifier params (no defaults, so no window smuggled in),
    // an expression body, and every name/call in it from hook-local values or the SAME import set as the caller.
    return n.arguments.every((a) => {
      if (!(ts.isArrowFunction(a) || ts.isFunctionExpression(a)) || !a.body || ts.isBlock(a.body)) return false;
      if (!a.parameters.every((q) => ts.isIdentifier(q.name) && !q.initializer && !q.dotDotDotToken)) return false;
      const inner = { locals: new Set([...ctx.locals, ...a.parameters.map((q) => q.name.text)]), imported: ctx.imported };
      return safeCond(ts, a.body, inner);
    });
  }
  return SAFE_METHODS.has(m) && n.arguments.every(argOk);
}

/** A side-effect-free condition: hook-local names, property reads on them, literals, operators, and callOk calls. */
function safeCond(ts, n, ctx) {
  const K = ts.SyntaxKind;
  if (ts.isIdentifier(n)) return n.text === 'undefined' || ctx.locals.has(n.text) || ctx.imported.has(n.text);
  if (ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isRegularExpressionLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true;
  if (n.kind === K.NullKeyword || n.kind === K.TrueKeyword || n.kind === K.FalseKeyword) return true;
  if (ts.isParenthesizedExpression(n) || ts.isNonNullExpression(n) || ts.isAsExpression(n) || ts.isTypeOfExpression(n)) return safeCond(ts, n.expression, ctx);
  if (ts.isPropertyAccessExpression(n)) return rootOk(ts, n, ctx);
  if (ts.isElementAccessExpression(n)) return rootOk(ts, n, ctx);
  if (ts.isPrefixUnaryExpression(n)) return (n.operator === K.ExclamationToken || n.operator === K.MinusToken) && safeCond(ts, n.operand, ctx);
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    if ((op >= K.FirstAssignment && op <= K.LastAssignment) || op === K.CommaToken) return false;
    return safeCond(ts, n.left, ctx) && safeCond(ts, n.right, ctx);
  }
  if (ts.isCallExpression(n)) return callOk(ts, n, ctx, (a) => safeCond(ts, a, ctx));
  return false;
}

/**
 * True when the hook can only compute a value: no assignment, delete, new, await, JSX, DOM/state text, every property read
 * rooted in a hook-local or imported name, and the only calls are callOk calls.
 */
function inertFn(ts, fn, ctx, sf) {
  if (FORBIDDEN_LINE_RE.test(fn.getText(sf))) return false;
  const K = ts.SyntaxKind;
  let ok = true;
  const visit = (n) => {
    if (!ok) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= K.FirstAssignment && n.operatorToken.kind <= K.LastAssignment) { ok = false; return; }
    if (ts.isDeleteExpression(n) || ts.isNewExpression(n) || ts.isAwaitExpression(n) || ts.isTaggedTemplateExpression(n) || ts.isYieldExpression(n)
      || ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n) || ts.isThisTypeNode(n) || n.kind === K.ThisKeyword
      || ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === K.PlusPlusToken || n.operator === K.MinusMinusToken))) { ok = false; return; }
    if (ts.isCallExpression(n)) { if (!callOk(ts, n, ctx, () => true)) { ok = false; return; } }
    else if ((ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && !(ts.isCallExpression(n.parent) && n.parent.expression === n) && !rootOk(ts, n, ctx)) { ok = false; return; }
    ts.forEachChild(n, visit);
  };
  ts.forEachChild(fn, visit);
  return ok;
}

/**
 * Guards allowed to change: `if (<safeCond>) return null;` directly inside an inert telemetry filter hook, and pattern-list
 * arrays, both only as direct properties of the options object passed to an `*.init({...})` call.
 */
function guardRanges(ts, sf, resolveImport) {
  const out = [];
  const fileDeclared = new Set([...declaredNames(ts, sf), ...importBindings(ts, sf).keys()]);
  // A file that assigns to window/globalThis/Sentry/posthog (or defines properties on them) may have faked the telemetry global.
  const strip0 = (e) => { while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression; return e; };
  const tampered = new Set();
  const tamperAll = () => { for (const g of TELEMETRY_GLOBALS) tampered.add(g); };
  (function scan(n) {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && n.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const lt = n.left.getText(sf);
      for (const g of TELEMETRY_GLOBALS) if (new RegExp(`\\b${g}\\b`).test(lt)) tampered.add(g);
      const l = strip0(n.left);
      if (ts.isObjectLiteralExpression(l) || ts.isArrayLiteralExpression(l) || (ts.isElementAccessExpression(l) && /\b(window|globalThis|self)\b/.test(lt) && (() => {
        const k = l.argumentExpression;
        if (ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) return TELEMETRY_GLOBALS.has(k.text);
        if (ts.isTemplateExpression(k) && k.head.text) return [...TELEMETRY_GLOBALS].some((g) => g.startsWith(k.head.text) || k.head.text.startsWith(g));
        return true;
      })())) tamperAll();
    }
    if (ts.isCallExpression(n) && /\b(defineProperty|defineProperties|assign|setPrototypeOf|__defineGetter__|__defineSetter__)\b/.test(n.expression.getText(sf))) tamperAll();
    ts.forEachChild(n, scan);
  })(sf);
  const strip = (e) => { while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) e = e.expression; return e; };
  const globalRef = (e) => { // window.Sentry / globalThis.posthog / bare Sentry that this file does not declare
    e = strip(e);
    if (ts.isIdentifier(e)) return TELEMETRY_GLOBALS.has(e.text) && !tampered.has(e.text) && !fileDeclared.has(e.text);
    if (ts.isPropertyAccessExpression(e) && TELEMETRY_GLOBALS.has(e.name.text) && !tampered.has(e.name.text)) { const r = strip(e.expression); return ts.isIdentifier(r) && (r.text === 'window' || r.text === 'globalThis') && !fileDeclared.has(r.text); }
    return false;
  };
  const aliasDecls = new Map();
  (function collect(n) { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) aliasDecls.set(n.name.text, [...(aliasDecls.get(n.name.text) || []), n]); ts.forEachChild(n, collect); })(sf);
  const telemetryReceiver = (e) => {
    e = strip(e);
    if (globalRef(e)) return true;
    if (!ts.isIdentifier(e)) return false;
    const ds = aliasDecls.get(e.text) || [];
    return ds.length === 1 && !!ds[0].initializer && globalRef(ds[0].initializer);
  };
  const nameOf = (n) => (n.name && (ts.isIdentifier(n.name) || ts.isStringLiteral(n.name)) ? n.name.text : '');
  const fromOptions = (obj) => {
    for (const pr of obj.properties) {
      let fn = null;
      if (ts.isMethodDeclaration(pr) && FILTER_HOOKS.has(nameOf(pr))) fn = pr;
      else if (ts.isPropertyAssignment(pr) && FILTER_HOOKS.has(nameOf(pr)) && (ts.isArrowFunction(pr.initializer) || ts.isFunctionExpression(pr.initializer))) fn = pr.initializer;
      if (fn && fn.body && ts.isBlock(fn.body)) {
        const ctx = hookCtx(ts, sf, fn, resolveImport);
        for (const prm of fn.parameters) if (ts.isIdentifier(prm.name)) ctx.locals.add(prm.name.text);
        if (!shadowsGlobal(ts, fn) && inertFn(ts, fn.body, ctx, sf)) {
          for (const st of fn.body.statements) {
            if (ts.isIfStatement(st) && !st.elseStatement && isReturnOfNothing(ts, st.thenStatement) && safeCond(ts, st.expression, { locals: ctx.locals, imported: ctx.strict })) out.push([st.getStart(sf), st.end]);
          }
        }
      }
      if (ts.isPropertyAssignment(pr) && PATTERN_LISTS.has(nameOf(pr)) && ts.isArrayLiteralExpression(pr.initializer)
        && pr.initializer.elements.every((e) => ts.isRegularExpressionLiteral(e) || ts.isStringLiteral(e))) out.push([pr.initializer.getStart(sf), pr.initializer.end]);
    }
  };
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      const name = ts.isIdentifier(c) ? c.text : (ts.isPropertyAccessExpression(c) ? c.name.text : '');
      // Only `X.init({...})` as a bare statement (result discarded, so nothing the hook returns can reach render output) where X
      // is a telemetry global (Sentry, posthog; directly, via window, or a single const alias of window.<global>).
      if (name === 'init' && ts.isPropertyAccessExpression(c) && ts.isExpressionStatement(n.parent) && telemetryReceiver(c.expression)) {
        for (const a of n.arguments) if (ts.isObjectLiteralExpression(a)) fromOptions(a);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** Comment ranges taken from the parser's own trivia (never a line-prefix guess): erasing them cannot hide live code. */
function commentRanges(ts, sf) {
  const seen = new Set(); const out = []; const text = sf.text;
  const add = (rs) => { for (const r of rs || []) { const k = `${r.pos}:${r.end}`; if (!seen.has(k)) { seen.add(k); out.push([r.pos, r.end]); } } };
  const inJsxChildren = (n) => n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent));
  const visit = (n) => {
    if (n.kind !== ts.SyntaxKind.JsxText) {
      if (!inJsxChildren(n)) { add(ts.getLeadingCommentRanges(text, n.getFullStart())); add(ts.getTrailingCommentRanges(text, n.end)); }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  add(ts.getLeadingCommentRanges(text, sf.endOfFileToken.getFullStart()));
  return out;
}

/** A project module is safe to import as non-rendering only if its top level declares things and runs nothing. */
function isDeclarationOnly(ts, file, text) {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.jsx?$/.test(file) ? ts.ScriptKind.JS : ts.ScriptKind.TS);
  if (!Array.isArray(sf.parseDiagnostics) || sf.parseDiagnostics.length) return false;
  const K = ts.SyntaxKind;
  const moduleNames = declaredNames(ts, sf);
  const SAFE_GLOBALS = new Set(['undefined', 'NaN', 'Infinity', 'Math', 'String', 'Number', 'Boolean', 'Array', 'JSON', 'isNaN', 'parseInt', 'parseFloat']);
  const PURE_METHODS = new Set([...SAFE_METHODS, ...CALLBACK_METHODS, 'toLowerCase', 'toUpperCase', 'trim', 'slice', 'split', 'join', 'map', 'filter', 'some', 'every', 'concat', 'startsWith', 'endsWith', 'floor', 'ceil', 'round', 'min', 'max', 'abs', 'isArray']);
  // A function body that can only compute from its parameters/locals/module declarations: no assignment, no calls except to
  // module-declared functions, safe globals and pure methods, no identifier from anywhere else (location, top, scrollTo ...).
  const pureFn = (fn) => {
    if (FORBIDDEN_LINE_RE.test(fn.getText(sf)) || IMPURE_RE.test(fn.getText(sf))) return false;
    const locals = declaredNames(ts, fn);
    if (shadowsGlobal(ts, fn)) return false;
    let ok = true;
    const visit = (n) => {
      if (!ok) return;
      if (ts.isBinaryExpression(n) && n.operatorToken.kind >= K.FirstAssignment && n.operatorToken.kind <= K.LastAssignment) { ok = false; return; }
      if (ts.isDeleteExpression(n) || ts.isNewExpression(n) || ts.isAwaitExpression(n) || ts.isTaggedTemplateExpression(n) || ts.isYieldExpression(n) || n.kind === K.ThisKeyword
        || ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)
        || ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) && (n.operator === K.PlusPlusToken || n.operator === K.MinusMinusToken))) { ok = false; return; }
      if (ts.isElementAccessExpression(n) && !ts.isNumericLiteral(n.argumentExpression)) { ok = false; return; }
      if (ts.isPropertyAccessExpression(n) && GLOBAL_NAMES.test(n.name.text)) { ok = false; return; }
      if (ts.isPropertyAccessExpression(n) && /^(constructor|__proto__|prototype|call|apply|bind|getPrototypeOf|__defineGetter__|__lookupGetter__)$/.test(n.name.text)) { ok = false; return; }
      if (ts.isCallExpression(n)) {
        const c = n.expression;
        if (ts.isIdentifier(c)) { if (!(moduleNames.has(c.text) || SAFE_GLOBALS.has(c.text)) || (locals.has(c.text) && !moduleNames.has(c.text))) { ok = false; return; } }
        else if (!(ts.isPropertyAccessExpression(c) && PURE_METHODS.has(c.name.text))) { ok = false; return; }
      }
      if (ts.isIdentifier(n)) {
        const par = n.parent;
        const isPropName = (ts.isPropertyAccessExpression(par) && par.name === n) || (ts.isPropertyAssignment(par) && par.name === n) || (ts.isBindingElement(par) && par.propertyName === n)
          || ts.isTypeReferenceNode(par) || ts.isTypeParameterDeclaration(par);
        if (!isPropName && !(locals.has(n.text) || moduleNames.has(n.text) || SAFE_GLOBALS.has(n.text))) { ok = false; return; }
      }
      ts.forEachChild(n, visit);
    };
    visit(fn);
    return ok;
  };
  // Values that run nothing when the module loads: primitives, regexes, and arrays/objects made only of them.
  const pureLit = (e) => {
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return pureLit(e.expression);
    if (ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isRegularExpressionLiteral(e)) return true;
    if (e.kind === K.TrueKeyword || e.kind === K.FalseKeyword || e.kind === K.NullKeyword) return true;
    if (ts.isPrefixUnaryExpression(e)) return e.operator === K.MinusToken && ts.isNumericLiteral(e.operand);
    if (ts.isArrayLiteralExpression(e)) return e.elements.every(pureLit);
    if (ts.isObjectLiteralExpression(e)) return e.properties.every((pr) => ts.isPropertyAssignment(pr) && !ts.isComputedPropertyName(pr.name) && pureLit(pr.initializer));
    return false;
  };
  const pureInit = (e) => {
    if (!e) return true;
    if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return pureInit(e.expression);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return pureFn(e);
    return pureLit(e);
  };
  return sf.statements.every((st) => {
    if (ts.isInterfaceDeclaration(st) || ts.isTypeAliasDeclaration(st)) return true;
    if (ts.isImportDeclaration(st)) return !!(st.importClause && st.importClause.isTypeOnly);
    if (ts.isFunctionDeclaration(st)) return !!st.body && pureFn(st);
    if (ts.isVariableStatement(st)) return st.declarationList.declarations.every((d) => pureInit(d.initializer));
    if (ts.isExportDeclaration(st)) return !st.moduleSpecifier || !!st.isTypeOnly;
    if (ts.isExportAssignment(st)) return pureInit(st.expression);
    return false;
  });
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
  // A bare npm package runs its top-level code on load (CSS injection, DOM writes): never exempt.
  if (!spec.startsWith('.') && !spec.startsWith('@/') && !spec.startsWith('~/')) return false;
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
    const oErased = erase(oldSource, [...typeRanges(ts, oSf), ...commentRanges(ts, oSf)]); const nErased = erase(newSource, [...typeRanges(ts, nSf), ...commentRanges(ts, nSf)]);
    const d = diffLines(oErased, nErased);
    if (!d) return no('diff too large to analyse');
    const oImp = importRanges(ts, oSf, resolveImport); const nImp = importRanges(ts, nSf, resolveImport);
    const oGuard = guardRanges(ts, oSf, resolveImport); const nGuard = guardRanges(ts, nSf, resolveImport);
    const oNon = nonCodeRanges(ts, oSf); const nNon = nonCodeRanges(ts, nSf);
    // Imports: only ADDED names. A name present on both sides must point at the same module (no alias/path swap).
    const oB = importBindings(ts, oSf); const nB = importBindings(ts, nSf);
    for (const [name, mod] of oB) if (nB.has(name) && nB.get(name) !== mod) return no(`import ${name} now points at a different module`);
    const added = new Set([...nB.keys()].filter((k) => !oB.has(k)));
    if (added.size) {
      const inGuard = (id) => nGuard.some(([s0, e0]) => id.getStart(nSf) >= s0 && id.end <= e0);
      let bad = null; const usedInGuard = new Set();
      const visit = (n) => {
        if (ts.isImportDeclaration(n)) return;
        if (ts.isIdentifier(n) && added.has(n.text)) { if (inGuard(n)) usedInGuard.add(n.text); else bad = bad || n.text; }
        ts.forEachChild(n, visit);
      };
      visit(nSf);
      if (bad) return no(`newly imported name ${bad} is used outside an allowed guard`);
      for (const name of added) if (!usedInGuard.has(name)) return no(`newly imported name ${name} is never used in a guard (an import can run code on load)`);
    }
    // String, template, regex and JSX text contents must be byte-identical outside guards and imports (diffLines ignores whitespace).
    const literals = (sf, skip, typeR) => {
      const K = ts.SyntaxKind; const out = [];
      const kinds = new Set([K.StringLiteral, K.NoSubstitutionTemplateLiteral, K.TemplateHead, K.TemplateMiddle, K.TemplateTail, K.JsxText, K.RegularExpressionLiteral]);
      const v = (n) => {
        if (kinds.has(n.kind)) { const st = n.getStart(sf); if (!skip.some(([a, b]) => st >= a && n.end <= b) && !typeR.some(([a, b]) => st >= a && n.end <= b)) out.push(n.getText(sf)); }
        ts.forEachChild(n, v);
      };
      v(sf); return out;
    };
    const oLit = literals(oSf, [...oGuard, ...oImp], typeRanges(ts, oSf)); const nLit = literals(nSf, [...nGuard, ...nImp], typeRanges(ts, nSf));
    if (oLit.length !== nLit.length || oLit.some((t, i) => t !== nLit[i])) return no('a string, template, regex or text literal changed');
    const sides = [[d.removed, oErased, [], oGuard, oNon, 'removed'], [d.added, nErased, nImp, nGuard, nNon, 'added']];
    let changed = 0;
    for (const [idxs, text, imps, guards, non, label] of sides) {
      for (const idx of idxs) {
        const span = lineSpan(text, idx);
        const t = span.text.trim();
        if (!t) continue;
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
function makeGitResolver(run, pure) {
  return (spec) => {
    let base;
    if (spec.startsWith('@/')) base = 'src/' + spec.slice(2);
    else if (spec.startsWith('~/')) return 'unknown';
    else return 'unknown'; // relative specifiers resolved per file by the caller
    return probe(base, run, pure);
  };
}
// Same order as Next/webpack: .tsx before .ts. A 'ts' hit counts only when the module is declaration-only (pure(path) true).
function probe(base, run, pure) {
  for (const [ext, kind] of [['.tsx', 'tsx'], ['.ts', 'ts'], ['.jsx', 'tsx'], ['.js', 'ts'], ['.mjs', 'ts'], ['/index.tsx', 'tsx'], ['/index.ts', 'ts'], ['/index.js', 'ts']]) {
    if (run(base + ext)) return kind === 'ts' && pure && !pure(base + ext) ? 'unknown' : kind;
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
    const ts = loadTs();
    const pure = (f) => { const t = show(headRef, f); return !!ts && typeof t === 'string' && isDeclarationOnly(ts, f, t); };
    const resolve = (spec) => (spec.startsWith('@rel:') ? probe(spec.slice(5), exists, pure) : makeGitResolver(exists, pure)(spec));
    return filterFiles(files, (side, f) => show(side === 'old' ? base : headRef, f), resolve, log || (() => {}));
  } catch { return files; } // fail closed
}

module.exports = { isNonRenderingChange, filterFiles, filterRange, _isDeclarationOnly: isDeclarationOnly };

if (require.main === module && process.argv[2] === '--filter') {
  const fs = require('fs');
  const files = fs.readFileSync(0, 'utf8').split('\n').filter(Boolean);
  const logFile = process.env.VISUAL_RENDER_IMPACT_LOG || path.join(process.env.CLAUDE_LOG_DIR || require('os').homedir() + '/.claude/logs', 'visual-gate-bypass.log');
  const log = (m) => { try { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${Math.floor(Date.now() / 1000)}\trender-impact-exempt\t${m}\n`); } catch { /* best effort: an audit trail, not a gate */ } };
  process.stdout.write(filterRange(process.argv[3], files, process.cwd(), log).map((f) => f + '\n').join(''));
}
