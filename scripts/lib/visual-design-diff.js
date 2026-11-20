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
function skeleton(ts, sf) {
  const out = [];
  const imports = new Map(); // local binding -> "module::importedName"
  const K = ts.SyntaxKind;
  const QUIET_ATTR = /^(on[A-Z]\w*|key|ref|href|to)$/;
  const QUIET_DOM_ATTR = /^(name|htmlFor)$/; // quiet on intrinsic (lowercase) tags only: <Icon name={x}/> picks what draws
  const DOM_WRITE = /\b(style|className|classList|cssText|dataset|innerHTML|outerHTML|textContent|insertAdjacentHTML|hidden|open|scrollTop|scrollLeft)\b|\.(setProperty|setAttribute|toggle|add|remove|showModal|close|show|scrollTo)\(/;
  // Inside quiet roots a state setter or timer still decides what shows (setS(true), a 99999ms delay): recorded in full.
  const STATE_CALL = /^(?:[\w$.?]*\.)?(set[A-Z]\w*|dispatch|setTimeout|setInterval|requestAnimationFrame)$/;
  let quiet = 0;
  const isQuietRoot = (n) => (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && /^use(Layout|Insertion)?Effect$/.test(n.expression.text))
    || (ts.isJsxAttribute(n) && (QUIET_ATTR.test(n.name.getText(sf)) || (QUIET_DOM_ATTR.test(n.name.getText(sf)) && /^[a-z]/.test(n.parent.parent.tagName.getText(sf)))));
  const visit = (n) => {
    if (isQuietRoot(n)) { quiet++; try { inner(n); } finally { quiet--; } return; }
    inner(n);
  };
  const inner = (n) => {
    // `class X extends A`: the base class is an expression, not a type.
    const heritage = ts.isExpressionWithTypeArguments(n) && n.parent && n.parent.token === ts.SyntaxKind.ExtendsKeyword && ts.isClassLike(n.parent.parent);
    if (heritage) { out.push('extends', n.expression.getText(sf)); return; }
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
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(`"${norm(n.text)}"`);
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
  return out;
}

/** -> { design: boolean, reason } for one file. oldSource/newSource null = file absent on that side. */
function classifyFile({ file, oldSource, newSource }) {
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
    const sa = skeleton(ts, a);
    const sb = skeleton(ts, b);
    // A binding present on both sides that now points somewhere else (a swapped icon, component or constant) changes what draws.
    for (const [name, target] of sa.imports) if (sb.imports.has(name) && sb.imports.get(name) !== target) return design(`import ${name} now points at a different module or export`);
    if (sa.length === sb.length && sa.every((t, i) => t === sb[i])) return { design: false, reason: 'page structure and style tokens unchanged' };
    let i = 0;
    while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
    return design(`layout/style changed near ${JSON.stringify((sb[i] || sa[i] || '').slice(0, 60))}`);
  } catch (e) {
    return design(`classifier error (fail closed): ${e && e.message}`);
  }
}

const gitIn = (cwd) => (args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

/** Design files among `files` for a base...head range. Fail closed: any error returns every file. */
function designFiles(range, files, cwd) {
  try {
    const git = gitIn(cwd);
    const [baseRef, headRef] = range.split('...');
    const base = git(['merge-base', baseRef, headRef]).trim();
    const show = (ref, f) => { try { return git(['show', `${ref}:${f}`]); } catch { return null; } };
    const out = [];
    for (const f of files) {
      const r = classifyFile({ file: f, oldSource: show(base, f), newSource: show(headRef, f) });
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
    const design = designFiles(range, files, cwd);
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

module.exports = { classifyFile, designFiles, selfClear, explain, _skeleton: skeleton, _parse: parse, _loadTs: loadTs };

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
