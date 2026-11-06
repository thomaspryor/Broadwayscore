import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const { isWireSyndicatedCopy } = createRequire(import.meta.url)('./cross-outlet-triage.js');

test('non-wire outlet copy of a critic with an AP original in the show is syndication', () => {
  assert.strictEqual(isWireSyndicatedCopy('Mark Kennedy', 'denver-post', new Set(['Mark Kennedy'])), true);
});
test('no wire original, different critic, or the wire file itself is not exempt', () => {
  assert.strictEqual(isWireSyndicatedCopy('Mark Kennedy', 'denver-post', new Set()), false);
  assert.strictEqual(isWireSyndicatedCopy('Mark Kennedy', 'denver-post', new Set(['Jesse Green'])), false);
  assert.strictEqual(isWireSyndicatedCopy('Mark Kennedy', 'ap', new Set(['Mark Kennedy'])), false);
});
