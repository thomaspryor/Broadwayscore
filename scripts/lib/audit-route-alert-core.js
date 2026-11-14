'use strict';
/**
 * BRO-2454: classify every routeAlert() call site by the order of local
 * state writes relative to the alert, inside the same enclosing function
 * (JS) or the same workflow run: block (YAML).
 *
 * The bug class (BRO-2438): stamping "already alerted" state BEFORE the alert
 * is delivered, so a failed routeAlert() leaves the stamp behind and the real
 * retry is silently suppressed. Source order is only a heuristic for temporal
 * order, so the output is a candidate list for a human read, not a verdict.
 * Every candidate a human has read and judged safe is listed in REVIEWED
 * below, and the colocated test fails on any write-before-notify site that is
 * not, so a new instance of the bug class needs a read before it lands.
 *
 *   write-before-notify  a state write precedes the call and none follows it
 *   write-after-notify   a state write follows the call (the safe order)
 *   write-both           writes on both sides (read by hand)
 *   no-state-write       no state write in the enclosing function
 *
 * What routeAlert() can actually fail on matters for the read: a 'digest'
 * disposition only queues a local line (queueDigestLine never throws), so a
 * stamp before it cannot lose the alert. 'human' (page-worthy keys) and
 * 'auto' (Linear dispatch) can fail and return delivered/dispatchOk false.
 */
const fs = require('fs');
const path = require('path');
const acorn = require('acorn');

const FS_WRITERS = new Set(['writeFileSync', 'appendFileSync', 'writeFile', 'appendFile', 'renameSync', 'rename']);
const NAME_WRITER = /^(write|save|stamp|persist)[A-Z_]\w*$|^mark\w*(Sent|Alerted|Notified|Handled)\w*$/;
// In-memory flags that only exist to suppress a repeat alert.
const FLAG_PROP = /^(\w*alerted|\w*Alerted|notified|\w*Notified|lastAlert\w*|lastNotified\w*|alertSent\w*)$/;
// A bare fs write only counts when its target looks like retry/dedup state
// (report and summary files do not suppress a retry).
const STATE_TARGET = /state|stamp|sent|cooldown|marker|last|seen|flag|ledger|breaker|guard/i;
// Pure helpers whose names look like writers but never touch disk.
const NOT_WRITERS = new Set(['stampFirstDefectAt']);

const KINDS = Object.freeze({
  BEFORE: 'write-before-notify',
  AFTER: 'write-after-notify',
  BOTH: 'write-both',
  NONE: 'no-state-write',
});

/**
 * Write-before-notify candidates read by hand and judged unable to suppress a
 * failed alert's retry. Keyed by file; `count` pins how many such sites the
 * file had when read, so a NEW one in the same file still fails the gate.
 */
const REVIEWED = Object.freeze({
  'scripts/check-bd-breaker.js': { count: 1, reason: 'breaker state is the guard itself; key not page-worthy so routeAlert only queues a digest line' },
  'scripts/check-sb-breaker.js': { count: 1, reason: 'same as check-bd-breaker.js' },
  'scripts/check-sd-breaker.js': { count: 1, reason: 'same as check-bd-breaker.js' },
  'scripts/check-corpus-drift.js': { count: 1, reason: 'consecutiveBlocks counter, digest; shouldEscalate re-fires every reminderEvery blocks' },
  'scripts/check-vercel-build-guard.js': { count: 1, reason: 'same as check-corpus-drift.js' },
  'scripts/check-provider-spend.js': { count: 3, reason: 'writes the spend ledger/snapshot; conditions are recomputed from it every run, routeAlert ledger dedupes' },
  'scripts/ingest-dmarc-reports.js': { count: 1, reason: 'report ledger/summary, digest; findings recomputed every run' },
  'scripts/poll-trade-press-rss.js': { count: 1, reason: 'feed state errorCount keeps the dead-feed condition firing every run until it recovers' },
  'scripts/promote-ob-venue-candidates.js': { count: 2, reason: 'saveShows/staging data, not alert state; digest' },
  'scripts/promote-we-aggregator-candidates.js': { count: 1, reason: 'promotion data, not alert state; digest' },
  'scripts/audit-show-review-gap.js': { count: 3, reason: 'checkpoint/audit data; blast-radius-quarantined shows are not persisted so the alert re-fires next run' },
  'scripts/send-opening-night-broadcast.js': { count: 2, reason: 'draft tracker written first on purpose (BRO-886, prevents duplicate drafts); draft-unsent/never-sent backstops in check-missed-broadcasts.js' },
  '.github/workflows/scrape-new-aggregators.yml': { count: 1, reason: 'blanks last-promotion-ids.json as part of the validate-failed rollback; staging is restored so the failure (and alert) recur next run' },
});

function calleeName(node) {
  const c = node.callee;
  if (!c) return null;
  if (c.type === 'Identifier') return c.name;
  if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') return c.property.name;
  return null;
}

