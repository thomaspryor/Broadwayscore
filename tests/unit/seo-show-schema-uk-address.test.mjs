/**
 * generateShowSchema — individual show page JSON-LD (card #1451).
 *
 * toPostalAddress() only matched the US "street, city, ST 12345" format. A UK
 * theaterAddress (postcode, no US state code) fell through to the bare-string
 * return, silently dropping addressCountry from the schema — same bug class
 * as #1437, but on generateShowSchema (the individual /show/[slug] page),
 * which is higher-traffic than the browse ItemList #1437 fixed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateShowSchema } from '../../src/lib/seo';

const ukRegionalShow = {
  title: 'Game of Thrones: The Mad King',
  slug: 'game-of-thrones-the-mad-king-regional-2026',
  synopsis: 'A new production at the RSC.',
  venue: 'Royal Shakespeare Theatre',
  theaterAddress: 'Royal Shakespeare Theatre, Waterside, Stratford-upon-Avon CV37 6BB',
  category: 'regional',
  openingDate: '2026-09-01',
};

test('UK regional show theaterAddress emits addressCountry GB on the show page', () => {
  const schema = generateShowSchema(ukRegionalShow);
  const address = schema.location.address;

  assert.equal(address.addressCountry, 'GB');
  assert.equal(address['@type'], 'PostalAddress');
});

test('US show theaterAddress is unchanged — structured US address, country US', () => {
  const schema = generateShowSchema({
    title: 'Some Broadway Show',
    slug: 'some-broadway-show',
    synopsis: 'A show.',
    venue: 'Booth Theatre',
    theaterAddress: '226 W 46th St, New York, NY 10036',
    category: 'broadway',
    openingDate: '2026-09-01',
  });
  const address = schema.location.address;

  assert.equal(address.addressCountry, 'US');
  assert.equal(address.addressLocality, 'New York');
  assert.equal(address.addressRegion, 'NY');
  assert.equal(address.postalCode, '10036');
});
