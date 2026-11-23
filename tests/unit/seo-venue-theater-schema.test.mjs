/**
 * BRO-8088: Off-Broadway and London venue pages emit a PerformingArtsTheater schema with
 * the verified address, the right page URL and country, and the official site as sameAs.
 * Also: a suite/floor part stays in streetAddress instead of leaking into addressLocality.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateTheaterSchema, generateShowSchema } from '../../src/lib/seo';

test('London venue page schema carries its own URL, GB address and official site', () => {
  const s = generateTheaterSchema({
    name: 'Donmar Warehouse', slug: 'donmar-warehouse', path: '/west-end/theater/donmar-warehouse', country: 'GB',
    address: '41 Earlham Street, London WC2H 9LX', website: 'https://www.donmarwarehouse.com/', pastShows: [],
  });
  assert.equal(s.url, 'https://broadwayscorecard.com/west-end/theater/donmar-warehouse');
  assert.equal(s.address.addressCountry, 'GB');
  assert.deepEqual(s.sameAs, ['https://www.donmarwarehouse.com/']);
});

test('Broadway theater schema keeps its /theater URL and US country by default', () => {
  const s = generateTheaterSchema({ name: 'Lena Horne Theatre', slug: 'lena-horne-theatre', address: '256 W 47th St, New York, NY 10036', pastShows: [] });
  assert.equal(s.url, 'https://broadwayscorecard.com/theater/lena-horne-theatre');
  assert.equal(s.address.addressLocality, 'New York');
  assert.equal(s.sameAs, undefined);
});

test('suite part stays in streetAddress', () => {
  const s = generateTheaterSchema({ name: 'Bated Breath', slug: 'x', address: '39 W 14th Street, Suite 301, New York, NY 10011', pastShows: [] });
  assert.equal(s.address.streetAddress, '39 W 14th Street, Suite 301');
  assert.equal(s.address.addressLocality, 'New York');
  assert.equal(s.address.postalCode, '10011');
});

// BRO-8173: map position and seat count reach search engines, and only beside a real address.
test('theater schema carries geo and seat count when known', () => {
  const s = generateTheaterSchema({
    name: 'The Players Theatre', slug: 'the-players-theatre', path: '/off-broadway/theater/the-players-theatre',
    address: '115 MacDougal St, New York, NY 10012', geo: { lat: 40.7301, lng: -74.0004 }, capacity: 248, pastShows: [],
  });
  assert.deepEqual(s.geo, { '@type': 'GeoCoordinates', latitude: 40.7301, longitude: -74.0004 });
  assert.equal(s.maximumAttendeeCapacity, 248);
});

test('geo is dropped without an address, and a zero/absent capacity is omitted', () => {
  const s = generateTheaterSchema({ name: 'X', slug: 'x', geo: { lat: 1, lng: 2 }, capacity: 0, pastShows: [] });
  assert.equal(s.geo, undefined);
  assert.equal(s.maximumAttendeeCapacity, undefined);
});