function isStateWrite(node, source) {
  if (node.type === 'AssignmentExpression') {
    const l = node.left;
    const name = l.type === 'Identifier' ? l.name
      : l.type === 'MemberExpression' && !l.computed && l.property.type === 'Identifier' ? l.property.name : null;
    return !!name && FLAG_PROP.test(name);
  }
  if (node.type !== 'CallExpression') return false;
  const name = calleeName(node);
  if (!name || name === 'routeAlert' || NOT_WRITERS.has(name)) return false;
  if (FS_WRITERS.has(name)) {
    const target = node.arguments[0];
    return !!target && STATE_TARGET.test(source.slice(target.start, target.end));
  }
  return NAME_WRITER.test(name);
}

function writeLabel(node) {
  if (node.type === 'AssignmentExpression') {
    const l = node.left;
    return `${l.type === 'Identifier' ? l.name : l.property.name}=`;
  }
  return calleeName(node);
}

const FN_TYPE = /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/;

function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, ancestors);
  const next = [...ancestors, node];
  for (const key of Object.keys(node)) {
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, visit, next));
    else if (v && typeof v.type === 'string') walk(v, visit, next);
  }
}

const contains = (outer, inner) => outer.start <= inner.start && inner.end <= outer.end;

function exitsBlock(stmt) {
  if (!stmt) return false;
  if (/^(ReturnStatement|ThrowStatement|ContinueStatement|BreakStatement)$/.test(stmt.type)) return true;
  if (stmt.type === 'ExpressionStatement' && stmt.expression.type === 'CallExpression') {
    const c = stmt.expression.callee;
    return c.type === 'MemberExpression' && c.object.name === 'process' && c.property.name === 'exit';
  }
  return false;
}

/**
 * True when the write sits in a block that exits (return/throw/continue/
 * break/process.exit) without ever reaching the alert: an early-return branch
 * is not "before" the alert in time, only in source order.
 */
function inTerminalBranch(writeAncestors, alert) {
  for (const a of writeAncestors) {
    if (contains(a, alert)) continue;
    if (a.type === 'BlockStatement' && a.body.some(exitsBlock)) return true;
    if (a.type === 'SwitchCase' && a.consequent.some(exitsBlock)) return true;
  }
  return false;
}

// A write after the alert counts as gated when it sits under a condition that
// reads the alert's result (or inside a .then() on it).
const RESULT_TEST = /delivered|dispatchOk|\.action\b|informed|notified|\.ok\b|routed|result/;
function isGated(writeAncestors, alert, source) {
  for (const a of writeAncestors) {
    if (contains(a, alert)) continue;
    if ((a.type === 'IfStatement' || a.type === 'ConditionalExpression') && RESULT_TEST.test(source.slice(a.test.start, a.test.end))) return true;
    if (a.type === 'LogicalExpression' && RESULT_TEST.test(source.slice(a.left.start, a.left.end))) return true;
  }
  return false;
}

function dispositionOf(call, source) {
  const arg = call.arguments[0];
  if (!arg || arg.type !== 'ObjectExpression') return null;
  for (const p of arg.properties) {
    if (p.type !== 'Property' || p.computed || (p.key.name || p.key.value) !== 'disposition') continue;
    if (p.value.type === 'Literal') return String(p.value.value);
    return source.slice(p.value.start, p.value.end).includes("'human'") ? 'human|digest' : 'dynamic';
  }
  return null;
}

function parse(source) {
  const opts = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true };
  try { return acorn.parse(source, { ...opts, sourceType: 'script' }); } catch {
    try { return acorn.parse(source, { ...opts, sourceType: 'module' }); } catch { return null; }
  }
}

function classifySource(source, file = '<memory>') {
  const ast = parse(source);
  if (!ast) return [];
  const alerts = [];
  const writes = [];
  walk(ast, (node, ancestors) => {
    const fnStack = ancestors.filter((a) => FN_TYPE.test(a.type));
    const scope = fnStack.length ? fnStack[fnStack.length - 1] : ast;
    if (node.type === 'CallExpression' && calleeName(node) === 'routeAlert') alerts.push({ node, scope });
    else if (isStateWrite(node, source)) writes.push({ node, scope, ancestors });
  });
  return alerts.map(({ node, scope }) => {
    // Same function, or a callback nested in it (a .then() stamp), but never
    // a sibling function that merely shares the file.
    // Also an enclosing function's write before a callback that alerts
    // (stamp(); items.forEach(() => routeAlert(...))).
    const related = writes.filter((w) => w.scope === scope
      || (contains(scope, w.scope) && w.node.start >= node.end)
      || (w.scope !== ast && w.scope !== scope && contains(w.scope, scope) && w.node.end <= node.start));
    const before = related.filter((w) => w.node.end <= node.start && !inTerminalBranch(w.ancestors, node));
    const after = related.filter((w) => w.node.start >= node.end);
    const kind = before.length && after.length ? KINDS.BOTH
      : before.length ? KINDS.BEFORE
        : after.length ? KINDS.AFTER : KINDS.NONE;
    return {
      file,
      line: node.loc.start.line,
      kind,
      disposition: dispositionOf(node, source),
      writesBefore: before.map((w) => writeLabel(w.node)),
      writesAfter: after.map((w) => writeLabel(w.node)),
      afterUngated: after.filter((w) => !isGated(w.ancestors, node, source)).map((w) => writeLabel(w.node)),
    };
  });
}

