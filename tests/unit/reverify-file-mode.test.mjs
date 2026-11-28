/** BRO-5243: reverify-stale-cv-promoted --file selector and its write hold. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseFileSpecs, fileModeHoldReason } = require('../../scripts/lib/reverify-file-mode.js');

test('parses show/file pairs', () => {
  assert.deepEqual(parseFileSpecs('burn-this-2019/wsj--terry-teachout.json,a/b.json'),
    [{ showId: 'burn-this-2019', file: 'wsj--terry-teachout.json' }, { showId: 'a', file: 'b.json' }]);
});

test('rejects traversal, extra segments, absolute and non-json specs', () => {
  for (const bad of ['../b.json', 'a/../b.json', 'a/b.json/x', '/etc/passwd', 'a/b.txt', 'a', '/b.json']) {
    assert.throws(() => parseFileSpecs(bad), /--file expects/, bad);
  }
});

const VALID = { isValid: true, wrongArticle: false, wrongProduction: false, isFilmTv: false, confidence: 'medium' };
const hold = (over) => fileModeHoldReason({ fileMode: true, data: {}, result: VALID, allowNewExclusion: false, ...over });

test('a valid verdict on an unflagged row is written, even at medium confidence', () => {
  assert.equal(hold({}), null);
  assert.equal(fileModeHoldReason({ fileMode: false, data: { wrongShow: true }, result: { isValid: false } }), null, 'only --file mode holds');
});

test('a verdict that would newly exclude a hand-picked row is held unless opted in', () => {
  for (const r of [{ isValid: false }, { ...VALID, wrongArticle: true }, { ...VALID, wrongProduction: true }, { ...VALID, isFilmTv: true }]) {
    assert.match(hold({ result: r }), /newly exclude/);
    assert.equal(hold({ result: r, allowNewExclusion: true }), null);
  }
});

test('a flagged row is never written in --file mode (its flag may be a human verdict; BRO-5261)', () => {
  for (const flag of ['wrongShow', 'wrongProduction', 'isNonReview']) {
    assert.match(hold({ data: { [flag]: true } }), new RegExp(flag));
    assert.match(hold({ data: { [flag]: true }, allowNewExclusion: true }), new RegExp(flag));
  }
});
