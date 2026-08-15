#!/usr/bin/env node
/**
 * Task #1625 / Notion 3bd637c5: CI detector for the "delete-without-breadcrumb"
 * bug class fixed by hand 3 times now (#1618, #1624 x2): a script does
 * `delete data.X` on a field with no scripts/lib/review-write-guard.js
 * CLEAR_BREADCRUMBS entry, then calls safeWriteReview(filePath, data) with
 * default options (merge:true, force:false). safeWriteReview's merge-mode
 * restore pass (the "keep any existing field not in newData" loop) then
 * silently reverts the delete on every subsequent run against a file that
 * already has a value for that field on disk — the clear never sticks.
 *
 * Unlike scripts/audit-same-job-breadcrumb-coverage.js (which flags a
 * force:true clear missing a breadcrumb — the "clear lands, then gets
 * resurrected by a LATER same-job push-review-texts restore" shape), this
 * script flags the opposite and more common mistake: a delete with NO
 * force:true at all, where safeWriteReview's OWN merge pass undoes the clear
 * on its very next invocation, no CI restore step required.
 *
 * DETECTION METHOD: a real (acorn) AST walk, not text regex — per-function
 * scoping (the hard part per the card) is exactly what a parser gives for
 * free and a brace-counting regex has to reinvent. For every
 * `delete <var>.<field>` expression, finds its innermost enclosing function
 * (or the top-level Program, for scripts with no function wrapper), then
 * looks for a `safeWriteReview(<path>, <var>, ...)` call in THAT SAME scope
 * — closest one by source position wins, mirroring "the enclosing function's
 * nearest safeWriteReview(...) call" from the card's suggested approach.
 * Flags when that call has no `force: true` and CLEAR_BREADCRUMBS has no
 * entry for `field`. A file with zero safeWriteReview calls anywhere (raw
 * fs.writeFileSync only) is never flagged — that write path isn't vulnerable
 * to this bug class at all.
 *
 * Heuristic by nature (a delete/call pair in the SAME scope operating on
 * identically-named variables is assumed related — no true data-flow
 * analysis), so false positives/negatives are possible; wired as advisory
 * (non-blocking) initially per the card, consistent with
 * audit-same-job-breadcrumb-coverage.js's own precedent for this bug family.
 *
 * FAILS OPEN: a file that fails to parse (syntax error, unsupported syntax)
 * is skipped, not crashed on — this must never break CI on an unrelated file.
 *
 * Exemption (reviewed false positive): add
 *   // breadcrumb-delete-ok: <reason>
 * anywhere in the offending file.
 *
 * Usage:
 *   node scripts/audit-delete-without-breadcrumb.js            scan scripts/*.js, report
 *   node scripts/audit-delete-without-breadcrumb.js --help, -h  print this usage and exit
 */
const fs = require('fs');
const path = require('path');

const SCRIPTS_DIR = __dirname;
const EXEMPTION = 'breadcrumb-delete-ok';
const HELP_RE = /^(--help|-h)$/;

const USAGE = `audit-delete-without-breadcrumb.js — detects delete-then-safeWriteReview() sites
with no force:true and no CLEAR_BREADCRUMBS entry for the deleted field (task #1625).

Usage:
  node scripts/audit-delete-without-breadcrumb.js       scan scripts/*.js, report findings
  node scripts/audit-delete-without-breadcrumb.js --help, -h   print this usage and exit
`;

if (process.argv.slice(2).some((a) => HELP_RE.test(a))) { console.log(USAGE); process.exit(0); }

function loadAcorn() {
  try {
    return { acorn: require('acorn'), walk: require('acorn-walk') };
  } catch {
    return null;
  }
}

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/**
 * Parse `src` and return { deletes, calls, error }. Fails open (returns
 * error, no throw) on unparseable source — a shebang is stripped first since
 * acorn's `script`/`module` parse has no allowHashBang option prior to full
 * ecma2023 support in this acorn version.
 *
 * deletes: [{ objName, field, start }]
 * calls:   [{ objName, hasForceTrue, start }]  (only safeWriteReview(...) calls
 *          whose 2nd argument is a bare identifier)
 * Both arrays also carry `scopeStart`/`scopeEnd` — the [start,end) range of
 * the innermost enclosing function body (or the whole Program for top-level
 * code), used to group deletes with same-scope calls.
 */
