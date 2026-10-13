/** BRO-5243: reverify-stale-cv-promoted --file selector and its write hold. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseFileSpecs, holdFileModeVerdict } = require('../../scripts/lib/reverify-file-mode.js');

test('parses show/file pairs', () => {
  assert.deepEqual(parseFileSpecs('burn-this-2019/wsj--terry-teachout.json,a/b.json'),
    [{ showId: 'burn-this-2019', file: 'wsj--terry-teachout.json' }, { showId: 'a', file: 'b.json' }]);
});

test('rejects traversal, extra segments, absolute and non-json specs', () => {
  for (const bad of ['../b.json', 'a/../b.json', 'a/b.json/x', '/etc/passwd', 'a/b.txt', 'a', '/b.json']) {
    assert.throws(() => parseFileSpecs(bad), /--file expects/, bad);
  }
});

test('an unclean verdict on a hand-picked row is held unless opted in', () => {
  assert.equal(holdFileModeVerdict({ fileMode: true, clean: false, allowNewExclusion: false }), true);
  assert.equal(holdFileModeVerdict({ fileMode: true, clean: false, allowNewExclusion: true }), false);
  assert.equal(holdFileModeVerdict({ fileMode: true, clean: true, allowNewExclusion: false }), false);
  assert.equal(holdFileModeVerdict({ fileMode: false, clean: false, allowNewExclusion: false }), false);
});
