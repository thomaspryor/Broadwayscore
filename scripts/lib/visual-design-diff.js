'use strict';
// BRO-7881: is a UI diff a DESIGN change (the owner's call) or a FIX (the session's own visual QA is enough)?
//
// The owner never chose to approve bug fixes. The visual "yes" rule came from a design that shipped not matching
// its reference (FeaturedSpot, 2026-05-24); the owner called the approval path on a one-line fix "painful"
// (2026-05-29, cloud-memory/feedback_absorb_gate_ceremony.md). So a fix ships on the session's own passing,
// current visual-qa verdict; a design change still waits for the owner's yes.
//
// A file is a FIX only if ALL hold (anything else, any parse error or missing typescript = DESIGN, fail closed):
//   1. it is a .tsx/.jsx file present on both sides (CSS/SCSS, Tailwind/PostCSS config, new/deleted files = design);
//   2. both sides parse cleanly;
//   3. its page SKELETON is identical before and after. The skeleton is: every JSX tag in order, every attribute
//      name, the full expression of every attribute except handlers/key/ref/href/id/data-/aria-, every string,
//      number, true/false/null literal in the file (not types, not import paths; numbers/booleans/null inside effect
//      callbacks and on* handlers are logic and skipped), what every JSX tag identifier points at (its import path or
//      const initializer), CSS imports and 'use client'/'use server'. JSX text (copy) and other logic are NOT in it,
//      so reworded copy, a changed handler, href or data path is a fix; a moved, added or removed element, a changed
//      class, style, literal or tag target is design.
//   4. (BRO-8169) the one exception to "identical": the new skeleton may ADD insertable tokens. An `await` (and the
//      parentheses directly around it) on a non-JSX expression outside any JSX, not written straight into a branch
//      condition, and not initialising a const that feeds className/class/style; and `async` on a non-exported named function
//      whose body has no JSX, awaits on its own, and whose every use in the file is `await name(...)`. Removing any
//      of these stays design (a Promise would then reach a condition or a class). `for await` is not exempt.
//      Kill switch for just this exemption: VISUAL_AWAIT_TRANSPARENT_DISABLED=1.
//   5. (BRO-8177) logic-only edits are treated like inline handlers: (a) a non-exported, JSX-free function binding
//      (incl. useCallback) whose every use sits in a quiet root is recorded as quiet (a named handler); (b) a JSX-free,
//      hook-free binding whose value starts with a path/scheme and whose every use lands in a URL or log position is
//      quiet with its strings skipped (a URL builder); (c) inside quiet code, a string that lands in href/to on <a> or
//      next/link Link, router.push/replace/prefetch, window.open, location.assign/replace/href, fetch (URL must start
//      with "/" or a scheme: "?tab=", "#x", "${base}" stay design), or in console.*, track*, captureEvent, gtag,
//      posthog.capture, Sentry.capture*, navigator.clipboard/share/sendBeacon, is not recorded. State setters, DOM
//      writes, classes, styles, rendered literals, error messages and custom-component props all still count.
//      Kill switch for just this exemption: VISUAL_LOGIC_ONLY_DISABLED=1.
//
// One entry point (selfClear) is shared by .claude/hooks/pre-push-visual-gate.sh and scripts/land-ready.mjs, both
// running the main checkout's copy (the pushing checkout runs the main checkout copy of the hook and this file, so a pushed branch cannot loosen it), so the two never disagree.
// Trust level: verdict.json is written by the session itself (unsigned), the same trust as the '# NO-VERIFY:' bypass.
// The real protection is this classifier being strict: literals, tag identity and non-handler props all count. Kill switch: VISUAL_FIX_SELF_CLEAR_DISABLED=1.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let _ts = null;
function loadTs() {
  if (_ts) return _ts;
  // node_modules is untracked, so a pushed branch cannot supply the parser: this copy's, else the session checkout's
  // (the canonical-root copy of this file, run by the hook, has no node_modules of its own in a cloud container).
  try { _ts = require(require.resolve('typescript', { paths: [__dirname, process.cwd()] })); return _ts; } catch { return null; }
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

function parse(ts, file, text) {
  const kind = /\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  if (!Array.isArray(sf.parseDiagnostics) || sf.parseDiagnostics.length) return null;
  return sf;
}

/**
 * The drawing skeleton of one source file: an array of tokens (with an .imports map attached).
 * Everything that can draw is recorded as node kind + identifier/literal text. Only code that cannot draw is skipped:
 * types, comments, JSX text (copy), import/export statements (compared separately), and the inside of "quiet" roots
 * (effect callbacks, on* handlers, key/ref/href/to/name/htmlFor props), where only strings and DOM style/class writes count.
 */
function skeleton(ts, sf, env = process.env) {
  const out = [];
  const imports = new Map(); // local binding -> "module::importedName"
  const K = ts.SyntaxKind;
  const QUIET_ATTR = /^(on[A-Z]\w*|key|ref|href|to)$/;
  const QUIET_DOM_ATTR = /^(name|htmlFor)$/; // quiet on intrinsic (lowercase) tags only: <Icon name={x}/> picks what draws
  // BRO-8177: logic-only exemptions (see the header, rule 5). Kill switch for just these: VISUAL_LOGIC_ONLY_DISABLED=1.
  const logicOn = env.VISUAL_LOGIC_ONLY_DISABLED !== '1';
  // `window.open(url)` opens a tab and draws nothing on this page; `dialog.open = true` and a hook's `open()` still count.
  const DOM_WRITE = logicOn
    ? /\b(style|className|classList|cssText|dataset|innerHTML|outerHTML|textContent|insertAdjacentHTML|hidden|(?<!window\.)open|scrollTop|scrollLeft)\b|\.(setProperty|setAttribute|toggle|add|remove|showModal|close|show|scrollTo)\(/
    : /\b(style|className|classList|cssText|dataset|innerHTML|outerHTML|textContent|insertAdjacentHTML|hidden|open|scrollTop|scrollLeft)\b|\.(setProperty|setAttribute|toggle|add|remove|showModal|close|show|scrollTo)\(/;
  // Inside quiet roots a state setter or timer still decides what shows (setS(true), a 99999ms delay): recorded in full.
  const STATE_CALL = /^(?:[\w$.?]*\.)?(set[A-Z]\w*|dispatch|setTimeout|setInterval|requestAnimationFrame)$/;
  let quiet = 0;
  const FORMAT_NAME = /^format[A-Z0-9_]\w*$/;
  // Element builders without JSX syntax, and helpers whose result feeds class/style or a component prop (the result then draws).
  const ELEMENT_BUILD = /\b(createElement|cloneElement|jsxs?|jsxDEV)\b|\bh\(/;
  const visualUse = new Set();
  const scanUse = (x, inVisual) => {
    let v = inVisual;
    if (ts.isJsxAttribute(x)) { const tag = x.parent.parent.tagName.getText(sf); v = /^(className|class|style)$/.test(x.name.getText(sf)) || /^[A-Z]/.test(tag) || tag.includes('.'); }
    else if (ts.isJsxSpreadAttribute(x)) v = true;
    if (v && ts.isIdentifier(x)) visualUse.add(x.text);
    ts.forEachChild(x, (c) => scanUse(c, v));
  };
  scanUse(sf, false);
  const hasJsx = (n) => { let f = false; const w = (x) => { if (f) return; if (ts.isJsxElement(x) || ts.isJsxSelfClosingElement(x) || ts.isJsxFragment(x)) { f = true; return; } ts.forEachChild(x, w); }; w(n); return f; };
  // BRO-8169: tokens a diff may ADD without changing what draws. Their indexes go in out.insertable (a side set, so
  // no literal text can pose as one); see insertOnlyMatch. The kill switch leaves the set empty: exact old behaviour.
  const insertableIdx = new Set();
  const awaitExemptOn = env.VISUAL_AWAIT_TRANSPARENT_DISABLED !== '1';
  const isFn = (x) => ts.isFunctionDeclaration(x) || ts.isFunctionExpression(x) || ts.isArrowFunction(x) || ts.isMethodDeclaration(x);
  const JSX_KINDS = new Set([K.JsxElement, K.JsxSelfClosingElement, K.JsxFragment, K.JsxExpression, K.JsxAttribute, K.JsxSpreadAttribute, K.JsxOpeningElement]);
  const insideJsx = (x) => { for (let p = x.parent; p; p = p.parent) if (JSX_KINDS.has(p.kind)) return true; return false; };
  // An await written straight into a branch condition, or whose const feeds a class/style, stays design: if the callee
  // was already async, the old code tested a Promise (always truthy) or drew "[object Promise]". Accepted residual risk:
  // a const that later reaches a condition (`const r = await get(); if (!r) notFound()`) is allowed, because that is
  // the normal shape when the callee just became async (BRO-8056 p2), and the visual-qa verdict still has to pass.
  const CLS_ATTR = /^(className|class|style)$/;
  const upParens = (x) => { while (x.parent && ts.isParenthesizedExpression(x.parent)) x = x.parent; return x; };
  const decidesDrawing = (x) => {
    const e = upParens(x), p = e.parent;
    if (!p) return false;
    if ((ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) && p.expression === e) return true;
    if (ts.isForStatement(p) && p.condition === e) return true;
    if (ts.isConditionalExpression(p) && p.condition === e) return true;
    if (ts.isPrefixUnaryExpression(p) && p.operator === K.ExclamationToken) return true;
    if (ts.isBinaryExpression(p) && [K.AmpersandAmpersandToken, K.BarBarToken, K.QuestionQuestionToken].includes(p.operatorToken.kind)) return true;
    if (ts.isTemplateSpan(p)) return true; // `${promise}` text
    return false;
  };
  const nameFeedsClass = (name) => { let hit = false; const w = (x, inCls) => { if (hit) return; let c = inCls; if (ts.isJsxAttribute(x)) c = CLS_ATTR.test(x.name.getText(sf)); if (ts.isIdentifier(x) && x.text === name && !(x.parent && ts.isVariableDeclaration(x.parent) && x.parent.name === x) && c) { hit = true; return; } ts.forEachChild(x, (y) => w(y, c)); }; w(sf, false); return hit; };
  const insertableAwait = (x) => {
    if (!ts.isAwaitExpression(x) || insideJsx(x) || hasJsx(x.expression) || decidesDrawing(x)) return false;
    const d = upParens(x).parent; // `const v = await f()`: v must not later feed className/class/style
    if (d && ts.isVariableDeclaration(d) && d.initializer === upParens(x) && ts.isIdentifier(d.name) && nameFeedsClass(d.name.text)) return false;
    return true;
  };
  const ownsAwait = (fn) => { let f = false; const w = (x) => { if (f) return; if (x !== fn.body && isFn(x)) return; if (ts.isAwaitExpression(x)) { f = true; return; } ts.forEachChild(x, w); }; if (fn.body) w(fn.body); return f; };
  // A newly async function returns a Promise, so every caller must await it. Only a function bound to a non-exported
  // const/function name whose every other mention in the file is `await name(...)` qualifies; an inline callback,
  // an export (callers in other files) or any bare reference stays design.
  const bindingOf = (fn) => {
    if (ts.isFunctionDeclaration(fn)) return fn.name ? { name: fn.name, stmt: fn } : null;
    let x = fn;
    while (x.parent && ts.isCallExpression(x.parent) && x.parent.arguments.includes(x)) x = x.parent; // cache(async () => ...)
    const d = x.parent;
    if (!d || !ts.isVariableDeclaration(d) || d.initializer !== x || !ts.isIdentifier(d.name)) return null;
    const stmt = d.parent && d.parent.parent;
    return stmt && ts.isVariableStatement(stmt) ? { name: d.name, stmt } : null;
  };
  // `export { h }` / `export default h` are bare references, which everyUseAwaited already refuses.
  const exported = (stmt) => !!(stmt.modifiers && stmt.modifiers.some((m) => m.kind === K.ExportKeyword));
  const everyUseAwaited = (b) => { let ok = true; const w = (x) => { if (!ok) return; if (ts.isIdentifier(x) && x !== b.name && x.text === b.name.text) { const c = x.parent; if (!(c && ts.isCallExpression(c) && c.expression === x && c.parent && ts.isAwaitExpression(c.parent))) ok = false; } ts.forEachChild(x, w); }; w(sf); return ok; };
  const insertableAsync = (x) => {
    if (x.kind !== K.AsyncKeyword || !x.parent || !isFn(x.parent) || !x.parent.body || hasJsx(x.parent.body) || !ownsAwait(x.parent)) return false;
    const b = bindingOf(x.parent);
    return !!b && !exported(b.stmt) && everyUseAwaited(b);
  };
  const isQuietRoot = (n) => (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^use(Layout|Insertion)?Effect$/.test(n.expression.text))
    || (ts.isJsxAttribute(n) && (QUIET_ATTR.test(n.name.getText(sf)) || (QUIET_DOM_ATTR.test(n.name.getText(sf)) && /^[a-z]/.test(n.parent.parent.tagName.getText(sf)))));

  // ---- BRO-8177: logic-only edits (URL builders, named handlers, log/analytics strings) ----
  // Strings that can only reach a URL, a log line or an analytics event cannot change a pixel on this page.
  // URL sinks and safe href/to need the URL to START with a path or scheme: `?tab=x` / `#id` / `${x}...` can switch
  // what this same page shows, so they stay design. Error messages are NOT a sink (error.tsx can draw error.message).
  const URL_SINK = /^((?:router|navigation)\.(push|replace|prefetch)|window\.open|(?:window\.)?location\.(assign|replace)|fetch)$/;
  const LOG_SINK = /^(console\.(log|info|warn|error|debug)|track(?:[A-Z]\w*)?|captureEvent|gtag|posthog\.capture|Sentry\.(captureException|captureMessage|addBreadcrumb)|navigator\.(clipboard\.writeText|share|sendBeacon))$/;
  const URL_LEAD = /^(\/(?!\/)|https?:\/\/|mailto:|tel:|sms:)/;
  const linkNames = new Set();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.moduleSpecifier.text === 'next/link' && st.importClause && st.importClause.name) linkNames.add(st.importClause.name.text);
  }
  // href/to on a plain <a> or next/link's Link only (a custom component may derive an active class from href).
  const safeHrefAttr = (a) => /^(href|to)$/.test(a.name.getText(sf)) && (() => { const t = a.parent.parent.tagName.getText(sf); return t === 'a' || linkNames.has(t); })();
  const strip = (e) => { while (e && ts.isParenthesizedExpression(e)) e = e.expression; return e; };
  const leadsWithUrl = (e0) => {
    const e = strip(e0);
    if (!e) return false;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return URL_LEAD.test(e.text);
    if (ts.isTemplateExpression(e)) return URL_LEAD.test(e.head.text);
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === K.PlusToken) return leadsWithUrl(e.left);
    if (ts.isConditionalExpression(e)) return leadsWithUrl(e.whenTrue) && leadsWithUrl(e.whenFalse);
    return false;
  };
  // Walk up from an expression through value-preserving wrappers (parens, template, `+`, ternary branches, a call of it,
  // encodeURI*, an object property for log sinks) to where the value lands. -> { kind: 'url'|'log', top } or null.
  const landing = (x0, opts = {}) => {
    let x = x0, viaObject = false;
    for (let guard = 0; guard < 64; guard++) {
      const p = x.parent;
      if (!p) return null;
      if (ts.isParenthesizedExpression(p) || ts.isTemplateSpan(p) || ts.isTemplateExpression(p) || ts.isJsxExpression(p)
        || (ts.isBinaryExpression(p) && p.operatorToken.kind === K.PlusToken)
        || (ts.isConditionalExpression(p) && p.condition !== x)
        || (opts.callee && ts.isCallExpression(p) && p.expression === x)
        || (ts.isCallExpression(p) && /^encodeURI(Component)?$/.test(p.expression.getText(sf)) && p.arguments.includes(x))) { x = p; continue; }
      if (ts.isPropertyAssignment(p) && p.initializer === x && ts.isObjectLiteralExpression(p.parent)) { viaObject = true; x = p.parent; continue; }
      if (ts.isCallExpression(p) && p.arguments.includes(x)) {
        const callee = p.expression.getText(sf);
        if (LOG_SINK.test(callee)) return { kind: 'log', top: x };
        if (URL_SINK.test(callee) && !viaObject && p.arguments[0] === x) return { kind: 'url', top: x };
        return null;
      }
      if (ts.isJsxAttribute(p) && p.initializer === x) return !viaObject && safeHrefAttr(p) ? { kind: 'url', top: ts.isJsxExpression(x) ? x.expression : x } : null;
      if (ts.isBinaryExpression(p) && p.operatorToken.kind === K.EqualsToken && p.right === x && !viaObject
        && /^(window\.)?location(\.href)?$/.test(p.left.getText(sf))) return { kind: 'url', top: x };
      return null;
    }
    return null;
  };
  const urlishString = (n) => { const l = landing(n); return !!l && (l.kind === 'log' || leadsWithUrl(l.top)); };

  // Named handlers and URL builders: a non-exported, JSX-free binding whose every use sits in a quiet root (an on*
  // handler, href/key/ref, an effect) is a handler (H): recorded as quiet, exactly like an inline handler. One whose
  // every use lands in a URL/log position (above) is a URL builder (U): also quiet, and its strings are skipped. A
  // non-function value runs at render, so it can only be U; hook calls never qualify. Anything else: recorded in full.
  const candidates = new Map(); // name -> { stmt, fn, ok }
  const isFnInit = (e) => !!e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e)
    || (ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'useCallback' && e.arguments[0] && (ts.isArrowFunction(e.arguments[0]) || ts.isFunctionExpression(e.arguments[0]))));
  const callsHook = (n) => { let f = false; const w = (x) => { if (f) return; if (isFn(x)) return; if (ts.isCallExpression(x) && /^use[A-Z]/.test(x.expression.getText(sf).replace(/^.*\./, '')) && !(ts.isIdentifier(x.expression) && x.expression.text === 'useCallback' && x === n)) { f = true; return; } ts.forEachChild(x, w); }; w(n); return f; };
  const valueLeadsWithUrl = (init) => {
    let fn = init;
    if (ts.isCallExpression(fn) && fn.arguments[0]) fn = fn.arguments[0]; // useCallback(fn)
    if (!isFn(fn)) return leadsWithUrl(init);
    if (fn.body && !ts.isBlock(fn.body)) return leadsWithUrl(fn.body);
    const rets = []; const w = (x) => { if (x !== fn && isFn(x)) return; if (ts.isReturnStatement(x)) rets.push(x.expression); ts.forEachChild(x, w); }; if (fn.body) w(fn.body);
    return rets.length > 0 && rets.every((r) => r && leadsWithUrl(r));
  };
  if (logicOn) {
    const addCand = (x) => {
      if (exported(x) || hasJsx(x)) return;
      if (ts.isFunctionDeclaration(x) && x.name && x.body) candidates.set(x.name.text, { stmt: x, fn: true, urlLead: valueLeadsWithUrl(x), dup: candidates.has(x.name.text) });
      else if (ts.isVariableStatement(x) && x.declarationList.declarations.length === 1) {
        const d = x.declarationList.declarations[0];
        if (!ts.isIdentifier(d.name) || !d.initializer) return;
        const fn = isFnInit(d.initializer);
        if (!fn && callsHook(d.initializer)) return;
        candidates.set(d.name.text, { stmt: x, fn, urlLead: valueLeadsWithUrl(d.initializer), dup: candidates.has(d.name.text) });
      }
    };
    const w = (x) => { if (ts.isFunctionDeclaration(x) || ts.isVariableStatement(x)) addCand(x); ts.forEachChild(x, w); };
    w(sf);
    for (const [k, c] of [...candidates]) if (c.dup) candidates.delete(k); // two bindings, one name: cannot tell them apart
  }
  const H = new Set(), U = new Set();
  if (candidates.size) {
    const uses = new Map(); // name -> [{ q, url, owner }]
    const declName = (x) => { const p = x.parent; return p && (ts.isFunctionDeclaration(p) || ts.isVariableDeclaration(p)) && p.name === x; };
    const notRef = (x) => { const p = x.parent; return p && ((ts.isPropertyAccessExpression(p) && p.name === x) || (ts.isPropertyAssignment(p) && p.name === x) || (ts.isJsxAttribute(p) && p.name === x)); };
    const walk = (x, q, owner) => {
      if (isQuietRoot(x)) q = true;
      const own = (ts.isFunctionDeclaration(x) && x.name && candidates.get(x.name.text)?.stmt === x && x.name.text)
        || (ts.isVariableStatement(x) && x.declarationList.declarations.length === 1 && ts.isIdentifier(x.declarationList.declarations[0].name)
          && candidates.get(x.declarationList.declarations[0].name.text)?.stmt === x && x.declarationList.declarations[0].name.text);
      if (own) owner = own;
      if (ts.isIdentifier(x) && candidates.has(x.text) && !(declName(x) && candidates.get(x.text).stmt === (ts.isVariableDeclaration(x.parent) ? x.parent.parent.parent : x.parent)) && !notRef(x)) {
        const l = landing(x, { callee: true });
        const direct = l && (strip(l.top) === x || (ts.isCallExpression(strip(l.top)) && strip(l.top).expression === x));
        const url = !!l && (l.kind === 'log' || direct || leadsWithUrl(l.top));
        if (!uses.has(x.text)) uses.set(x.text, []);
        uses.get(x.text).push({ q, url, owner });
      }
      ts.forEachChild(x, (c) => walk(c, q, owner));
    };
    walk(sf, false, null);
    for (const [name, c] of candidates) {
      if (!uses.has(name)) continue; // unused: recorded in full
      if (c.fn) H.add(name);
      if (c.urlLead) U.add(name);
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const name of [...H]) if (!uses.get(name).every((u) => u.q || (u.owner && u.owner !== name && H.has(u.owner)) || u.owner === name)) { H.delete(name); changed = true; }
      for (const name of [...U]) if (!uses.get(name).every((u) => u.url || (u.owner && U.has(u.owner)))) { U.delete(name); changed = true; }
    }
  }
  const bindingName = (n) => (ts.isFunctionDeclaration(n) && n.name && candidates.get(n.name.text)?.stmt === n && n.name.text)
    || (ts.isVariableStatement(n) && n.declarationList.declarations.length === 1 && ts.isIdentifier(n.declarationList.declarations[0].name)
      && candidates.get(n.declarationList.declarations[0].name.text)?.stmt === n && n.declarationList.declarations[0].name.text) || null;
  let urlQuiet = 0;
  const visit = (n) => {
    const bn = candidates.size ? bindingName(n) : null;
    if (bn && U.has(bn)) { quiet++; urlQuiet++; try { inner(n); } finally { quiet--; urlQuiet--; } return; }
    if (bn && H.has(bn)) { quiet++; try { inner(n); } finally { quiet--; } return; }
    if (isQuietRoot(n)) { quiet++; try { inner(n); } finally { quiet--; } return; }
    inner(n);
  };
  const inner = (n) => {
    // `class X extends A`: the base class is an expression, not a type.
    const heritage = ts.isExpressionWithTypeArguments(n) && n.parent && n.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(n.parent.parent);
    if (heritage) { out.push('extends', n.expression.getText(sf)); return; }
    // BRO-7902: a text-formatting helper (format*, no JSX, no DOM/class writes) changes the characters shown, not the layout.
    // Only its name is recorded: its body (date strings, month tables) and a `const formatX = formatY` alias are skipped.
    // Call sites stay in the skeleton in full, and a body that contains JSX or touches style/class stays design.
    const vdecl = ts.isVariableStatement(n) && n.declarationList.declarations.length === 1 ? n.declarationList.declarations[0] : null;
    const fmtName = (ts.isFunctionDeclaration(n) && n.name && n.name.text)
      || (vdecl && ts.isIdentifier(vdecl.name) && vdecl.initializer
        && (ts.isArrowFunction(vdecl.initializer) || ts.isFunctionExpression(vdecl.initializer) || (ts.isIdentifier(vdecl.initializer) && FORMAT_NAME.test(vdecl.initializer.text))) && vdecl.name.text);
    if (fmtName && FORMAT_NAME.test(fmtName) && !quiet && n.parent === sf && !hasJsx(n) && !DOM_WRITE.test(n.getText(sf)) && !ELEMENT_BUILD.test(n.getText(sf)) && !visualUse.has(fmtName)
      && !(ts.isFunctionDeclaration(n) && n.modifiers && n.modifiers.some((m) => m.kind === K.DefaultKeyword))) { out.push(`fmt ${fmtName}`); return; }
    if (ts.isTypeNode(n) || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) return;
    if (ts.isImportDeclaration(n)) {
      const mod = ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : '?';
      const c = n.importClause;
      if (!c) { out.push(`import ${mod}`); return; } // side-effect import (CSS etc.)
      if (c.name) imports.set(c.name.text, `${mod}::default`);
      if (c.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) imports.set(c.namedBindings.name.text, `${mod}::*`);
        else c.namedBindings.elements.forEach((el) => imports.set(el.name.text, `${mod}::${(el.propertyName || el.name).text}`));
      }
      if (/\.(css|scss|sass)$/.test(mod)) out.push(`import ${mod}`);
      return;
    }
    if (ts.isExportDeclaration(n)) { out.push(`export ${n.moduleSpecifier ? n.moduleSpecifier.getText(sf) : ''} ${norm(n.exportClause ? n.exportClause.getText(sf) : '*')}`); return; }
    if (ts.isJsxText(n)) return; // copy is not design
    // `useEffect(...)` as a statement: adding or removing one draws nothing, so the statement wrapper is not recorded.
    if (ts.isExpressionStatement(n) && !quiet && isQuietRoot(n.expression)) { visit(n.expression); return; }
    if (quiet) {
      // Logic only: strings still count (a class set through the DOM), and so does any DOM style/class write.
      if (ts.isExpressionStatement(n) && DOM_WRITE.test(n.getText(sf))) { out.push(`dom ${norm(n.getText(sf))}`); return; }
      if (ts.isCallExpression(n) && STATE_CALL.test(n.expression.getText(sf))) { out.push(`call ${norm(n.getText(sf))}`); return; }
      // BRO-8177: a string inside a URL builder, or one that lands in a URL/log/analytics position, draws nothing.
      const silent = logicOn && (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) && (urlQuiet > 0 || urlishString(n));
      if (silent) { /* not recorded; the template's ${} expressions are still visited below */ }
      else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(`"${norm(n.text)}"`);
      else if (ts.isTemplateExpression(n)) out.push(`\`${[n.head.text, ...n.templateSpans.map((x) => x.literal.text)].map(norm).join('${}')}\``);
      else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
        // A render prop (onRenderItem={() => <B big={true}/>}) draws: its element's own attributes count in full.
        out.push(`<${n.tagName.getText(sf)}`);
        const q = quiet; quiet = 0;
        try { ts.forEachChild(n, visit); } finally { quiet = q; }
        return;
      }
      ts.forEachChild(n, visit);
      return;
    }
    const insertable = insertableAwait(n) || (ts.isParenthesizedExpression(n) && insertableAwait(n.expression)) || insertableAsync(n);
    if (insertable && awaitExemptOn) insertableIdx.add(out.length);
    out.push(K[n.kind]);
    if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) out.push(`op${n.operator}`);
    if (ts.isIdentifier(n) || ts.isPrivateIdentifier(n)) out.push(n.text);
    else if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(norm(n.text));
    else if (ts.isNumericLiteral(n) || ts.isBigIntLiteral(n) || ts.isRegularExpressionLiteral(n)) out.push(n.text);
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(norm(n.text));
    else if (ts.isExpressionStatement(n) && ts.isStringLiteral(n.expression) && /^use (client|server)$/.test(n.expression.text)) out.push(n.expression.text);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  out.imports = imports;
  out.insertable = insertableIdx;
  return out;
}

