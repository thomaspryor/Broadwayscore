/**
 * BRO-5157: source audit for raw review JSON writes. Existing callers outside
 * this migration are grandfathered by exact call fingerprints, not file-wide
 * exemptions. The baseline makes this an advisory rollout for that backlog;
 * new writes must use the guarded writer or snapshot persistence.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ts = require('typescript');

function findRawReviewWrites(source, file = 'writer.js') {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const tainted = new Set();
  const bindings = [];
  const calls = [];
  const writeAliases = new Set(['writeFileSync', 'writeFile']);
  const text = n => n.getText(tree);
  const referenceName = n => ts.isPropertyAccessExpression(n) ? n.name.text
    : ts.isElementAccessExpression(n) && ts.isStringLiteral(n.argumentExpression) ? n.argumentExpression.text
      : text(n);
  const looksLikeReviewPath = s => /review-texts|\b(?:REVIEW_TEXTS_DIR|reviewTextsDir|reviewsDir|reviewFilePath|reviewPath|reviewFile|filePath)\b|\.(?:filePath|path|file)\b/i.test(s);
  const mentionsTaint = n => {
    if (looksLikeReviewPath(text(n))) return true;
    let hit = false;
    function check(child) {
      if (ts.isIdentifier(child) && tainted.has(child.text)) hit = true;
      ts.forEachChild(child, check);
    }
    check(n);
    return hit;
  };
  function visit(n) {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isIdentifier(n.name)) bindings.push([n.name.text, n.initializer]);
      if (ts.isObjectBindingPattern(n.name)) {
        for (const b of n.name.elements) {
          if (/^writeFile(?:Sync)?$/.test((b.propertyName || b.name).getText(tree))) writeAliases.add(b.name.getText(tree));
        }
      }
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
      bindings.push([n.left.text, n.right]);
    }
    if (ts.isCallExpression(n)) calls.push(n);
    ts.forEachChild(n, visit);
  }
  visit(tree);
  // Follow path.join aliases, including destinations declared before their
  // directory alias. No execution, network, or private review data required.
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, value] of bindings) {
      if (!tainted.has(name) && mentionsTaint(value)) { tainted.add(name); changed = true; }
      if (!writeAliases.has(name) && writeAliases.has(referenceName(value))) { writeAliases.add(name); changed = true; }
    }
  }
  return calls.filter(n => {
    const name = referenceName(n.expression);
    return writeAliases.has(name) && n.arguments[0] && mentionsTaint(n.arguments[0]);
  }).map(n => {
    const call = text(n).replace(/\s+/g, ' ').trim();
    return {
      line: tree.getLineAndCharacterOfPosition(n.getStart(tree)).line + 1,
      target: text(n.arguments[0]),
      fingerprint: crypto.createHash('sha256').update(call).digest('hex'),
    };
  });
}

function scanReviewWriters(root) {
  const found = [];
  function walk(dir) {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (!e.name.startsWith('.') && !['node_modules', 'fixtures'].includes(e.name)) walk(rel);
      } else if (/\.(?:js|mjs|cjs)$/.test(e.name) && !/\.test\./.test(e.name)) {
        for (const hit of findRawReviewWrites(fs.readFileSync(path.join(root, rel), 'utf8'), rel)) {
          found.push({ file: rel, ...hit });
        }
      }
    }
  }
  walk('scripts');
  return found;
}

function unapprovedWrites(found, baseline) {
  const remaining = new Map();
  for (const row of baseline) {
    const key = `${row.file}:${row.fingerprint}`;
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  return found.filter(row => {
    const key = `${row.file}:${row.fingerprint}`;
    const count = remaining.get(key) || 0;
    if (!count) return true;
    remaining.set(key, count - 1);
    return false;
  });
}

module.exports = { findRawReviewWrites, scanReviewWriters, unapprovedWrites };
