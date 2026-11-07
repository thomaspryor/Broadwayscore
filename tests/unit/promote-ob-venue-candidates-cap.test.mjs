import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { MAX_PROMOTE_PER_RUN, assertPromotionCap } = require('../../scripts/lib/ob-promotion-cap');

test('OB promotions use the same conservative 20-show cap as the WE promoter', () => {
  assert.equal(MAX_PROMOTE_PER_RUN, 20);
});

for (const count of [0, 1, 19, 20]) {
  test(`${count} confirmed promotions fit within the per-run cap`, () => {
    assert.doesNotThrow(() => assertPromotionCap(count));
  });
}

for (const count of [21, 106, 1000]) {
  test(`${count} confirmed promotions abort the entire batch`, () => {
    assert.throws(() => assertPromotionCap(count), {
      message: `Abort: ${count} candidates would be promoted, exceeding MAX_PROMOTE_PER_RUN=20. No shows promoted; candidates remain staged.`,
    });
  });
}
