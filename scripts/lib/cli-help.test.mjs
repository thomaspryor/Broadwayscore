import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { hasHelpFlag } = require('./cli-help.js');

test('hasHelpFlag: detects --help and -h anywhere in argv', () => {
  assert.equal(hasHelpFlag(['--help']), true);
  assert.equal(hasHelpFlag(['-h']), true);
  assert.equal(hasHelpFlag(['--model', 'sonnet', '--help']), true);
  assert.equal(hasHelpFlag(['--id', '12', '-h']), true);
});

test('hasHelpFlag: false when neither flag is present', () => {
  assert.equal(hasHelpFlag([]), false);
  assert.equal(hasHelpFlag(['--dry-run', '--model', 'opus']), false);
  // must not false-positive on flags that merely contain "h" or "help"-like text
  assert.equal(hasHelpFlag(['--helpful']), false);
});
