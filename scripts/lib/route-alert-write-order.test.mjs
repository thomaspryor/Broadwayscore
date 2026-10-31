// BRO-2454: write/notify ordering classifier for routeAlert() call sites.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifySource, auditTree, summarize, KINDS } = require('./route-alert-write-order.js');

const BEFORE = `
const fs = require('fs');
async function main() {
  fs.writeFileSync(STATE_PATH, '{}');   // stamped first (the BRO-2438 anti-pattern)
  await routeAlert({ conditionKey: 'k', title: 't' });
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
  assert.deepEqual(row.writesBefore, ['writeFileSync']);
});

test('write-after-notify is the safe order', () => {
  assert.equal(classifySource(AFTER)[0].kind, KINDS.AFTER);
});

test('no state write, report-file write, and a write in another function are not flagged', () => {
  assert.equal(classifySource(NONE)[0].kind, KINDS.NONE);
  assert.equal(classifySource(REPORT)[0].kind, KINDS.NONE);
  assert.equal(classifySource(OTHER_FN)[0].kind, KINDS.NONE);
});

test('named state savers count as writes', () => {
  const src = `async function m() { saveSentData(d); await routeAlert({ conditionKey: 'k', title: 't' }); }`;
  assert.equal(classifySource(src)[0].kind, KINDS.BEFORE);
});

test('real tree: finds routeAlert call sites and accounts for every one', () => {
  const rows = auditTree(path.resolve(import.meta.dirname, '..', '..'));
  assert.ok(rows.length > 50, `expected many call sites, got ${rows.length}`);
  const counts = summarize(rows);
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), rows.length);
  assert.ok(rows.every((r) => Object.values(KINDS).includes(r.kind) && r.line > 0));
});
