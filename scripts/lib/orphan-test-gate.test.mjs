import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { decideOrphanGate } = require('./orphan-test-gate.js');

const ORPHAN_A = { name: 'a.test.mjs', rel: 'tests/unit/a.test.mjs' };
const ORPHAN_B = { name: 'b.test.mjs', rel: 'scripts/b.test.mjs' };

test('changedFiles undefined blocks every orphan (CI unscoped behavior)', () => {
  const gate = decideOrphanGate({ orphans: [ORPHAN_A, ORPHAN_B], changedFiles: undefined });
  assert.deepEqual(gate.blocking, [ORPHAN_A, ORPHAN_B]);
  assert.deepEqual(gate.informational, []);
});

test('changedFiles null blocks every orphan', () => {
  const gate = decideOrphanGate({ orphans: [ORPHAN_A], changedFiles: null });
  assert.deepEqual(gate.blocking, [ORPHAN_A]);
  assert.deepEqual(gate.informational, []);
});

test('orphan whose path is in changedFiles blocks', () => {
  const gate = decideOrphanGate({
    orphans: [ORPHAN_A, ORPHAN_B],
    changedFiles: ['tests/unit/a.test.mjs', 'src/some-unrelated-file.ts'],
  });
  assert.deepEqual(gate.blocking, [ORPHAN_A]);
  assert.deepEqual(gate.informational, [ORPHAN_B]);
});

test('orphan whose path is NOT in changedFiles is informational only, never blocks', () => {
  const gate = decideOrphanGate({
    orphans: [ORPHAN_A, ORPHAN_B],
    changedFiles: ['README.md', 'scripts/unrelated.js'],
  });
  assert.deepEqual(gate.blocking, []);
  assert.deepEqual(gate.informational, [ORPHAN_A, ORPHAN_B]);
});

test('empty changedFiles array blocks nothing, all informational', () => {
  const gate = decideOrphanGate({ orphans: [ORPHAN_A], changedFiles: [] });
  assert.deepEqual(gate.blocking, []);
  assert.deepEqual(gate.informational, [ORPHAN_A]);
});

test('no orphans never blocks regardless of scope', () => {
  assert.deepEqual(decideOrphanGate({ orphans: [], changedFiles: undefined }), {
    blocking: [],
    informational: [],
  });
  assert.deepEqual(decideOrphanGate({ orphans: [], changedFiles: ['x'] }), {
    blocking: [],
    informational: [],
  });
});

test('accepts a Set for changedFiles, not just an array', () => {
  const gate = decideOrphanGate({
    orphans: [ORPHAN_A, ORPHAN_B],
    changedFiles: new Set(['scripts/b.test.mjs']),
  });
  assert.deepEqual(gate.blocking, [ORPHAN_B]);
  assert.deepEqual(gate.informational, [ORPHAN_A]);
});
