import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { inheritUrlFromDuplicateLosers } = require('./duplicate-fold-url');

const files = {
  'ft--hemming.json': { url: null },
  'ft--unknown.json': { url: 'https://www.ft.com/content/abc', duplicateOf: 'ft--hemming.json' },
  'other.json': { url: 'https://x.com/a', duplicateOf: 'something-else.json' },
};
const load = (n) => files[n] || null;
const names = Object.keys(files);

test('winner without url inherits the loser url', () => {
  assert.strictEqual(inheritUrlFromDuplicateLosers('ft--hemming.json', files['ft--hemming.json'], names, load), 'https://www.ft.com/content/abc');
});
test('winner with a url is untouched', () => {
  assert.strictEqual(inheritUrlFromDuplicateLosers('ft--hemming.json', { url: 'https://keep.me/x' }, names, load), null);
});
test('empty-string winner url counts as missing', () => {
  assert.strictEqual(inheritUrlFromDuplicateLosers('ft--hemming.json', { url: '  ' }, names, load), 'https://www.ft.com/content/abc');
});
test('losers pointing elsewhere or without http url are ignored', () => {
  assert.strictEqual(inheritUrlFromDuplicateLosers('nobody.json', { url: null }, names, load), null);
  assert.strictEqual(inheritUrlFromDuplicateLosers('w.json', { url: null }, ['l.json'], () => ({ duplicateOf: 'w.json', url: 'not-a-url' })), null);
});
test('multiple losers pick deterministically', () => {
  const m = { 'a.json': { duplicateOf: 'w.json', url: 'https://z.com/1' }, 'b.json': { duplicateOf: 'w.json', url: 'https://a.com/1' } };
  const get = (n) => m[n];
  assert.strictEqual(inheritUrlFromDuplicateLosers('w.json', {}, ['a.json', 'b.json'], get), 'https://a.com/1');
  assert.strictEqual(inheritUrlFromDuplicateLosers('w.json', {}, ['b.json', 'a.json'], get), 'https://a.com/1');
});
