/**
 * generateItemListSchema — regional-show country in JSON-LD (card #1437).
 *
 * category: 'regional' covers both US Broadway-feeders (A.R.T., Goodman) and
 * UK West End-feeders (RSC Stratford, Chichester Festival Theatre). Without a
 * theaterAddress, the address previously fell back to the raw venue string
 * (or, with no venue at all, a hardcoded 'New York, NY' + US country) with no
 * way to signal GB for a UK regional show. getUkRegionalVenueCity() (backed
 * by data/uk-regional-venues.json) now supplies a real city/country for the
 * known UK venues; everything else is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateItemListSchema } from '../../src/lib/seo';

test('UK regional show (RSC, no theaterAddress) emits addressCountry GB, not New York NY', () => {
  const schema = generateItemListSchema([
    {
      name: 'Game of Thrones: The Mad King',
      url: 'https://broadwayscorecard.com/show/game-of-thrones-the-mad-king-regional-2026',
      venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon',
      category: 'regional',
    },
  ], 'Regional Shows');

  const location = schema.itemListElement[0].item.location;
  assert.equal(location.address.addressCountry, 'GB');
  assert.equal(location.address.addressLocality, 'Stratford-upon-Avon');
  assert.notEqual(location.address, 'New York, NY');
  assert.ok(!JSON.stringify(location).includes('New York, NY'));
});

test('US regional show (no theaterAddress) is unchanged — plain venue string, no country claim', () => {
  const schema = generateItemListSchema([
    {
      name: 'Some New Play',
      url: 'https://broadwayscorecard.com/show/some-new-play-regional-2026',
      venue: 'Goodman Theatre, Chicago',
      category: 'regional',
    },
  ], 'Regional Shows');

  const location = schema.itemListElement[0].item.location;
  assert.equal(location.address, 'Goodman Theatre, Chicago');
});
