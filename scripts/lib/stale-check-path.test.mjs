// BRO-7559: stale acceptance checks are named, not reported as "no verdict" forever.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveStaleCheck, isWholeSuiteCommand, applyMovedResult } = require('./stale-check-path.js');

const fsOf = (files) => ({ trackedFiles: files, exists: (p) => files.includes(p) });

test('every path present: ok, command unchanged', () => {
  assert.deepEqual(resolveStaleCheck('/x', 'node --test tests/unit/a.test.mjs', fsOf(['tests/unit/a.test.mjs'])), { kind: 'ok' });
});

test('a uniquely moved test is re-pointed by exact token', () => {
  const r = resolveStaleCheck('/x', 'node --test scripts/old/a.test.mjs', fsOf(['tests/unit/a.test.mjs', 'tests/unit/b.test.mjs']));
  assert.equal(r.kind, 'moved');
  assert.equal(r.cmd, 'node --test tests/unit/a.test.mjs');
  assert.deepEqual(r.moves, [{ from: 'scripts/old/a.test.mjs', to: 'tests/unit/a.test.mjs' }]);
});

test('no file of that name anywhere: missing, named as a stale check', () => {
  const r = resolveStaleCheck('/x', 'node --test tests/unit/gone.test.mjs', fsOf(['tests/unit/a.test.mjs']));
  assert.equal(r.kind, 'missing');
  assert.deepEqual(r.missing, ['tests/unit/gone.test.mjs']);
  assert.match(r.detail, /^check is stale: tests\/unit\/gone\.test\.mjs is not on main/);
});

test('two candidates with the same basename are ambiguous: missing, never a guess', () => {
  const r = resolveStaleCheck('/x', 'node --test old/a.test.mjs', fsOf(['x/a.test.mjs', 'y/a.test.mjs']));
  assert.equal(r.kind, 'missing');
});

test('one moved and one gone: missing (no partial re-point)', () => {
  const r = resolveStaleCheck('/x', 'node --test old/a.test.mjs old/gone.test.mjs', fsOf(['x/a.test.mjs']));
  assert.equal(r.kind, 'missing');
  assert.deepEqual(r.missing, ['old/gone.test.mjs']);
});

test('the whole unit suite is recognised; a named test file is not', () => {
  assert.equal(isWholeSuiteCommand('node scripts/run-unit-tests.js'), true);
  assert.equal(isWholeSuiteCommand('  node ./scripts/run-unit-tests.js '), true);
  assert.equal(isWholeSuiteCommand('npm test'), true);
  assert.equal(isWholeSuiteCommand('node --test scripts/run-unit-tests.test.mjs'), false);
  assert.equal(isWholeSuiteCommand('node scripts/run-unit-tests.js --only foo'), false);
});

test('a re-pointed check that fails is unverifiable, never a real regression', () => {
  const stale = { moves: [{ from: 'old/a.test.mjs', to: 'new/a.test.mjs' }] };
  const failed = applyMovedResult({ cardId: 'BRO-1', status: 'fail', sha: 'abc', detail: 'exit 1' }, stale, 'node --test new/a.test.mjs');
  assert.equal(failed.status, 'unverifiable');
  assert.equal(failed.cause, 'moved-fail');
  assert.equal(failed.ranCmd, 'node --test new/a.test.mjs');
  assert.match(failed.detail, /^check is stale \(moved old\/a\.test\.mjs -> new\/a\.test\.mjs\); exit 1$/);
  const passed = applyMovedResult({ cardId: 'BRO-1', status: 'pass' }, stale, 'node --test new/a.test.mjs');
  assert.equal(passed.status, 'pass');
  assert.equal(passed.staleCheck.kind, 'moved');
});
