/**
 * BRO-6570: Time Out London reviews were filed under split ids
 * ('timeoutlondon', 'time-out-lond_on'). The registry must resolve both to
 * timeout-london so the rebuild does not mint a second outlet.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeOutlet } = require('./lib/review-normalization.js');

for (const label of ['timeoutlondon', 'time-out-lond_on', 'Time Out London']) {
  test(`"${label}" resolves to timeout-london`, () => {
    const r = normalizeOutlet(label);
    assert.equal(r, 'timeout-london');
  });
}
