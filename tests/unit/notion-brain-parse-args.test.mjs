import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// require() the REAL function — no reimplementation (CLAUDE.md §15).
const { parseArgs } = require(path.join(REPO_ROOT, 'scripts/lib/notion-brain-parse-args.js'));

test('--flag=value (eq-split form) already handled empty string', () => {
  assert.equal(parseArgs(['--outcome=']).outcome, '');
  assert.equal(parseArgs(['--outcome=hi']).outcome, 'hi');
});

test('--flag value sets the string value', () => {
  const args = parseArgs(['--outcome', 'hi']);
  assert.equal(args.outcome, 'hi');
});

test('--flag alone (no following token) sets boolean true', () => {
  const args = parseArgs(['--overwrite-outcome']);
  assert.equal(args['overwrite-outcome'], true);
});

test('BRO-344: --flag \'\' (explicit empty string) sets the value to empty string, not boolean true', () => {
  const args = parseArgs(['update', 'page-id', '--outcome', '', '--overwrite-outcome']);
  assert.equal(args.outcome, '', 'empty string must be consumed as the value, not coerced to true');
  assert.equal(args['overwrite-outcome'], true, 'the following flag must still parse as its own flag');
  assert.deepEqual(args._positional, ['update', 'page-id'], 'the empty string must not leak into positionals');
});

test('BRO-344: an empty string before a value-bearing flag does not swallow the next flag\'s own value', () => {
  const args = parseArgs(['--notes', '', '--key-files', 'foo.js']);
  assert.equal(args.notes, '');
  assert.equal(args['key-files'], 'foo.js');
});

test('a real next token that looks like a flag is not consumed as this flag\'s value', () => {
  const args = parseArgs(['--overwrite-outcome', '--outcome', 'hi']);
  assert.equal(args['overwrite-outcome'], true);
  assert.equal(args.outcome, 'hi');
});

test('a trailing flag with nothing after it sets boolean true, not undefined', () => {
  const args = parseArgs(['--outcome', 'hi', '--overwrite-outcome']);
  assert.equal(args['overwrite-outcome'], true);
});
