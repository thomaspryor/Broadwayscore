import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { isNewRunTooFreshToClose } = require('../../scripts/lib/showscore-closure-guard');

test('Slam Frank: opens today, ShowScore Closed is held', () => {
  assert.equal(isNewRunTooFreshToClose({ openingDate: '2026-10-04', previewsStartDate: '2026-09-17' }, '2026-10-04'), true);
});
test('future opening is held', () => {
  assert.equal(isNewRunTooFreshToClose({ openingDate: '2026-11-01' }, '2026-10-04'), true);
});
test('opened 7 days ago still held, 8 days ago not', () => {
  assert.equal(isNewRunTooFreshToClose({ openingDate: '2026-09-27' }, '2026-10-04'), true);
  assert.equal(isNewRunTooFreshToClose({ openingDate: '2026-09-26' }, '2026-10-04'), false);
});
test('no openingDate falls back to previews start (14 days)', () => {
  assert.equal(isNewRunTooFreshToClose({ previewsStartDate: '2026-09-25' }, '2026-10-04'), true);
  assert.equal(isNewRunTooFreshToClose({ previewsStartDate: '2026-09-10' }, '2026-10-04'), false);
});
test('no dates: not held', () => {
  assert.equal(isNewRunTooFreshToClose({}, '2026-10-04'), false);
});
