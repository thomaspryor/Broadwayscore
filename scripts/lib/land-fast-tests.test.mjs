// land-fast-tests.js (BRO-7150): which tests run first, and in which land gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const F = require('./land-fast-tests.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const universe = {
  nodeSet: new Set(['tests/unit/a.test.mjs', 'tests/unit/b.test.mjs', 'tests/unit/c.test.mjs', 'tests/unit/slow.test.mjs', 'tests/unit/inv.test.mjs']),
  tsxSet: new Set(['tests/unit/t.test.ts']),
  libFiles: ['scripts/lib/x.test.mjs'],
};
const texts = {
  'tests/unit/a.test.mjs': "import '../../scripts/lib/widget-maker.js'",
  'tests/unit/b.test.mjs': "readFileSync('.github/workflows/' + f)",
  'tests/unit/c.test.mjs': 'nothing relevant',
  'tests/unit/slow.test.mjs': 'scripts/lib/widget-maker.js',
  'tests/unit/inv.test.mjs': 'repo-wide',
  'tests/unit/t.test.ts': 'widget-maker',
  'scripts/lib/x.test.mjs': "require('./widget-maker.js')",
};
const sel = (changed, extra = {}) => F.selectFastTests({ changed, universe, readText: (f) => texts[f], invariants: ['tests/unit/inv.test.mjs'], slow: new Set(['tests/unit/slow.test.mjs']), ...extra });

test('gateFor maps files to their land gate', () => {
  assert.equal(F.gateFor('scripts/lib/x.test.mjs', universe), 'scripts-lib-tests');
  assert.equal(F.gateFor('tests/unit/a.test.mjs', universe), 'unit-tests-node');
  assert.equal(F.gateFor('tests/unit/t.test.ts', universe), 'unit-tests-tsx');
  assert.equal(F.gateFor('tests/e2e/z.spec.ts', universe), null);
});

test('invariants always run; tests naming a changed file are picked; slow ones are left out', () => {
  const r = sel(['scripts/lib/widget-maker.js']);
  const files = r.files.map((f) => f.file);
  assert.ok(files.includes('tests/unit/inv.test.mjs'), 'invariant');
  assert.ok(files.includes('tests/unit/a.test.mjs'), 'names the path');
  assert.ok(files.includes('scripts/lib/x.test.mjs'), 'names the basename');
  assert.ok(files.includes('tests/unit/t.test.ts'), 'names the stem');
  assert.ok(!files.includes('tests/unit/c.test.mjs'));
  assert.ok(!files.includes('tests/unit/slow.test.mjs'));
  assert.equal(r.skipped.slow, 1);
});

test('a changed test runs even when slow; a dir literal pulls in tests that scan it', () => {
  const files = sel(['tests/unit/slow.test.mjs', '.github/workflows/land.yml']).files.map((f) => f.file);
  assert.ok(files.includes('tests/unit/slow.test.mjs'));
  assert.ok(files.includes('tests/unit/b.test.mjs'));
});

test('broad dirs and the cap keep the set small, strongest matches first', () => {
  assert.equal(F.matchTier('scripts/lib/zz.js', 'q', "'scripts/lib'"), null);
  const r = sel(['scripts/lib/widget-maker.js'], { maxTargeted: 1 });
  assert.deepEqual(r.files.map((f) => f.file), ['tests/unit/inv.test.mjs', 'tests/unit/a.test.mjs']);
  assert.ok(r.skipped.overCap >= 2);
});

test('writeScopeDir writes one <gate>.files per gate used', () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'lft-'));
  try {
    const gates = F.writeScopeDir(dir, sel(['scripts/lib/widget-maker.js']).files);
    assert.deepEqual(gates.sort(), ['scripts-lib-tests', 'unit-tests-node', 'unit-tests-tsx']);
    assert.match(fs.readFileSync(path.join(dir, 'unit-tests-node.files'), 'utf8'), /inv\.test\.mjs/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('every listed invariant and slow test exists in a fast gate of this tree', () => {
  const u = F.universeFor(ROOT);
  for (const f of F.INVARIANT_TESTS) {
    assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
    assert.ok(F.gateFor(f, u), `${f} runs in a fast gate`);
  }
  assert.deepEqual([...F.INVARIANT_TESTS].sort(), F.INVARIANT_TESTS, 'INVARIANT_TESTS stays sorted');
  for (const f of F.SLOW_TESTS) assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} exists`);
});

test('parseArgs requires a command and --base', () => {
  assert.ok(F.parseArgs(['select']).error);
  assert.ok(F.parseArgs(['nope', '--base', 'x']).error);
  assert.equal(F.parseArgs(['run', '--base', 'abc', '--tip', 'def']).tip, 'def');
});

test('a skipped invariant stays out when only named, and runs when the test itself changed', () => {
  const skip = new Set(['tests/unit/inv.test.mjs']);
  const named = sel(['scripts/lib/widget-maker.js'], { skip, invariants: ['tests/unit/inv.test.mjs'] }).files.map((f) => f.file);
  assert.ok(!named.includes('tests/unit/inv.test.mjs'));
  texts['tests/unit/inv.test.mjs'] = 'scripts/lib/widget-maker.js';
  try {
    const again = sel(['scripts/lib/widget-maker.js'], { skip }).files.map((f) => f.file);
    assert.ok(!again.includes('tests/unit/inv.test.mjs'), 'naming the changed file does not pull a skipped test back in');
  } finally { texts['tests/unit/inv.test.mjs'] = 'repo-wide'; }
  const changed = sel(['tests/unit/inv.test.mjs'], { skip }).files.map((f) => f.file);
  assert.ok(changed.includes('tests/unit/inv.test.mjs'));
});
