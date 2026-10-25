// Runs scripts/test-tr-roundup-negative-cache.js (real-lib tests for the
// theatre.reviews negative cache) so the unit-test glob in CI picks it up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'test-tr-roundup-negative-cache.js');

test('theatre.reviews negative cache', () => {
  const out = execFileSync('node', [script], { encoding: 'utf8' });
  assert.match(out, /\d+ passed/);
});
