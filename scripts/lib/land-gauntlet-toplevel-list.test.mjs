/**
 * land-gauntlet-toplevel-list.test.mjs (BRO-5117) — drives the REAL
 * listToplevelRegressionTests() via require() (rule 15). Fails if the list
 * stops being derived from test.yml, which is how BRO-5079/BRO-5115 landed.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { listToplevelRegressionTests } = require('./land-gauntlet-toplevel-list.js');
const dir = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.join(dir, '..', '..');

test('derives only commands that are a whole `node scripts/test-*.js` step, sorted, minus covered-elsewhere', () => {
  const runText = [
    'node scripts/test-b.js',
    'timeout 120 node scripts/test-a.js',
    'echo "node scripts/test-c.js"',
    'node scripts/test-d.js --flag',
    'node scripts/test-data-write-guard.js',
    'node scripts/not-a-test.js',
  ].join('\n');
  assert.deepEqual(listToplevelRegressionTests({ runText }), ['scripts/test-a.js', 'scripts/test-b.js']);
});

test('empty runText → empty list', () => {
  assert.deepEqual(listToplevelRegressionTests({ runText: '' }), []);
});

test('REAL test.yml: includes the two steps that went red on main through the gap, and every file exists', () => {
  const list = listToplevelRegressionTests();
  assert.ok(list.includes('scripts/test-ordinal-publishdate-guards.js'), 'BRO-5115 file missing');
  assert.ok(list.includes('scripts/test-opening-night-fixes.js'), 'BRO-5079 file missing');
  for (const p of list) assert.ok(fs.existsSync(path.join(ROOT, p)), `${p} does not exist`);
});

test('CLI --list matches the function', () => {
  const out = execFileSync('node', [path.join(dir, 'land-gauntlet-toplevel-list.js'), '--list'], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(out, listToplevelRegressionTests());
});