function analyzeSource(src) {
  const loaders = loadAcorn();
  if (!loaders) return { deletes: [], calls: [], error: 'acorn not installed' };
  const { acorn, walk } = loaders;

  const stripped = src.replace(/^#![^\n]*\n/, '');
  let ast;
  try {
    ast = acorn.parse(stripped, { ecmaVersion: 2022, sourceType: 'script', allowReturnOutsideFunction: true });
  } catch {
    try {
      ast = acorn.parse(stripped, { ecmaVersion: 2022, sourceType: 'module' });
    } catch (e2) {
      return { deletes: [], calls: [], error: e2.message };
    }
  }

  // Every function-like node (plus Program) with a body range, so each
  // delete/call can be attributed to its innermost enclosing scope by simply
  // picking the SMALLEST range that contains its start position.
  const scopes = [{ node: ast, start: ast.start, end: ast.end }];
  const deletes = [];
  const calls = [];

  walk.full(ast, (node) => {
    if (FUNCTION_TYPES.has(node.type) && node.body) {
      scopes.push({ node, start: node.body.start, end: node.body.end });
      return;
    }

    // delete <ident>.<field>  (skip computed member access — delete obj[x]
    // can't be resolved to a static field name)
    if (node.type === 'UnaryExpression' && node.operator === 'delete'
      && node.argument && node.argument.type === 'MemberExpression'
      && !node.argument.computed
      && node.argument.object.type === 'Identifier'
      && node.argument.property.type === 'Identifier') {
      deletes.push({
        objName: node.argument.object.name,
        field: node.argument.property.name,
        start: node.start,
      });
      return;
    }

    // safeWriteReview(<path>, <dataVar>, [<opts>])
    if (node.type === 'CallExpression' && node.callee.type === 'Identifier'
      && node.callee.name === 'safeWriteReview') {
      const args = node.arguments;
      if (args.length >= 2 && args[1].type === 'Identifier') {
        let hasForceTrue = false;
        if (args.length >= 3 && args[2].type === 'ObjectExpression') {
          hasForceTrue = args[2].properties.some((p) => (
            p.type === 'Property'
            && !p.computed
            && ((p.key.type === 'Identifier' && p.key.name === 'force')
              || (p.key.type === 'Literal' && p.key.value === 'force'))
            && p.value.type === 'Literal' && p.value.value === true
          ));
        }
        calls.push({ objName: args[1].name, hasForceTrue, start: node.start });
      }
    }
  });

  // Attribute each delete/call to its innermost (smallest-range) enclosing
  // scope. Scopes are pushed outer-to-inner-ish via a pre-order walk, but not
  // guaranteed sorted by size, so an explicit smallest-containing-range scan
  // is used rather than relying on push order.
  const scopeOf = (pos) => {
    let best = null;
    for (const s of scopes) {
      if (pos >= s.start && pos < s.end) {
        if (!best || (s.end - s.start) < (best.end - best.start)) best = s;
      }
    }
    return best;
  };
  for (const d of deletes) { const s = scopeOf(d.start); d.scopeStart = s ? s.start : -1; d.scopeEnd = s ? s.end : -1; }
  for (const c of calls) { const s = scopeOf(c.start); c.scopeStart = s ? s.start : -1; c.scopeEnd = s ? s.end : -1; }

  return { deletes, calls, error: null };
}

/**
 * For one file's { deletes, calls }, return the flaggable sites: a delete
 * whose same-scope, same-var, NEAREST-by-position safeWriteReview() call
 * lacks force:true, and whose field has no CLEAR_BREADCRUMBS entry.
 *
 * A file with zero safeWriteReview calls anywhere is never flagged (writes
 * via raw fs.writeFileSync, unaffected by this bug class) — callers should
 * check `calls.length === 0` themselves; this function only handles the
 * per-delete matching once that gate has passed.
 */
function findUnprotectedDeletes(deletes, calls, breadcrumbKeys) {
  const findings = [];
  for (const d of deletes) {
    const candidates = calls.filter((c) => c.objName === d.objName && c.scopeStart === d.scopeStart && c.scopeEnd === d.scopeEnd);
    if (candidates.length === 0) continue; // no matching call in this scope — nothing to attribute to, skip (avoid noise)
    let nearest = candidates[0];
    let nearestDist = Math.abs(candidates[0].start - d.start);
    for (const c of candidates.slice(1)) {
      const dist = Math.abs(c.start - d.start);
      if (dist < nearestDist) { nearest = c; nearestDist = dist; }
    }
    if (nearest.hasForceTrue) continue; // intentional overwrite — safe
    if (breadcrumbKeys.has(d.field)) continue; // registered clear breadcrumb — safe
    findings.push({ field: d.field, objName: d.objName, deleteStart: d.start, callStart: nearest.start });
  }
  return findings;
}

function lineOf(src, offset) {
  return src.slice(0, offset).split('\n').length;
}

/**
 * Scan a single file's source for findings. Returns [] for a file with no
 * safeWriteReview calls at all, or one that fails to parse (fails open).
 */
function checkFile(src, breadcrumbKeys) {
  if (src.includes(EXEMPTION)) return [];
  const { deletes, calls, error } = analyzeSource(src);
  if (error || calls.length === 0) return [];
  const raw = findUnprotectedDeletes(deletes, calls, breadcrumbKeys);
  return raw.map((f) => ({ ...f, deleteLine: lineOf(src, f.deleteStart), callLine: lineOf(src, f.callStart) }));
}

/**
 * Scan every scripts/*.js file (non-recursive — matches the card's own
 * "grep all scripts/*.js" scope) for delete-without-breadcrumb sites.
 *
 * @returns {{ findings: object[], scanned: { files: number, filesWithSafeWrite: number } }}
 */
function auditRepo({ scriptsDir, breadcrumbKeys }) {
  const files = fs.readdirSync(scriptsDir).filter((f) => f.endsWith('.js')).sort();
  const findings = [];
  let filesWithSafeWrite = 0;

  for (const file of files) {
    const abs = path.join(scriptsDir, file);
    const src = fs.readFileSync(abs, 'utf8');
    if (src.includes(EXEMPTION)) continue;
    const { deletes, calls, error } = analyzeSource(src);
    if (error || calls.length === 0) continue;
    filesWithSafeWrite++;
    const raw = findUnprotectedDeletes(deletes, calls, breadcrumbKeys);
    for (const f of raw) {
      findings.push({
        file,
        field: f.field,
        deleteLine: lineOf(src, f.deleteStart),
        callLine: lineOf(src, f.callStart),
      });
    }
  }

  return { findings, scanned: { files: files.length, filesWithSafeWrite } };
}

function main() {
  if (!loadAcorn()) {
    console.error('🚨 Delete-without-breadcrumb guard cannot run: acorn is not installed. Run `npm ci` and re-run.');
    process.exitCode = 1;
    return;
  }

  const { PROTECTED_FIELDS: _unused, CLEAR_BREADCRUMBS } = require('./lib/review-write-guard');
  const breadcrumbKeys = new Set(Object.keys(CLEAR_BREADCRUMBS));

  const { findings, scanned } = auditRepo({ scriptsDir: SCRIPTS_DIR, breadcrumbKeys });

  if (findings.length === 0) {
    console.log(`✅ Delete-without-breadcrumb guard: no violations (${scanned.filesWithSafeWrite}/${scanned.files} scripts call safeWriteReview).`);
    return;
  }

  console.log(`⚠️  Delete-without-breadcrumb guard — ${findings.length} site(s) where a delete has no matching`);
  console.log('CLEAR_BREADCRUMBS entry, and the nearest safeWriteReview() call in the same scope has no force:true.');
  console.log('safeWriteReview\'s merge-mode restore pass will silently revert this delete on its very next run,');
  console.log('the exact bug class fixed by hand in #1618/#1624. See scripts/lib/review-write-guard.js.\n');
  console.log('This is advisory (heuristic, non-blocking) — verify manually before fixing.\n');
  for (const f of findings) {
    console.log(`  • scripts/${f.file}:${f.deleteLine} deletes "${f.field}" — safeWriteReview() at line ${f.callLine} has no force:true, and "${f.field}" has no CLEAR_BREADCRUMBS entry`);
  }
  console.log(`\nFix: either pass { force: true } to the safeWriteReview() call (if this is an intentional overwrite),`);
  console.log(`or register a CLEAR_BREADCRUMBS[field] predicate in scripts/lib/review-write-guard.js (see`);
  console.log(`duplicateTextOf / wrongAttributionReason for the pattern), or null-assign instead of delete if the field`);
  console.log(`should never be protected (null survives safeWriteReview's undefined-only merge check).`);
  console.log(`Exempt (false positive): add  // ${EXEMPTION}: <reason>  anywhere in the file.\n`);
  // Advisory only — never fails CI (see header).
}

if (require.main === module) {
  main();
}

module.exports = {
  analyzeSource,
  findUnprotectedDeletes,
  checkFile,
  auditRepo,
  main,
  EXEMPTION,
};
