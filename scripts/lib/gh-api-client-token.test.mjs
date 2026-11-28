// BRO-7150: the shared GitHub client must not go out unauthenticated when the gh CLI is logged in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveToken } = require('./gh-api-client.js');

test('env token wins and the CLI is not asked', () => {
  let called = false;
  assert.equal(resolveToken({ env: { GH_TOKEN: 'envtok' }, exec: () => { called = true; return 'cli'; } }), 'envtok');
  assert.equal(called, false);
  assert.equal(resolveToken({ env: { GITHUB_TOKEN: 'ghtok' }, exec: () => 'cli' }), 'ghtok');
});

test('no env token falls back to gh auth token', () => {
  let args;
  assert.equal(resolveToken({ env: {}, exec: (cmd, a) => { args = [cmd, ...a]; return 'clitok\n'; } }), 'clitok');
  assert.deepEqual(args, ['gh', 'auth', 'token']);
});

test('gh missing or logged out yields null, never throws', () => {
  assert.equal(resolveToken({ env: {}, exec: () => { throw new Error('ENOENT'); } }), null);
  assert.equal(resolveToken({ env: {}, exec: () => '' }), null);
});
