// BRO-5456: check-remote-branch-absent.js pure logic + the safe-form gate that admits it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isValidBranchName, exitCodeForLsRemote } = require('./check-remote-branch-absent.js');
const { isSafeCheckCommand } = require('./lib/check-paths.js');

test('isValidBranchName accepts land/feature style names', () => {
  assert.equal(isValidBranchName('land/bro-6682-opening-night-leftovers'), true);
  assert.equal(isValidBranchName('main'), true);
  assert.equal(isValidBranchName('a/b.c_d-e'), true);
});

test('isValidBranchName refuses option injection, traversal, shell chars and empties', () => {
  for (const bad of ['', '-x', '--upload-pack=evil', 'a/../b', 'a//b', 'a b', 'a;rm', '$(x)', 'a/.hidden', 'x.lock', 'a'.repeat(201)]) {
    assert.equal(isValidBranchName(bad), false, bad);
  }
});

test('exitCodeForLsRemote: git 2 (no match) is absent, a listed ref is present, errors never pass', () => {
  assert.equal(exitCodeForLsRemote(2, '', 'land/x'), 0);
  assert.equal(exitCodeForLsRemote(0, 'abc123\trefs/heads/land/x\n', 'land/x'), 1);
  assert.equal(exitCodeForLsRemote(0, 'abc123\trefs/heads/land/x-2\n', 'land/x'), 0);
  assert.equal(exitCodeForLsRemote(128, '', 'land/x'), 2);
  assert.equal(exitCodeForLsRemote(-1, '', 'land/x'), 2);
});

test('safe-form gate admits the command shape and agrees with the script on bad names', () => {
  assert.equal(isSafeCheckCommand('node scripts/check-remote-branch-absent.js --branch=land/bro-6682-opening-night-leftovers'), true);
  for (const bad of ['-x', 'a/../b', 'a;rm', 'a b', 'a'.repeat(201)]) {
    assert.equal(isSafeCheckCommand(`node scripts/check-remote-branch-absent.js --branch=${bad}`), false, bad);
  }
  assert.equal(isSafeCheckCommand('node scripts/check-remote-branch-absent.js'), false);
});
