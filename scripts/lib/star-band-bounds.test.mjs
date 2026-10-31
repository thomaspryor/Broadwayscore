import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { starBandBounds, scoreOutsideStarBand } = createRequire(import.meta.url)('./star-band-bounds.js');

test('whole stars map to their band', () => {
  assert.deepEqual(starBandBounds('5/5 stars'), [91, 100]);
  assert.deepEqual(starBandBounds('2/5'), [31, 50]);
});
test('3.5/5 is not read as 5/5 and spans two bands', () => {
  assert.deepEqual(starBandBounds('3.5/5'), [51, 90]);
  assert.equal(scoreOutsideStarBand('3.5/5', 70), false);
});
test('a 5/5 stored at 70 is outside its band', () => {
  assert.equal(scoreOutsideStarBand('5/5 stars', 70), true);
  assert.equal(scoreOutsideStarBand('5/5 stars', 100), false);
});
test('non-/5 and unparseable ratings are skipped', () => {
  assert.equal(starBandBounds('70%'), null);
  assert.equal(starBandBounds('8/10'), null);
  assert.equal(starBandBounds(null), null);
});
