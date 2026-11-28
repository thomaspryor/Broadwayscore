'use strict';
// BRO-7724 / Sentry 7834294498: a URL write (history.replaceState, the
// replaceLocationSearch helper, router.replace/push) inside a React state
// updater (`setX(prev => { ...; replaceState(...); return next; })`) runs once
// per updater evaluation, not once per user action. React replays queued
// updaters on every interrupted transition render (and twice in StrictMode),
// so typing fast in a search box multiplied the writes until Safari/Chrome
// threw "Attempt to use history.replaceState() more than 100 times per 10
// seconds". This finds that shape statically so it cannot come back.

const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const URL_WRITERS = new Set(['replaceState', 'pushState', 'replaceLocationSearch']);
const ROUTER_METHODS = new Set(['replace', 'push']);

function isUrlWrite(call) {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return URL_WRITERS.has(callee.text);
  if (ts.isPropertyAccessExpression(callee)) {
    const name = callee.name.text;
    if (name === 'replaceState' || name === 'pushState') return true;
    if (ROUTER_METHODS.has(name)) {
      const obj = callee.expression;
      return ts.isIdentifier(obj) && /router$/i.test(obj.text);
    }
  }
  return false;
}

function isStateSetterCall(call) {
  const callee = call.expression;
  return ts.isIdentifier(callee) && /^set[A-Z]/.test(callee.text)
    && call.arguments.length === 1
    && (ts.isArrowFunction(call.arguments[0]) || ts.isFunctionExpression(call.arguments[0]));
}

/**
 * Pure: returns [{ setter, writer, line }] for every URL write that sits inside
 * a function passed to a `setX(...)` state setter.
 */
function findHistoryWritesInUpdaters(sourceText, fileName = 'file.tsx') {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true,
    fileName.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const hits = [];
  function scanUpdater(setterName, node) {
    if (ts.isCallExpression(node) && isUrlWrite(node)) {
      hits.push({
        setter: setterName,
        writer: node.expression.getText(sf),
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
      });
    }
    ts.forEachChild(node, (child) => scanUpdater(setterName, child));
  }
  function visit(node) {
    if (ts.isCallExpression(node) && isStateSetterCall(node)) {
      scanUpdater(node.expression.text, node.arguments[0]);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return hits;
}

function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Scan a source tree (default: repo src/). Returns [{ file, setter, writer, line }]. */
function scanTree(root = path.join(__dirname, '..', '..', 'src')) {
  const hits = [];
  for (const file of listSourceFiles(root)) {
    const text = fs.readFileSync(file, 'utf8');
    if (!/replaceState|pushState|replaceLocationSearch|router\.(replace|push)/.test(text)) continue;
    for (const hit of findHistoryWritesInUpdaters(text, file)) {
      hits.push({ file: path.relative(path.join(root, '..'), file), ...hit });
    }
  }
  return hits;
}

module.exports = { findHistoryWritesInUpdaters, scanTree };

if (require.main === module) {
  const hits = scanTree();
  for (const h of hits) console.log(`${h.file}:${h.line} ${h.writer} inside ${h.setter}(updater)`);
  console.log(`${hits.length} URL write(s) inside React state updaters`);
  process.exit(hits.length ? 1 : 0);
}
