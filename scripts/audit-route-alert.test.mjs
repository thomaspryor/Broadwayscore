// BRO-2454: CLI + real-function tests for scripts/audit-route-alert.js.
// Core logic tests (and the CI-globbed real-tree gate) live in
// scripts/lib/audit-route-alert-core.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifySource, KINDS, auditTree, unreviewed } = require('./lib/audit-route-alert-core.js');
const { main } = require('./audit-route-alert.js');

const ROOT = path.resolve(import.meta.dirname, '..');

// The pre-BRO-2454 analyze-rebuild-drops.js shape: cooldown stamped, then an
// 'auto' dispatch that can fail.
const PRE_FIX = `
async function main() {
  fs.writeFileSync(cooldownFile, JSON.stringify({ lastSent: now }));
  if (!needsInvestigation) return;
  await routeAlert({ conditionKey: 'rebuild-drops:x', disposition: 'auto' });
}`;
const POST_FIX = `
async function main() {
  const stampCooldown = () => fs.writeFileSync(cooldownFile, '{}');
  if (!needsInvestigation) { stampCooldown(); return; }
  const routed = await routeAlert({ conditionKey: 'rebuild-drops:x', disposition: 'auto' });
  if (routed.dispatchOk !== false) stampCooldown();
}`;

test('each class on fixture strings', () => {
  assert.equal(classifySource(PRE_FIX)[0].kind, KINDS.BEFORE);
  assert.equal(classifySource(POST_FIX)[0].kind, KINDS.AFTER);
  assert.equal(classifySource(`async function m() { saveState(); await routeAlert({}); writeState(); }`)[0].kind, KINDS.BOTH);
  assert.equal(classifySource(`async function m() { await routeAlert({}); }`)[0].kind, KINDS.NONE);
});

test('a pre-fix-style file dropped into a scanned tree is reported unreviewed and fails --strict', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-route-alert-'));
  try {
    fs.mkdirSync(path.join(tmp, 'scripts'));
    fs.writeFileSync(path.join(tmp, 'scripts', 'pre-fix.js'), PRE_FIX);
    const rows = auditTree(tmp);
    assert.equal(rows.length, 1);
    assert.equal(unreviewed(rows).length, 1);
    const log = console.log; console.log = () => {};
    try { assert.equal(main(['--strict'], tmp), 1); } finally { console.log = log; }
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('the fixed analyze-rebuild-drops.js is no longer write-before-notify', () => {
  const rows = classifySource(fs.readFileSync(path.join(ROOT, 'scripts/analyze-rebuild-drops.js'), 'utf8'));
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.kind !== KINDS.BEFORE && r.kind !== KINDS.BOTH), JSON.stringify(rows));
});

test('CLI --json on the real repo: counts add up, zero unreviewed, --strict exits 0', () => {
  const out = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts/audit-route-alert.js'), '--json', '--strict'], { encoding: 'utf8' }));
  const total = Object.values(out.counts).reduce((a, b) => a + b, 0);
  assert.equal(total, out.rows.length);
  assert.ok(total > 100);
  assert.deepEqual(out.unreviewed, []);
});