/**
 * BRO-8169: is `after` equal to `before` with only insertable tokens (indexes in after.insertable) added? Insert-only
 * on purpose: every token present before must still be present after (a removed await stays design). A greedy walk is enough:
 * whenever it succeeds it has found such an embedding, and when it fails we fail closed.
 * -> { ok, added, at } (at = first token that broke the match).
 */
function insertOnlyMatch(before, after) {
  const insertable = after.insertable || new Set();
  let i = 0, j = 0, added = 0;
  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) { i++; j++; continue; }
    if (j < after.length && insertable.has(j)) { j++; added++; continue; }
    return { ok: false, added, at: after[j] || before[i] || '' };
  }
  return { ok: true, added, at: '' };
}

/** -> { design: boolean, reason } for one file. oldSource/newSource null = file absent on that side. */
function classifyFile({ file, oldSource, newSource, env = process.env }) {
  const design = (reason) => ({ design: true, reason });
  if (!/^src\/.*\.(tsx|jsx)$/.test(file)) return design('style or config file (CSS/SCSS/Tailwind/PostCSS)');
  if (typeof oldSource !== 'string') return design('new file');
  if (typeof newSource !== 'string') return design('deleted file');
  const ts = loadTs();
  if (!ts) return design('typescript not installed (fail closed)');
  try {
    const a = parse(ts, file, oldSource);
    const b = parse(ts, file, newSource);
    if (!a || !b) return design('does not parse (fail closed)');
    const sa = skeleton(ts, a, env);
    const sb = skeleton(ts, b, env);
    // A binding present on both sides that now points somewhere else (a swapped icon, component or constant) changes what draws.
    for (const [name, target] of sa.imports) if (sb.imports.has(name) && sb.imports.get(name) !== target) return design(`import ${name} now points at a different module or export`);
    const m = insertOnlyMatch(sa, sb);
    if (m.ok) return { design: false, reason: m.added ? `page structure and style tokens unchanged (only ${m.added} await/async added)` : 'page structure and style tokens unchanged' };
    return design(`layout/style changed near ${JSON.stringify((m.at || '').slice(0, 60))}`);
  } catch (e) {
    return design(`classifier error (fail closed): ${e && e.message}`);
  }
}

