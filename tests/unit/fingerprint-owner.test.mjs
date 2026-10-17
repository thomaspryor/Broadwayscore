import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { pickFingerprintOwners, duplicateTextTarget } = require('../../scripts/lib/fingerprint-owner.js');

// BRO-4188: 1776-2022 deadline--greg-evans.json (same-url loser, duplicateOf
// pete-hammond) sorts before deadline--pete-hammond.json (canonical).
test('same-url loser sorting first never owns the fingerprint', () => {
  const owners = pickFingerprintOwners([
    { file: 'deadline--greg-evans.json', fingerprint: 'F', duplicateOf: 'deadline--pete-hammond.json' },
    { file: 'deadline--pete-hammond.json', fingerprint: 'F' },
  ]);
  assert.equal(owners.get('F'), 'deadline--pete-hammond.json');
});

test('a canonical carrying last week\'s stale pointer still beats its loser', () => {
  const owners = pickFingerprintOwners([
    { file: 'a.json', fingerprint: 'F', duplicateOf: 'b.json' },
    { file: 'b.json', fingerprint: 'F', duplicateTextOf: 'a.json' },
  ]);
  assert.equal(owners.get('F'), 'b.json');
});

test('plain duplicates keep readdir order (first file owns)', () => {
  const owners = pickFingerprintOwners([
    { file: 'a.json', fingerprint: 'F' },
    { file: 'b.json', fingerprint: 'F' },
    { file: 'c.json', fingerprint: 'G' },
  ]);
  assert.equal(owners.get('F'), 'a.json');
  assert.equal(owners.get('G'), 'c.json');
});

test('duplicateTextTarget refuses self and two-file cycles', () => {
  assert.equal(duplicateTextTarget('a.json', 'a.json', {}), null);
  assert.equal(duplicateTextTarget('a.json', undefined, undefined), null);
  assert.equal(duplicateTextTarget('a.json', 'b.json', { duplicateOf: 'a.json' }), null);
  assert.equal(duplicateTextTarget('a.json', 'b.json', { duplicateTextOf: 'a.json' }), null);
  assert.equal(duplicateTextTarget('a.json', 'b.json', {}), 'b.json');
});
