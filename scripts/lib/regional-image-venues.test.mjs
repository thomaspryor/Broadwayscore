// BRO-6771: image-only venue table is separate from the feeder-venue classifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { imageOnlyVenue, IMAGE_ONLY_VENUES, slug } = require('./regional-image-venues.js');
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

test('Signature page url: season from the opening date, slug from the title', () => {
  const v = imageOnlyVenue('Signature Theatre, Arlington, VA');
  assert.deepEqual(v.pageUrls({ title: 'Pippin', openingDate: '2026-05-23' }), ['https://www.sigtheatre.org/shows-and-events/all-events/2025-2026/pippin']);
  assert.deepEqual(v.pageUrls({ title: "Merrily We Roll Along", openingDate: '2026-09-20' }), ['https://www.sigtheatre.org/shows-and-events/all-events/2026-2027/merrily-we-roll-along']);
  assert.deepEqual(v.pageUrls({ title: 'X' }), []);
  assert.equal(slug("The Colored Museum's Kin"), 'the-colored-museums-kin');
  assert.ok(v.genericImage.test('https://res.cloudinary.com/x/v1/Sig_Building_Email_Header'));
});
