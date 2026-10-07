import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { execErrorDetail } = require('./exec-error-detail.js');

test('strips the "Command failed: <cmd>" echo, keeps the real stderr', () => {
  const err = new Error('Command failed: git -C /x push origin main\nfatal: could not read Username\n');
  assert.equal(execErrorDetail(err), "fatal: could not read Username");
});

test('a plain (non-command-shaped) error message passes through unchanged', () => {
  assert.equal(execErrorDetail(new Error('ENOENT: no such file')), 'ENOENT: no such file');
});

test('caps at maxLen (default 200)', () => {
  const long = 'Command failed: x\n' + 'y'.repeat(300);
  assert.equal(execErrorDetail(long ? new Error(long) : null).length, 200);
  assert.equal(execErrorDetail(new Error(long), 50).length, 50);
});

test('maxLen=0 disables truncation', () => {
  const long = 'Command failed: x\n' + 'y'.repeat(300);
  assert.equal(execErrorDetail(new Error(long), 0).length, 300);
});

// ship-check P2: empty stderr strips to '' (falsy) — must fall back to the
// ORIGINAL message, not return an empty string that looks like "no error".
test('empty stderr after the command echo falls back to the original message', () => {
  const err = new Error('Command failed: git -C /x push origin main\n');
  assert.equal(execErrorDetail(err), err.message);
  assert.notEqual(execErrorDetail(err), '');
});