// ---- YAML (workflow run:/script: blocks): line-order heuristic ----

const YAML_IGNORED_SINKS = /\$\{?GITHUB_(OUTPUT|STEP_SUMMARY|ENV|PATH)\b|\/dev\/null|>&2/;
const YAML_WRITE_LINE = [
  (l) => { const m = l.match(/\b(writeFileSync|appendFileSync)\(\s*([^,)]*)/); return m && STATE_TARGET.test(m[2]) ? m[1] : null; },
  (l) => (/\b(save|write|stamp|persist)[A-Z]\w*\(/.test(l) && !/routeAlert/.test(l) ? l.match(/\b((?:save|write|stamp|persist)[A-Z]\w*)\(/)[1] : null),
  (l) => (/\.\s*(\w*[aA]lerted|lastAlert\w*|lastNotified\w*)\s*=[^=]/.test(l) ? 'flag=' : null),
  (l) => (/\bgh variable set\b/.test(l) ? 'gh variable set' : null),
  (l) => (/(^|[^>&0-9])>>?\s*["']?[\w${}./-]*(stamp|sent|state|marker|cooldown|alerted)/i.test(l) && !YAML_IGNORED_SINKS.test(l) ? 'shell-redirect' : null),
];

function yamlWriteOf(line) {
  const t = line.trim();
  if (t.startsWith('#') || t.startsWith('//')) return null;
  for (const f of YAML_WRITE_LINE) { const w = f(line); if (w) return w; }
  return null;
}

function classifyYaml(source, file = '<memory>') {
  const lines = source.split('\n');
  const indentOf = (l) => l.match(/^\s*/)[0].length;
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!/\brouteAlert\(/.test(lines[i]) || t.startsWith('#') || t.startsWith('//') || /function routeAlert|require\(/.test(t)) continue;
    let start = i;
    while (start >= 0 && !/^\s*-?\s*(run|script):\s*[|>]/.test(lines[start])) start--;
    if (start < 0) continue;
    const base = indentOf(lines[start]);
    let end = start + 1;
    while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > base)) end++;
    const before = [];
    const after = [];
    for (let j = start + 1; j < end; j++) {
      // Same line: only what follows the call (a one-line .then() stamp).
      const w = yamlWriteOf(j === i ? lines[j].slice(lines[j].indexOf('routeAlert(')) : lines[j]);
      if (w) (j < i ? before : after).push(w);
    }
    const disp = (lines.slice(i, Math.min(end, i + 30)).join('\n').match(/disposition:\s*'(\w+)'/) || [])[1] || null;
    rows.push({
      file,
      line: i + 1,
      kind: before.length && after.length ? KINDS.BOTH : before.length ? KINDS.BEFORE : after.length ? KINDS.AFTER : KINDS.NONE,
      disposition: disp,
      writesBefore: before,
      writesAfter: after,
      afterUngated: [],
    });
  }
  return rows;
}

function listFiles(dir, re) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...listFiles(p, re)); }
    else if (re.test(e.name) && !/\.test\./.test(e.name)) out.push(p);
  }
  return out;
}

const SELF = /audit-route-alert/;

function auditTree(root) {
  const rows = [];
  for (const f of listFiles(path.join(root, 'scripts'), /\.(c|m)?js$/)) {
    if (SELF.test(path.basename(f))) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('routeAlert(')) continue;
    rows.push(...classifySource(src, path.relative(root, f)));
  }
  for (const f of listFiles(path.join(root, '.github', 'workflows'), /\.ya?ml$/)) {
    const src = fs.readFileSync(f, 'utf8');
    if (!src.includes('routeAlert(')) continue;
    rows.push(...classifyYaml(src, path.relative(root, f)));
  }
  return rows;
}

function summarize(rows) {
  const counts = { [KINDS.BEFORE]: 0, [KINDS.AFTER]: 0, [KINDS.BOTH]: 0, [KINDS.NONE]: 0 };
  for (const r of rows) counts[r.kind]++;
  return counts;
}

/**
 * write-before-notify rows not covered by REVIEWED (per-file count). A file
 * whose live count differs from its reviewed count (more: new site; fewer: stale entry, a swap could hide) reports all of its rows.
 */
function unreviewed(rows, reviewed = REVIEWED) {
  const byFile = new Map();
  for (const r of rows) if (r.kind === KINDS.BEFORE) byFile.set(r.file, [...(byFile.get(r.file) || []), r]);
  const out = [];
  for (const [file, list] of byFile) {
    const ok = reviewed[file];
    if (!ok || list.length !== ok.count) out.push(...list);
  }
  return out;
}

module.exports = { KINDS, REVIEWED, classifySource, classifyYaml, auditTree, summarize, unreviewed };
