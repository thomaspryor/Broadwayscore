// BRO-6771: image-only venue table is separate from the feeder-venue classifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { imageOnlyVenue, IMAGE_ONLY_VENUES } = require('./regional-image-venues.js');
const { REGIONAL_FEEDER_VENUES } = require('./aggregator-candidate-extract.js');

test('Signature Theatre resolves to its own site', () => {
  assert.equal(imageOnlyVenue('Signature Theatre, Arlington, VA').domain, 'sigtheatre.org');
  assert.equal(imageOnlyVenue('Arena Stage, Washington, DC'), null);
  assert.equal(imageOnlyVenue(undefined), null);
});

test('no image-only venue is also a feeder venue (the two tables must not overlap)', () => {
  for (const v of IMAGE_ONLY_VENUES) {
    assert.equal(REGIONAL_FEEDER_VENUES.some((f) => f.domain === v.domain), false, v.domain);
  }
});
