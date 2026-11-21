// BRO-6771: image-only venue table is separate from the feeder-venue classifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { imageOnlyVenue, IMAGE_ONLY_VENUES, LISTING_SOURCES, listingSource, slug } = require('./regional-image-venues.js');
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

test('BRO-7265 DC/LA houses resolve to their own sites; renting houses and look-alikes do not', () => {
  for (const [venue, domain] of [
    ['Olney Theatre Center, Olney, MD', 'olneytheatre.org'], ['Round House Theatre, Bethesda, MD', 'roundhousetheatre.org'],
    ['GALA Hispanic Theatre, Washington, DC', 'galatheatre.org'],
    ['Theatre 40 at The Reuben Cordova Theatre, Beverly Hills, CA', 'theatre40.org'],
    ['Long Beach Playhouse, Long Beach, CA', 'lbplayhouse.org'], ['South Coast Repertory, Costa Mesa, CA', 'scr.org'],
    ['The Road on Magnolia, North Hollywood, CA', 'roadtheatre.org'], ['The Nocturne Theater, Glendale, CA', 'thenocturnetheatre.com'],
    ['Antaeus Theater, Glendale, CA', 'antaeus.org'],
  ]) assert.equal(imageOnlyVenue(venue)?.domain, domain, venue);
  for (const other of ['Woolly Mammoth Theatre, Washington, DC', 'El Portal Theatre, North Hollywood, CA', 'Madnani Theater, Los Angeles, CA',
    'Gunston Arts Center, Arlington, VA', 'Pasadena Playhouse, Pasadena, CA', 'Theatre 4 All', 'Road Runner Stage'])
    assert.equal(imageOnlyVenue(other), null, other);
});

test('BRO-7878 theatreWashington listing: DC shows only, slug with and without the leading article, original upload url', () => {
  const l = listingSource({ venue: 'Arena Stage, Washington, DC' });
  assert.equal(l.name, 'theatreWashington');
  assert.deepEqual(l.pageUrls({ title: 'The Motion' }), ['https://theatrewashington.org/shows/the-motion', 'https://theatrewashington.org/shows/motion']);
  assert.deepEqual(l.pageUrls({ title: 'A Fine Madness' }), ['https://theatrewashington.org/shows/a-fine-madness', 'https://theatrewashington.org/shows/fine-madness']);
  assert.deepEqual(l.pageUrls({ title: 'Hamlet' }), ['https://theatrewashington.org/shows/hamlet']);
  for (const v of ['Signature Theatre, Arlington, VA', 'Olney Theatre Center, Olney, MD', 'Pasadena Playhouse, Pasadena, CA', undefined])
    assert.equal(listingSource({ venue: v }), null, String(v));
  assert.equal(listingSource({ venue: 'Keegan Theatre, Washington, DC' }).name, 'theatreWashington');
  const html = '<meta property="og:image:alt" content="x"><img src="/themes/custom/backstage/dist/img/favicon-120.png"><img src="/sites/default/files/styles/landscape_810x405/public/2026-06/AFM%20KEY%20ART.jpg?itok=abc">';
  assert.equal(l.extractImage(html, 'https://theatrewashington.org/shows/fine-madness'), 'https://theatrewashington.org/sites/default/files/2026-06/AFM%20KEY%20ART.jpg');
  assert.equal(l.extractImage('<p>no art</p>', 'https://theatrewashington.org/shows/x'), null);
  const show = { title: 'A Fine Madness' };
  assert.equal(l.extractImage(html + '<h1>A Fine Madness</h1>', 'https://theatrewashington.org/shows/x', show), 'https://theatrewashington.org/sites/default/files/2026-06/AFM%20KEY%20ART.jpg');
  assert.equal(l.extractImage(html, 'https://theatrewashington.org/shows/x', show), null, 'page not about this show');
  assert.equal(l.extractImage('<h1>A Fine Madness</h1><img src="https://theatrewashington.org/sites/default/files/a.jpg"><img src="/sites/default/files/logo.png">', 'https://theatrewashington.org/shows/x', show), 'https://theatrewashington.org/sites/default/files/a.jpg');
  for (const s of LISTING_SOURCES) assert.ok(s.city.test(s.sample), `${s.name} sample must match its own city`);
});