const gitIn = (cwd) => (args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/** Design files among `files` for a base...head range. Fail closed: any error returns every file. */
function designFiles(range, files, cwd, env = process.env) {
  try {
    const git = gitIn(cwd);
    const [baseRef, headRef] = range.split('...');
    const base = git(['merge-base', baseRef, headRef]).trim();
    const show = (ref, f) => { try { return git(['show', `${ref}:${f}`]); } catch { return null; } };
    const out = [];
    for (const f of files) {
      const r = classifyFile({ file: f, oldSource: show(base, f), newSource: show(headRef, f), env });
      if (r.design) out.push({ file: f, reason: r.reason });
    }
    return out;
  } catch {
    return files.map((f) => ({ file: f, reason: 'could not read the diff (fail closed)' }));
  }
}

/**
 * May this UI diff ship on the session's own visual QA, with no owner yes?
 * -> { allowed, reason, design: [{file, reason}] }. Never throws.
 */
function selfClear({ cwd, range = 'origin/main...HEAD', verdict = null, env = process.env }) {
  const no = (reason, design = []) => ({ allowed: false, reason, design });
  try {
    if (env.VISUAL_FIX_SELF_CLEAR_DISABLED === '1') return no('self-clear disabled (VISUAL_FIX_SELF_CLEAR_DISABLED=1)');
    const D = require('./visual-approval-durable.js');
    const [baseRef, headRef] = range.split('...');
    const files = gitIn(cwd)(['diff', '--name-only', '--no-renames', range]).split('\n').filter((f) => f && D.UI_RE.test(f));
    if (!files.length) return no('no UI files in the diff');
    const design = designFiles(range, files, cwd, env);
    if (design.length) return no('design change: the owner approves how it looks', design);
    if (!verdict) return no('fix-only, but no visual-qa verdict yet');
    if (String(verdict.schemaVersion) !== '2') return no('fix-only, but the verdict is an old schema');
    if (verdict.overallPass !== true) return no('fix-only, but the visual check did not pass');
    const current = D.uiPatchId(cwd, headRef, baseRef);
    if (!verdict.uiPatchId || !current || verdict.uiPatchId !== current) return no('fix-only, but the verdict is for a different version of the UI diff: re-run /visual-qa');
    return { allowed: true, reason: `fix-only UI change (${files.length} file(s): structure and style unchanged) with a passing, current visual-qa verdict`, design: [] };
  } catch (e) {
    return no(`self-clear error (fail closed): ${e && e.message}`);
  }
}

/** One line for gate messages: who decides this push. */
function explain(r) {
  if (r.allowed) return `Fix-only UI change: ${r.reason}. No owner yes needed.`;
  if (r.design.length) {
    const d = r.design[0];
    return `Design change (${d.file}: ${d.reason}${r.design.length > 1 ? `; +${r.design.length - 1} more` : ''}): the owner's yes is needed after the screenshots.`;
  }
  if (/^fix-only/.test(r.reason)) return `Fix-only UI change (no layout or style change): do NOT ask the owner. ${r.reason.replace(/^fix-only, but /, 'Still needed: ')}; once /visual-qa passes on this exact diff, the push clears by itself.`;
  return `Owner yes needed: ${r.reason}.`;
}

module.exports = { classifyFile, _insertOnlyMatch: insertOnlyMatch, designFiles, selfClear, explain, _skeleton: skeleton, _parse: parse, _loadTs: loadTs };

if (require.main === module) {
  const opt = {};
  for (const a of process.argv.slice(2)) { const m = a.match(/^--([\w-]+)(?:=(.*))?$/); if (m) opt[m[1]] = m[2] === undefined ? true : m[2]; }
  const range = opt.range || 'origin/main...HEAD';
  let verdict = null;
  if (opt.verdict) { try { verdict = JSON.parse(fs.readFileSync(path.resolve(opt.verdict), 'utf8')); } catch { verdict = null; } }
  const r = selfClear({ cwd: process.cwd(), range, verdict });
  if (opt.explain) { process.stdout.write(explain(r) + '\n'); process.exit(0); }
  process.stdout.write(JSON.stringify(r) + '\n');
  process.exit(opt['self-clear'] && r.allowed ? 0 : 1);
}
