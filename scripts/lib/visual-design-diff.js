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
//      name, the value of every literal attribute (string, number, boolean, object literal), the full expression of
//      any style attribute (className, class, style, sx, tw, css, variant, size, ...), every string literal anywhere
//      in the file that holds a Tailwind-like utility token, every className/style object key, CSS imports and
//      'use client'/'use server' directives. JSX text (copy) and the logic inside {expressions} are NOT in it, so
//      a changed condition, handler, href or data path is a fix; a moved, added or removed element, a changed
//      class or style, or a changed literal prop is design.
//
// One entry point (selfClear) is shared by .claude/hooks/pre-push-visual-gate.sh, scripts/land-ready.mjs and
// scripts/visual-approval.js so the three never disagree. Kill switch: VISUAL_FIX_SELF_CLEAR_DISABLED=1.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

let _ts = null;
function loadTs() {
  if (_ts) return _ts;
  // Only this checkout's parser: a pushed branch must not supply it.
  try { _ts = require(require.resolve('typescript', { paths: [__dirname] })); return _ts; } catch { return null; }
}

const STYLE_ATTR = /^(className|class|style|sx|tw|css|variant|size|tone|color|layout|align|position|width|height|src|srcSet|fill|priority|sizes|columns|cols|rows|gap|as)$/;
// A whitespace-separated token that reads as a utility class (after variant prefixes such as sm: or hover:).
const UTIL_TOKEN = /^-?(?:(?:bg|text|border|ring|shadow|rounded|p[xytrbl]?|m[xytrbl]?|w|h|size|min-w|max-w|min-h|max-h|gap(?:-[xy])?|space-[xy]|grid-cols|grid-rows|col-span|row-span|font|leading|tracking|opacity|z|top|left|right|bottom|inset(?:-[xy])?|translate-[xy]|scale|rotate|order|basis|line-clamp|divide(?:-[xy])?|outline|fill|stroke|from|to|via|aspect|columns|decoration|underline-offset|items|justify|self|content|place-(?:items|content|self)|whitespace|overflow(?:-[xy])?|object|transition|duration|ease|delay|animate|cursor|select|pointer-events|shrink|grow|flex|grid|blur|backdrop|drop-shadow|ms|me|ps|pe|start|end)-[\w./\[\]%#():,-]+|flex|grid|hidden|block|inline|inline-flex|inline-block|inline-grid|contents|table|truncate|italic|uppercase|lowercase|capitalize|underline|sr-only|not-sr-only|absolute|relative|fixed|sticky|static|visible|invisible|container|grow|shrink|antialiased)$/;
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

function hasUtilityToken(s) {
  return String(s).split(/\s+/).some((t) => t && UTIL_TOKEN.test(t.replace(/^(?:[\w-]+:|\[[^\]]*\]:)+/, '').replace(/^!/, '')));
}

function parse(ts, file, text) {
  const kind = /\.jsx$/.test(file) ? ts.ScriptKind.JSX : ts.ScriptKind.TSX;
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  if (!Array.isArray(sf.parseDiagnostics) || sf.parseDiagnostics.length) return null;
  return sf;
}

function isLiteral(ts, e) {
  if (!e) return false;
  const K = ts.SyntaxKind;
  return ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e) || ts.isObjectLiteralExpression(e)
    || ts.isArrayLiteralExpression(e) || e.kind === K.TrueKeyword || e.kind === K.FalseKeyword || e.kind === K.NullKeyword
    || (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand));
}

/** The layout/style skeleton of one source file, as an array of tokens. */
function skeleton(ts, sf) {
  const out = [];
  const attr = (a) => {
    if (ts.isJsxSpreadAttribute(a)) { out.push(`{...${norm(a.expression.getText(sf))}}`); return; }
    const name = a.name.getText(sf);
    const init = a.initializer;
    if (!init) { out.push(name); return; }
    if (ts.isStringLiteral(init)) { out.push(`${name}=${JSON.stringify(init.text)}`); return; }
    const e = ts.isJsxExpression(init) ? init.expression : init;
    if (STYLE_ATTR.test(name) || isLiteral(ts, e)) out.push(`${name}={${e ? norm(e.getText(sf)) : ''}}`);
    else out.push(`${name}={}`);
  };
  const visit = (n) => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      out.push(`<${n.tagName.getText(sf)}`);
      for (const a of n.attributes.properties) attr(a);
      out.push(ts.isJsxSelfClosingElement(n) ? '/>' : '>');
      // Attribute expressions can hold nested JSX (render props): walk them too, but only the JSX inside.
      for (const a of n.attributes.properties) {
        const e = ts.isJsxSpreadAttribute(a) ? a.expression : a.initializer;
        if (e) ts.forEachChild(e, visit);
      }
      return;
    }
    if (ts.isJsxClosingElement(n)) { out.push(`</${n.tagName.getText(sf)}>`); return; }
    if (ts.isJsxOpeningFragment(n)) { out.push('<>'); return; }
    if (ts.isJsxClosingFragment(n)) { out.push('</>'); return; }
    if (ts.isJsxText(n)) return; // copy is not design
    if (ts.isJsxExpression(n) && n.parent && (ts.isJsxElement(n.parent) || ts.isJsxFragment(n.parent))) {
      out.push('{');
      ts.forEachChild(n, visit);
      out.push('}');
      return;
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && hasUtilityToken(n.text)) out.push(`"${norm(n.text)}"`);
    if (ts.isTemplateExpression(n)) {
      const parts = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)];
      if (parts.some(hasUtilityToken)) out.push(`\`${norm(n.getText(sf))}\``);
    }
    if (ts.isPropertyAssignment(n) && /^['"]?(className|class|style)['"]?$/.test(n.name.getText(sf))) out.push(`${n.name.getText(sf)}:${norm(n.initializer.getText(sf))}`);
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && /\.(css|scss|sass)$/.test(n.moduleSpecifier.text)) out.push(`import ${n.moduleSpecifier.text}`);
    if (ts.isExpressionStatement(n) && ts.isStringLiteral(n.expression) && /^use (client|server)$/.test(n.expression.text)) out.push(`'${n.expression.text}'`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
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

module.exports = { classifyFile, designFiles, selfClear, explain, hasUtilityToken, _skeleton: skeleton, _parse: parse, _loadTs: loadTs };

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
