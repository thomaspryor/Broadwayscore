/**
 * BRO-5652: source audit for review-text writers that set fullText without a
 * textFetchedAt stamp. isTruncatedScoreNowComplete (rescore-flagging.js) can
 * only see that a complete text landed after a truncated-text score when the
 * file says when its text was fetched; a writer that drops in a new body
 * without the stamp makes that rescore invisible (the BRO-4490 backfill fixed
 * the old files, this keeps new writers from re-creating the gap).
 *
 * A script is an offender when, in one file, it
 *   1. writes review-texts files (a raw fs write findRawReviewWrites sees, or
 *      a call to one of the guarded review writers), and
 *   2. sets fullText to a new value (`x.fullText = v`, `{ fullText: v }`,
 *      `{ fullText }`) that is not null/empty and does not derive from the
 *      SAME record's stored body (`x.fullText` / any `wrongFullText`, or a
 *      local whose every assignment derives from one, e.g.
 *      `cleaned = clean(x.fullText)`; `x.fullText = other.fullText` from a
 *      freshly fetched record still counts), and outside an
 *      object passed straight to a helper call (a classifier input or a
 *      field builder, which stamps itself, e.g. buildManualReviewFields), and
 *   3. never writes a textFetchedAt key with a non-null value and never calls
 *      a shared helper that stamps one (STAMPING_HELPERS).
 * Limit: the stamp check is per FILE. One textFetchedAt write anywhere in a
 * script clears every fullText write in it, even one on another code path, so
 * a script that stamps in one branch and not another passes. Narrow it to the
 * write site if that ever proves to hide a real gap.
 * AST based (TypeScript parser, as review-write-safety.js): comments and
 * strings never count. Existing offenders live in the JSON baseline (advisory
 * rollout, CLAUDE.md section 19); a new offender fails the unit test.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('typescript');
const { findRawReviewWrites } = require('./review-write-safety');

// Shared writers whose callers persist the record into data/review-texts.
const GUARDED_REVIEW_WRITERS = new Set([
  'safeWriteReview', 'writeReviewOrThrow', 'persistReviewSnapshot',
  'createOrMergeReviewFile', 'mergeOntoDisk',
]);

function propName(tree, name) {
  if (!name) return null;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteral(name.expression)) return name.expression.text;
  return null;
}

function accessName(n) {
  if (ts.isPropertyAccessExpression(n)) return n.name.text;
  if (ts.isElementAccessExpression(n) && ts.isStringLiteralLike(n.argumentExpression)) return n.argumentExpression.text;
  return null;
}

function unwrap(n) {
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isNonNullExpression(n))) n = n.expression;
  return n;
}

function isEmptyValue(n) {
  n = unwrap(n);
  if (!n) return true;
  if (n.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(n) && n.text === 'undefined') return true;
  if (ts.isVoidExpression(n)) return true;
  if (ts.isStringLiteralLike(n) && n.text === '') return true;
  return false;
}

// Shared helpers that set textFetchedAt on the record or fields they build.
const STAMPING_HELPERS = new Set([
  'buildManualReviewFields', // manual-review-fields.js
  'processRecoveredText', // browser-recovery-helpers.js
  'recoveryPatch', // empty-body-retry.js
  'backfillFields', // text-fetched-at-backfill.js
]);

// Calls an object literal may go straight into and still be a stored record
// (`JSON.stringify({ ...data, fullText })`, `Object.assign(data, { fullText })`).
const RECORD_SINKS = new Set(['push', 'unshift', 'set', 'stringify', 'assign', ...GUARDED_REVIEW_WRITERS]);

function analyzeStampCoverage(source, file = 'writer.js') {
  if (!/fullText/.test(source)) {
    return { writesReviewTexts: false, reviewWriteLines: [], fullTextWrites: [], stamps: [], offender: false };
  }
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const line = n => tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1;
  const bindings = new Map();
  const functionNames = new Set();
  (function collect(n) {
    if (ts.isFunctionDeclaration(n) && n.name) functionNames.add(n.name.text);
    if (ts.isVariableDeclaration(n) && n.initializer && ts.isIdentifier(n.name)) {
      if (!bindings.has(n.name.text)) bindings.set(n.name.text, []);
      bindings.get(n.name.text).push(n.initializer);
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
      if (!bindings.has(n.left.text)) bindings.set(n.left.text, []);
      bindings.get(n.left.text).push(n.right);
    }
    ts.forEachChild(n, collect);
  })(tree);
  // True when the value reads the target record's own stored body: a
  // `<target>.fullText` access or any `*.wrongFullText`, or a local whose
  // EVERY assignment derives (a reassigned `text = await fetchPage(u)` breaks
  // it). `target` is the record's source text (`data` for `data.fullText =`,
  // the spread for `{ ...data, fullText }`); null means only wrongFullText.
  function derivesFromStoredText(expr, target, seen = new Set()) {
    let hit = false;
    (function walk(c) {
      if (hit) return;
      const name = accessName(c);
      if (name && /^wrongfulltext$/i.test(name)) { hit = true; return; }
      if (name === 'fullText') {
        // Another record's body (scraped.fullText) is a new body here; never
        // look through it at the record's own bindings.
        if (target && unwrap(c.expression).getText(tree) === target) hit = true;
        return;
      }
      if (ts.isIdentifier(c) && bindings.has(c.text)
          && !(c.parent && ts.isPropertyAccessExpression(c.parent) && c.parent.name === c)) {
        // A cycle (text = text.trim()) inherits the verdict of the other
        // bindings, which every() below still requires to derive.
        if (seen.has(c.text)) { hit = true; return; }
        const next = new Set(seen).add(c.text);
        const bound = bindings.get(c.text);
        // Every assignment derives, and at least one does so without leaning
        // on the cycle (a purely self-referential local proves nothing).
        if (bound.every(v => derivesFromStoredText(v, target, next))
            && bound.some(v => !referencesName(v, c.text) && derivesFromStoredText(v, target, next))) { hit = true; return; }
      }
      ts.forEachChild(c, walk);
    })(expr);
    return hit;
  }
  function referencesName(expr, name) {
    let found = false;
    (function walk(c) {
      if (found) return;
      if (ts.isIdentifier(c) && c.text === name) { found = true; return; }
      ts.forEachChild(c, walk);
    })(expr);
    return found;
  }
  function literalTarget(objectLiteral) {
    const spreads = objectLiteral.properties.filter(p => ts.isSpreadAssignment(p));
    return spreads.length === 1 ? unwrap(spreads[0].expression).getText(tree) : null;
  }
  function boundOnlyToEmpty(id) {
    const bound = bindings.get(id.text);
    return !!bound && bound.every(b => isEmptyValue(b));
  }
  // `{ fullText: someCheck }` maps the field to a function (e.g. a guard's
  // breadcrumb table), not a body.
  function isFunctionValue(v) {
    v = unwrap(v);
    if (ts.isArrowFunction(v) || ts.isFunctionExpression(v)) return true;
    if (!ts.isIdentifier(v)) return false;
    if (functionNames.has(v.text)) return true;
    const bound = bindings.get(v.text);
    return !!bound && bound.every(b => ts.isArrowFunction(unwrap(b)) || ts.isFunctionExpression(unwrap(b)));
  }
  function inHelperArgument(objectLiteral) {
    let o = objectLiteral;
    while (o.parent && (ts.isParenthesizedExpression(o.parent) || ts.isAsExpression(o.parent))) o = o.parent;
    const call = o.parent;
    if (!call || !ts.isCallExpression(call) || !call.arguments.includes(o)) return false;
    const callee = ts.isIdentifier(call.expression) ? call.expression.text : accessName(call.expression);
    return !RECORD_SINKS.has(callee);
  }
  const fullTextWrites = [];
  const stamps = [];
  const guardedCalls = [];
  function visit(n) {
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const key = accessName(n.left);
      const target = key === 'fullText' ? unwrap(n.left.expression).getText(tree) : null;
      if (key === 'fullText' && !isEmptyValue(n.right) && !derivesFromStoredText(n.right, target)) {
        fullTextWrites.push({ line: line(n), code: n.getText(tree).split('\n')[0].slice(0, 120) });
      }
      if (key === 'textFetchedAt' && !isEmptyValue(n.right)) stamps.push(line(n));
    }
    if (ts.isPropertyAssignment(n)) {
      const key = propName(tree, n.name);
      if (key === 'fullText' && !isEmptyValue(n.initializer) && !derivesFromStoredText(n.initializer, literalTarget(n.parent))
          && !isFunctionValue(n.initializer) && !inHelperArgument(n.parent)) {
        fullTextWrites.push({ line: line(n), code: n.getText(tree).split('\n')[0].slice(0, 120) });
      }
      if (key === 'textFetchedAt' && !isEmptyValue(n.initializer)) stamps.push(line(n));
    }
    if (ts.isShorthandPropertyAssignment(n)) {
      if (n.name.text === 'fullText' && !derivesFromStoredText(n.name, literalTarget(n.parent)) && !inHelperArgument(n.parent)) {
        fullTextWrites.push({ line: line(n), code: 'fullText' });
      }
      if (n.name.text === 'textFetchedAt' && !boundOnlyToEmpty(n.name)) stamps.push(line(n));
    }
    if (ts.isCallExpression(n)) {
      const callee = ts.isIdentifier(n.expression) ? n.expression.text : accessName(n.expression);
      if (GUARDED_REVIEW_WRITERS.has(callee)) guardedCalls.push(line(n));
      if (STAMPING_HELPERS.has(callee)) stamps.push(line(n));
    }
    ts.forEachChild(n, visit);
  }
  visit(tree);
  const rawWrites = findRawReviewWrites(source, file).map(h => h.line);
  const writesReviewTexts = rawWrites.length > 0 || guardedCalls.length > 0;
  return {
    writesReviewTexts,
    reviewWriteLines: [...rawWrites, ...guardedCalls].sort((a, b) => a - b),
    fullTextWrites,
    stamps,
    offender: writesReviewTexts && fullTextWrites.length > 0 && stamps.length === 0,
  };
}

function scanUnstampedFullTextWriters(root) {
  const found = [];
  function walk(dir) {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !['node_modules', 'fixtures', 'tests', '__tests__'].includes(e.name)) walk(rel);
      } else if (/\.(?:js|mjs|cjs|ts)$/.test(e.name) && !/\.(?:test|spec)\./.test(e.name) && !e.name.endsWith('.d.ts')) {
        const r = analyzeStampCoverage(fs.readFileSync(path.join(root, rel), 'utf8'), rel);
        if (r.offender) found.push({ file: rel, fullTextLines: r.fullTextWrites.map(w => w.line) });
      }
    }
  }
  walk('scripts');
  return found;
}

function unapprovedUnstampedWriters(found, baseline) {
  const allowed = new Set(baseline.map(row => row.file));
  return found.filter(row => !allowed.has(row.file));
}

module.exports = { analyzeStampCoverage, scanUnstampedFullTextWriters, unapprovedUnstampedWriters, GUARDED_REVIEW_WRITERS, STAMPING_HELPERS };
