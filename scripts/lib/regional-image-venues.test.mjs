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
  // The invariant is per venue STRING (a venue matched by both tables would be classified one way
  // and image-sourced another), not per domain: Egg Theatre shares Theatre Royal Bath's site.
  for (const v of IMAGE_ONLY_VENUES) {
    assert.ok(v.sample, `${v.domain} needs a sample venue string`);
    assert.ok(v.re.test(v.sample), `${v.domain} sample "${v.sample}" must match its own regex`);
    assert.equal(REGIONAL_FEEDER_VENUES.some((f) => f.re.test(v.sample)), false, `${v.sample} is also a feeder venue`);
  }
});

test('imageless UK/Chicago/DC venues (2026-11-03 audit) resolve to a site, and no look-alike is captured', () => {
  for (const [venue, domain] of [
    ['HOME, Manchester', 'homemcr.org'], ['Octagon Theatre, Bolton', 'octagonbolton.co.uk'],
    ['Egg Theatre, Bath', 'theatreroyal.org.uk'], ['Ustinov, Bath', 'theatreroyal.org.uk'],
    ['A Red Orchid Theatre, Chicago, IL', 'aredorchidtheatre.org'], ['The Skokie, Skokie, IL', 'northlight.org'],
    ['Keegan Theatre, Washington, DC', 'keegantheatre.com'], ['Silver Spring Stage, Silver Spring, MD', 'ssstage.org'],
  ]) assert.equal(imageOnlyVenue(venue)?.domain, domain, venue);
  for (const other of ['Home for the Holidays Theatre', 'Hope Mill Theatre, Manchester', 'Steppenwolf Theatre, Chicago, IL', 'The Egg, Albany'])
    assert.equal(imageOnlyVenue(other), null, other);
});

test('Signature page url: season from the opening date, slug from the title', () => {
  const v = imageOnlyVenue('Signature Theatre, Arlington, VA');
  assert.deepEqual(v.pageUrls({ title: 'Pippin', openingDate: '2026-05-23' }), ['https://www.sigtheatre.org/shows-and-events/all-events/2025-2026/pippin']);
  assert.deepEqual(v.pageUrls({ title: "Merrily We Roll Along", openingDate: '2026-09-20' }), ['https://www.sigtheatre.org/shows-and-events/all-events/2026-2027/merrily-we-roll-along']);
  assert.deepEqual(v.pageUrls({ title: 'X' }), []);
  assert.equal(slug("The Colored Museum's Kin"), 'the-colored-museums-kin');
  assert.ok(v.genericImage.test('https://res.cloudinary.com/x/v1/Sig_Building_Email_Header'));
});
