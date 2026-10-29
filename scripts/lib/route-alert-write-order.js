'use strict';
/**
 * BRO-2454: classify every routeAlert() call site by the order of local
 * state writes relative to the alert, inside the same enclosing function.
 *
 * The bug class (BRO-2438): stamping "already alerted" state BEFORE the alert
 * is delivered, so a failed routeAlert() leaves the stamp behind and the real
 * retry is silently suppressed. Source order is only a heuristic for temporal
 * order, so the output is a candidate list for a human read, not a verdict.
 *
 *   write-before-notify  a state write precedes the call and none follows it
 *   write-after-notify   a state write follows the call (the safe order)
 *   write-both           writes on both sides (read by hand)
 *   no-state-write       no state write in the enclosing function
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const FS_WRITERS = new Set(['writeFileSync', 'appendFileSync', 'writeFile', 'appendFile', 'renameSync', 'rename']);
const NAME_WRITER = /^(write|save|stamp|persist)[A-Z_]\w*$|^mark\w*(Sent|Alerted|Notified|Handled)\w*$/;

const KINDS = Object.freeze({
  BEFORE: 'write-before-notify',
  AFTER: 'write-after-notify',
  BOTH: 'write-both',
  NONE: 'no-state-write',
});

function calleeName(node) {
  const c = node.callee;
  if (!c) return null;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') return c.property.name;
  return null;
}

// A bare fs write only counts when its target looks like retry/dedup state
// (report and summary files do not suppress a retry).
const STATE_TARGET = /state|stamp|sent|cooldown|marker|last|seen|flag|ledger|breaker|guard/i;

function isStateWrite(node, source) {
  const name = calleeName(node);
  if (!name || name === 'routeAlert') return false;
  const c = node.callee;
  if (c.type === 'MemberExpression' || FS_WRITERS.has(name)) {
    if (!FS_WRITERS.has(name)) return NAME_WRITER.test(name);
    const target = node.arguments[0];
    return !!target && STATE_TARGET.test(source.slice(target.start, target.end));
  }
  return NAME_WRITER.test(name);
}

function walk(node, visit, fnStack = []) {
  if (!node || typeof node.type !== 'string') return;
  const isFn = /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type);
  const stack = isFn ? [...fnStack, node] : fnStack;
  visit(node, stack);
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, stack));
    else if (v && typeof v.type === 'string') walk(v, visit, stack);
  }
}

function classifySource(source, file = '<memory>') {
  let ast;
  const opts = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowReturnOutsideFunction: true };
  try { ast = acorn.parse(source, { ...opts, sourceType: 'script' }); } catch {
    try { ast = acorn.parse(source, { ...opts, sourceType: 'module' }); } catch { return []; }
  }
  const alerts = [];
  const writes = [];
  walk(ast, (node, stack) => {
    if (node.type !== 'CallExpression') return;
    const scope = stack.length ? stack[stack.length - 1] : ast;
    if (calleeName(node) === 'routeAlert') alerts.push({ node, scope });
    else if (isStateWrite(node, source)) writes.push({ node, scope });
  });
  return alerts.map(({ node, scope }) => {
    const inScope = writes.filter((w) => w.scope === scope);
    const before = inScope.filter((w) => w.node.end <= node.start).map((w) => calleeName(w.node));
    const after = inScope.filter((w) => w.node.start >= node.end).map((w) => calleeName(w.node));
    const kind = before.length && after.length ? KINDS.BOTH
      : before.length ? KINDS.BEFORE
        : after.length ? KINDS.AFTER : KINDS.NONE;
    return { file, line: node.loc.start.line, kind, writesBefore: before, writesAfter: after };
  });
}

function listJsFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...listJsFiles(p)); }
    else if (/\.js$/.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

function auditTree(root) {
  const rows = [];
  for (const f of listJsFiles(path.join(root, 'scripts'))) {
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('routeAlert(')) continue;
    rows.push(...classifySource(src, path.relative(root, f)));
  }
  return rows;
}

function summarize(rows) {
  const counts = { [KINDS.BEFORE]: 0, [KINDS.AFTER]: 0, [KINDS.BOTH]: 0, [KINDS.NONE]: 0 };
  for (const r of rows) counts[r.kind]++;
  return counts;
}

module.exports = { KINDS, classifySource, auditTree, summarize };

if (require.main === module) {
  // BRO-2454 review aid: node scripts/lib/route-alert-write-order.js [--json] [--all]
  // Default prints only write-before-notify and write-both candidates; exit is always 0.
  const rows = auditTree(path.join(__dirname, '..', '..'));
  const counts = summarize(rows);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ counts, rows }, null, 2));
  } else {
    const show = process.argv.includes('--all') ? rows : rows.filter((r) => r.kind === KINDS.BEFORE || r.kind === KINDS.BOTH);
    for (const r of show) console.log(`${r.kind}\t${r.file}:${r.line}\tbefore=[${r.writesBefore}] after=[${r.writesAfter}]`);
    console.log(JSON.stringify(counts));
  }
}
