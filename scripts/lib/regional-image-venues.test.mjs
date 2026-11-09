// BRO-6771: image-only venue table is separate from the feeder-venue classifier.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { imageOnlyVenue, IMAGE_ONLY_VENUES, FEEDER_IMAGE_SITES, feederImageSite, isVenueUtilityPage, extractKeyArtImage, isOwnProductionStill, slug } = require('./regional-image-venues.js');

test('a venue-page image rejected only as a stage photo is this production; any other issue is not', () => {
  assert.equal(isOwnProductionStill({ match: false, imageType: 'production_still', issues: ['production_photo'] }), true);
  assert.equal(isOwnProductionStill({ match: false, imageType: 'production_still', issues: [] }), true);
  assert.equal(isOwnProductionStill({ match: false, imageType: 'production_still', issues: ['production_photo', 'wrong_production'] }), false);
  assert.equal(isOwnProductionStill({ match: false, imageType: 'other', issues: ['placeholder'] }), false);
  assert.equal(isOwnProductionStill({ match: true, imageType: 'production_still', issues: [] }), false);
  assert.equal(isOwnProductionStill(null), false);
});
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

// BRO-6703: Òran Mór's plays are listed on playpiepint.com, and a title like "Contact" matched
// the venue's Contact Us page (og:image = venue logo); the self-heal looped 7 times.
test('Òran Mór shows are sourced from playpiepint.com event pages', () => {
  for (const v of ['Òran Mór, Glasgow', 'Oran Mor, Glasgow', 'òran mór']) assert.equal(feederImageSite(v)?.domain, 'playpiepint.com', v);
  assert.deepEqual(feederImageSite('Òran Mór, Glasgow').pageUrls({ title: 'Contact' }), ['https://playpiepint.com/whats-on/event/contact/']);
  assert.deepEqual(feederImageSite('Òran Mór, Glasgow').pageUrls({ title: "Someone's Knockin' at the Door" }), ['https://playpiepint.com/whats-on/event/someones-knockin-at-the-door/']);
  for (const other of ['Hope Mill Theatre, Manchester', 'Tron Theatre, Glasgow', 'Moran Theatre', undefined]) assert.equal(feederImageSite(other), null, String(other));
  // These override a FEEDER venue's image site only, so each sample must be a feeder venue.
  for (const v of FEEDER_IMAGE_SITES) assert.ok(REGIONAL_FEEDER_VENUES.some((f) => f.re.test(v.sample)), `${v.sample} is not a feeder venue`);
});

test('venue utility pages are never taken as a show page', () => {
  for (const u of ['https://oran-mor.co.uk/contact/', 'https://playpiepint.com/about/contact/', 'https://x.org/', 'https://x.org/privacy-policy', 'https://x.org/visiting-accessibility/', 'https://x.org/about-us'])
    assert.equal(isVenueUtilityPage(u), true, u);
  for (const u of ['https://playpiepint.com/whats-on/event/contact/', 'https://hopemilltheatre.co.uk/event/little-shop-of-horrors/', 'https://x.org/contact-sport/', 'not a url'])
    assert.equal(isVenueUtilityPage(u), false, u);
});

test('key art: og:image, then twitter:image, then the hero <img>', () => {
  const base = 'https://hopemilltheatre.co.uk/event/little-shop-of-horrors/';
  assert.deepEqual(extractKeyArtImage('<meta property="og:image" content="https://a.b/x.jpg?a=1&amp;b=2" />', base), { url: 'https://a.b/x.jpg?a=1&b=2', via: 'og:image' });
  assert.deepEqual(extractKeyArtImage('<meta content="/y.png" property="og:image">', base), { url: 'https://hopemilltheatre.co.uk/y.png', via: 'og:image' });
  assert.deepEqual(extractKeyArtImage('<meta name="twitter:image" content="https://a.b/t.jpg">', base), { url: 'https://a.b/t.jpg', via: 'twitter:image' });
  // Hope Mill's real markup: no og:image, the art sits in div.content-hero.
  const hopeMill = '<img src="/logo.svg" class="logo"><div class="event-information__container grid"><div class="content-hero ar--16-9"><img decoding="async" src="https://hopemilltheatre.co.uk/app/uploads/2025/05/LSOH-USE-BANNER.png" class="rounded-large"/></div>';
  assert.deepEqual(extractKeyArtImage(hopeMill, base), { url: 'https://hopemilltheatre.co.uk/app/uploads/2025/05/LSOH-USE-BANNER.png', via: 'hero img' });
  // Play Pie Pint pages without og:image: the <img> carries the hero class itself.
  const ppp = '<img class="hide-for-sr" src="https://playpiepint.com/logo.png" alt="Logo"><img width="2000" height="1333" src="https://playpiepint.com/app/uploads/2025/10/DSC_9243.jpg" class="responsive hero-image size-hero" alt="Zoe Bullock in Night, Idiot">';
  assert.deepEqual(extractKeyArtImage(ppp, 'https://playpiepint.com/whats-on/event/night-idiot/'), { url: 'https://playpiepint.com/app/uploads/2025/10/DSC_9243.jpg', via: 'hero img' });
  // A page with only logos and body images has no key art.
  assert.equal(extractKeyArtImage('<img class="logo" src="/l.png"><div class="body"><img src="/b.jpg"></div>', base), null);
  assert.equal(extractKeyArtImage('', base), null);
});
