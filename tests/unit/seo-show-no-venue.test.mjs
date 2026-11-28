/**
 * Announced shows often have no theater yet (venue null). generateShowSchema
 * called toPostalAddress(null) and 500'd their /show/[slug] pages
 * (Dreamgirls, Private Lives, Let the Good Times Roll; BRO-5808), and the FAQ
 * said "has closed. It played at null".
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateShowSchema, generateShowFAQSchema } from '../../src/lib/seo';

const announced = {
  title: 'Dreamgirls',
  slug: 'dreamgirls',
  synopsis: null,
  venue: null,
  theaterAddress: null,
  category: 'broadway',
  status: 'announced',
  openingDate: null,
  closingDate: null,
};

test('a show with no theater gets the market stand-in location, not a crash', () => {
  const schema = generateShowSchema(announced);
  assert.equal(schema.location.name, 'Broadway Theater');
  assert.equal(schema.location.address.addressCountry, 'US');
  assert.equal(schema.organizer, undefined);
});

test('the FAQ never prints "null" or calls an announced show closed', () => {
  const text = JSON.stringify(generateShowFAQSchema(announced));
  assert.ok(!text.includes('null'), text);
  assert.ok(!/has closed/.test(text), text);
  assert.match(text, /has been announced\. Dates have not been set yet\./);
});

test('shows with a theater keep their FAQ wording and real location', () => {
  const open = { ...announced, title: 'Hamilton', slug: 'hamilton', venue: 'Richard Rodgers Theatre', theaterAddress: '226 W 46th St, New York, NY 10036', status: 'open', openingDate: '2015-08-06' };
  const text = JSON.stringify(generateShowFAQSchema(open));
  assert.match(text, /Yes, Hamilton is currently playing at Richard Rodgers Theatre /);
  assert.match(text, /Where is Hamilton playing/);
  const schema = generateShowSchema(open);
  assert.equal(schema.location.name, 'Richard Rodgers Theatre');
  assert.equal(schema.organizer.name, 'Richard Rodgers Theatre');
});

test('stand-in follows the market: Off-Broadway and West End', () => {
  assert.equal(generateShowSchema({ ...announced, category: 'off-broadway' }).location.name, 'Off-Broadway Theater');
  const we = generateShowSchema({ ...announced, category: 'west-end' }).location;
  assert.equal(we.name, 'West End Theatre');
  assert.equal(we.address.addressCountry, 'GB');
});
