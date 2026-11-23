'use strict';
// BRO-8088: the rules that decide when two independent sources agree on a venue fact.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  pickWebsite, streetKey, postcodeOf, addressesAgree, websitesAgree, capacitiesAgree, yearsAgree, operatorsAgree, agree, inCity,
} = require('./venue-info-agree');

test('streetKey normalizes street words, directions and ordinals', () => {
  assert.deepEqual(streetKey('302 West 45th Street, New York, NY 10036'), { number: '302', street: 'w 45th st' });
  assert.deepEqual(streetKey('302 W 45th St'), { number: '302', street: 'w 45th st' });
  assert.deepEqual(streetKey('11-13 Clifton Terrace, London N4 3JP'), { number: '11', street: 'clifton ter' });
});

test('postcodeOf reads UK postcodes and US ZIPs', () => {
  assert.equal(postcodeOf('41 Earlham Street, London WC2H 9LX'), 'WC2H9LX');
  assert.equal(postcodeOf('115 MacDougal St, New York, NY 10012'), '10012');
  assert.equal(postcodeOf('115 MacDougal St, New York'), null);
});

test('same place written two ways agrees', () => {
  assert.ok(addressesAgree('115 MacDougal Street, New York, NY 10012', '115 MacDougal St, New York, NY 10012'));
  assert.ok(addressesAgree('340 W 50th St, New York, NY 10019', '340 West 50th Street, Manhattan, NY 10019'));
  assert.ok(addressesAgree('41 Earlham Street, London WC2H 9LX', '41 Earlham St, Covent Garden, London WC2H 9LX'));
});

test('different house number, street or postcode disagrees', () => {
  assert.ok(!addressesAgree('115 MacDougal St, New York, NY 10012', '117 MacDougal St, New York, NY 10012'));
  assert.ok(!addressesAgree('115 MacDougal St, New York, NY 10012', '115 Bleecker St, New York, NY 10012'));
  assert.ok(!addressesAgree('115 MacDougal St, New York, NY 10012', '115 MacDougal St, New York, NY 10014'));
  assert.ok(!addressesAgree('302 W 45th St', '302 E 45th St'));
  assert.ok(!addressesAgree(null, '302 W 45th St'));
});

test('London venue with no house number agrees only on full postcode plus a street word', () => {
  assert.ok(addressesAgree('The Cut, London SE1 8LZ', 'The Cut, Waterloo, London SE1 8LZ'));
  assert.ok(!addressesAgree('The Cut, London SE1 8LZ', 'Upper Ground, London SE1 8LZ'));
});

test('websites agree on host, capacity within 2 seats, years exactly, operators by significant words', () => {
  assert.ok(websitesAgree('https://www.theplayerstheatre.com/', 'theplayerstheatre.com/about'));
  assert.ok(!websitesAgree('https://www.theplayerstheatre.com/', 'https://www.telecharge.com/players'));
  assert.ok(capacitiesAgree(199, 200));
  assert.ok(!capacitiesAgree(248, 50));
  assert.ok(!capacitiesAgree(0, 1));
  assert.ok(yearsAgree(1977, '1977'));
  assert.ok(!yearsAgree(1961, 1962));
  assert.ok(operatorsAgree('The Shubert Organization', 'Shubert Organization, Inc.'));
  assert.ok(!operatorsAgree('Nederlander Organization', 'Shubert Organization'));
});

test('agree() keeps only agreed fields and lists the rest as disagreements', () => {
  const g = { exists: true, address: '115 MacDougal Street, New York, NY 10012', website: 'https://www.theplayerstheatre.com', capacity: 248, yearOpened: null, operator: null };
  const o = { exists: true, address: '115 MacDougal St, New York, NY 10012', website: 'http://theplayerstheatre.com/', capacity: 50, yearOpened: null, operator: null };
  const { fields, disagreements } = agree(g, o);
  assert.equal(fields.address, '115 MacDougal Street, New York, NY 10012');
  assert.equal(fields.website, 'https://www.theplayerstheatre.com/');
  assert.equal(fields.capacity, undefined);
  assert.deepEqual(disagreements, [{ field: 'capacity', gemini: 248, openai: 50 }]);
});

test('agree() publishes nothing when either source says the venue is not real', () => {
  assert.deepEqual(agree({ exists: false }, { exists: true, address: '1 Main St' }).fields, {});
  assert.deepEqual(agree(null, { exists: true, address: '1 Main St' }).fields, {});
});

test('a field only one source gave is a disagreement, never published', () => {
  const { fields, disagreements } = agree({ exists: true, yearOpened: 2004 }, { exists: true, yearOpened: null });
  assert.equal(fields.yearOpened, undefined);
  assert.equal(disagreements[0].field, 'yearOpened');
});

test('inCity boxes', () => {
  assert.ok(inCity(40.7301, -74.0003, 'nyc'));
  assert.ok(!inCity(51.51, -0.12, 'nyc'));
  assert.ok(inCity(51.5138, -0.1272, 'london'));
});

test('website keeps the venue page when both sources name it, else the homepage', () => {
  assert.equal(pickWebsite('https://lwtheatres.co.uk/theatres/adelphi/', 'lwtheatres.co.uk/theatres/adelphi'), 'https://lwtheatres.co.uk/theatres/adelphi');
  assert.equal(pickWebsite('https://www.atgtickets.com/venues/richmond-theatre/', 'https://www.atgtickets.com/venues/new-wimbledon-theatre/'), 'https://www.atgtickets.com/');
  assert.equal(pickWebsite('https://www.donmarwarehouse.com', 'https://www.donmarwarehouse.com/'), 'https://www.donmarwarehouse.com/');
});
