'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { dropUndefinedFields } = require('./drop-undefined.js');

test('drops undefined, keeps null, false, 0 and empty string', () => {
  const out = dropUndefinedFields({ a: undefined, b: null, c: false, d: 0, e: '', f: 'x' });
  assert.deepEqual(Object.keys(out), ['b', 'c', 'd', 'e', 'f']);
  assert.equal('a' in out, false);
});

// Class guard: the serializer must strip unset keys for every caller, not only
// the `slim` market pages, or /browse/* HTML grows ~250KB past its budget again.
test('serializeShowForClient strips undefined fields on every path', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../src/lib/serialize-show.ts'), 'utf8');
  const body = src.slice(src.indexOf('export function serializeShowForClient'), src.indexOf('export function createShowSerializer'));
  assert.match(body, /dropUndefinedFields\(out\)/);
  assert.doesNotMatch(body, /if \(!overrides\?\.slim\) return out;/);
});
