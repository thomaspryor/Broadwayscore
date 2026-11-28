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

test('website prefers https when either source gives it', () => {
  assert.equal(pickWebsite('http://galleryplayers.com/', 'https://galleryplayers.com'), 'https://galleryplayers.com/');
});

test('a house-number range ("1a/1b") still agrees with its first number on the same street', () => {
  assert.ok(addressesAgree('1a Almeida Street, London N1 1TA', '1a/1b Almeida Street, London N1 1TA'));
  assert.ok(addressesAgree('10-12 Main Street, New York, NY 10001', '10 Main St, New York, NY 10001'));
  // Different house numbers still disagree.
  assert.ok(!addressesAgree('1 Almeida Street, London N1 1TA', '7 Almeida Street, London N1 1TA'));
});

test('a folded page keeps facts researched under its old spelling, never overriding its own', () => {
  const { fillFromFolded } = require('./venue-info-agree');
  const d = { fields: { address: '115 MacDougal St, New York, NY 10012' }, how: { address: 'gemini+openai' }, geo: { lat: 1, lng: 2 } };
  fillFromFolded(d, [
    { fields: { address: 'Other St', capacity: 248 }, how: { address: 'gemini+openai', capacity: 'gemini+openai' }, geo: { lat: 9, lng: 9 } },
  ]);
  assert.equal(d.fields.address, '115 MacDougal St, New York, NY 10012');
  assert.deepEqual(d.geo, { lat: 1, lng: 2 });
  assert.equal(d.fields.capacity, 248);
  assert.equal(d.how.capacity, 'gemini+openai');
  const e = fillFromFolded({ fields: {}, how: {}, geo: null }, [{ fields: { address: 'X St' }, how: { address: 'gemini+openai' }, geo: null }]);
  assert.equal(e.fields.address, undefined, 'an address without a geocode never moves');
});

test('access/seat answers researched under a folded spelling reach the merged page', () => {
  const { pickWithFolded } = require('./venue-info-agree');
  const store = { 'off-broadway/the-sheen-center': { a: 1 }, 'off-broadway/sheen-center': undefined };
  assert.deepEqual(pickWithFolded(store, 'off-broadway/sheen-center'), { a: 1 });
  assert.deepEqual(pickWithFolded({ 'off-broadway/sheen-center': { own: 1 }, 'off-broadway/the-sheen-center': { a: 1 } }, 'off-broadway/sheen-center'), { own: 1 });
  assert.equal(pickWithFolded(store, 'london/sheen-center'), undefined, 'never crosses markets');
});

test('pickWithFolded: a failed own record never hides a usable folded one', () => {
  const { pickWithFolded } = require('./venue-info-agree');
  const ok = (r) => !!(r.gemini && r.openai && !r.gemini.error && !r.openai.error);
  const good = { gemini: { a: 1 }, openai: { a: 1 } };
  const store = { 'off-broadway/sheen-center': { gemini: { error: 'x' }, openai: {} }, 'off-broadway/the-sheen-center': good };
  assert.equal(pickWithFolded(store, 'off-broadway/sheen-center', undefined, ok), good);
  const none = { 'off-broadway/sheen-center': { none: 'no access wording' } };
  assert.deepEqual(pickWithFolded(none, 'off-broadway/sheen-center', undefined, ok), { none: 'no access wording' }, 'nothing usable: own record as-is');
  const seats = { 'off-broadway/sheen-center': { seatplan: null, aviewfrommyseat: null }, 'off-broadway/the-sheen-center': { seatplan: 'u' } };
  assert.deepEqual(pickWithFolded(seats, 'off-broadway/sheen-center', undefined, (r) => !!(r.seatplan || r.aviewfrommyseat)), { seatplan: 'u' });
});

test('fillFromFolded records which folded spelling gave each field', () => {
  const { fillFromFolded } = require('./venue-info-agree');
  const d = fillFromFolded({ fields: { website: 'w' }, how: {}, geo: null }, [{ key: 'london/dorfman', fields: { website: 'x', capacity: 400 }, how: { capacity: 'gemini+openai' }, geo: null }]);
  assert.deepEqual(d.foldedFrom, { capacity: 'london/dorfman' });
  assert.equal(d.fields.website, 'w');
});
