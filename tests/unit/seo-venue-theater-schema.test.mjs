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
