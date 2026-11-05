// BRO-2454: write/notify ordering classifier for routeAlert() call sites.
// Colocated so CI's scripts/lib/*.test.mjs glob runs it: the real-tree test
// below is the gate that keeps new write-before-notify sites from landing unread.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifySource, classifyYaml, auditTree, summarize, unreviewed, REVIEWED, KINDS } = require('./audit-route-alert-core.js');

const BEFORE = `
const fs = require('fs');
async function main() {
  fs.writeFileSync(STATE_PATH, '{}');   // stamped first (the BRO-2438 anti-pattern)
  await routeAlert({ conditionKey: 'k', title: 't', disposition: 'human' });
}`;
const AFTER = `
async function main() {
  const r = await routeAlert({ conditionKey: 'k', title: 't' });
  if (r.delivered) fs.writeFileSync(STATE_PATH, '{}');
}`;
const NONE = `async function main() { await routeAlert({ conditionKey: 'k', title: 't' }); }`;
const REPORT = `
async function main() {
  fs.writeFileSync(REPORT_PATH, 'x');
  await routeAlert({ conditionKey: 'k', title: 't' });
}`;
const OTHER_FN = `
function stamp() { fs.writeFileSync(STATE_PATH, '{}'); }
async function main() { await routeAlert({ conditionKey: 'k', title: 't' }); }`;

test('known write-before-notify instance is classified as a bug candidate', () => {
  const [row] = classifySource(BEFORE);
  assert.equal(row.kind, KINDS.BEFORE);
  assert.equal(row.disposition, 'human');
  assert.deepEqual(row.writesBefore, ['writeFileSync']);
});

test('write-after-notify is the safe order, and a result-gated write is not ungated', () => {
  const [row] = classifySource(AFTER);
  assert.equal(row.kind, KINDS.AFTER);
  assert.deepEqual(row.afterUngated, []);
  const ungated = classifySource(`async function m() { await routeAlert({ conditionKey: 'k' }); saveState(s); }`)[0];
  assert.deepEqual(ungated.afterUngated, ['saveState']);
});

test('no state write, report-file write, and a write in another function are not flagged', () => {
  assert.equal(classifySource(NONE)[0].kind, KINDS.NONE);
  assert.equal(classifySource(REPORT)[0].kind, KINDS.NONE);
  assert.equal(classifySource(OTHER_FN)[0].kind, KINDS.NONE);
});

test('named state savers and alerted flags count as writes', () => {
  const src = `async function m() { saveSentData(d); await routeAlert({ conditionKey: 'k', title: 't' }); }`;
  assert.equal(classifySource(src)[0].kind, KINDS.BEFORE);
  const flag = `async function m() { ledger.tripwireAlerted = true; await routeAlert({ conditionKey: 'k' }); }`;
  assert.deepEqual(classifySource(flag)[0].writesBefore, ['tripwireAlerted=']);
});

test('a write in an early-return branch is not "before" the alert', () => {
  const src = `async function m(x) {
    if (!x) { saveLedger(l); return; }
    await routeAlert({ conditionKey: 'k' });
  }`;
  assert.equal(classifySource(src)[0].kind, KINDS.NONE);
});

test('a stamp in a .then() callback counts as after; outer stamp before a callback alert counts as before', () => {
  const then = `function m() { routeAlert({ conditionKey: 'k' }).then((r) => { if (r.delivered) writeStamp(); }); }`;
  const row = classifySource(then)[0];
  assert.equal(row.kind, KINDS.AFTER);
  assert.deepEqual(row.afterUngated, []);
  const outer = `async function m(items) { writeState(s); items.forEach(async (i) => { await routeAlert({ conditionKey: i }); }); }`;
  assert.equal(classifySource(outer)[0].kind, KINDS.BEFORE);
});

test('yaml run: blocks are classified by line order and comment lines are ignored', () => {
  const yml = [
    'jobs:',
    '  a:',
    '    steps:',
    '      - name: stamp first',
    '        run: |',
    "          node -e \"require('fs').writeFileSync('data/stamp.json', '{}')\"",
    "          # writeFileSync('data/stamp.json') in a comment does not count",
    "          node -e \"routeAlert({ conditionKey: 'k', disposition: 'auto' })\"",
    '      - name: stamp after',
    '        run: |',
    "          node -e \"routeAlert({ conditionKey: 'k' }).then(() => fs.writeFileSync(sentPath, x))\"",
    '          echo "x" >> "$GITHUB_OUTPUT"',
  ].join('\n');
  const rows = classifyYaml(yml, 'w.yml');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].kind, KINDS.BEFORE);
  assert.equal(rows[0].disposition, 'auto');
  assert.equal(rows[1].kind, KINDS.AFTER);
});

test('unreviewed() reports a file whose live count grows past its reviewed count', () => {
  const row = (file) => ({ file, kind: KINDS.BEFORE });
  const reviewed = { 'a.js': { count: 1, reason: 'r' } };
  assert.equal(unreviewed([row('a.js')], reviewed).length, 0);
  assert.equal(unreviewed([row('a.js'), row('a.js')], reviewed).length, 2);
  assert.equal(unreviewed([row('b.js')], reviewed).length, 1);
});

test('real tree: every routeAlert call site classified, zero unreviewed write-before-notify sites', () => {
  const rows = auditTree(path.resolve(import.meta.dirname, '..', '..'));
  assert.ok(rows.length > 100, `expected many call sites, got ${rows.length}`);
  assert.ok(rows.some((r) => r.file.startsWith('.github/workflows/')), 'workflow call sites scanned');
  const counts = summarize(rows);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), rows.length);
  assert.ok(rows.every((r) => Object.values(KINDS).includes(r.kind) && r.line > 0));
  const open = unreviewed(rows);
  assert.deepEqual(open.map((r) => `${r.file}:${r.line}`), [],
    'new write-before-notify routeAlert site: stamp retry state only after routeAlert() succeeds, or read it and add it to REVIEWED in scripts/lib/audit-route-alert-core.js');
  // Every REVIEWED entry still matches a live site (no stale allowlist rows).
  for (const file of Object.keys(REVIEWED)) {
    assert.ok(rows.some((r) => r.file === file && r.kind === KINDS.BEFORE), `stale REVIEWED entry: ${file}`);
  }
});
