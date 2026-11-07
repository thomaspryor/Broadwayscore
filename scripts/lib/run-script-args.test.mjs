// BRO-5866: a run-script action's flags must reach the script.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runScriptArgs } = require('./run-script-args.js');

test('string args pass through, sanitized', () => {
  assert.deepEqual(runScriptArgs({ args: '--show=x --apply' }), { ok: true, args: '--show=x --apply' });
  assert.deepEqual(runScriptArgs({ args: '--apply; rm -rf x' }), { ok: true, args: '--apply rm -rf x' });
});

test('an arguments array is used, not dropped (the BRO-5866 dry run)', () => {
  assert.deepEqual(runScriptArgs({ arguments: ['--apply'] }), { ok: true, args: '--apply' });
  assert.deepEqual(runScriptArgs({ args: ['--show', 'the-heart-off-broadway-2026'] }), { ok: true, args: '--show the-heart-off-broadway-2026' });
});

test('no args is an empty string', () => {
  assert.deepEqual(runScriptArgs({}), { ok: true, args: '' });
});

test('other shapes and spaced elements are refused', () => {
  assert.equal(runScriptArgs({ args: { apply: true } }).ok, false);
  assert.equal(runScriptArgs({ arguments: ['--reason=two words'] }).ok, false);
});

test('an empty args does not hide a non-empty arguments; both set is refused', () => {
  assert.deepEqual(runScriptArgs({ args: '', arguments: ['--apply'] }), { ok: true, args: '--apply' });
  assert.deepEqual(runScriptArgs({ args: null, arguments: ['--apply'] }), { ok: true, args: '--apply' });
  assert.equal(runScriptArgs({ args: '--x', arguments: ['--apply'] }).ok, false);
  assert.equal(runScriptArgs({ arguments: [1] }).ok, false);
});
