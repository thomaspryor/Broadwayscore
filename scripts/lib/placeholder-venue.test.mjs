import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isPlaceholderVenue } = require('./placeholder-venue.js');
const { sanitizeVenueForWrite } = require('./venue-classification.js');

test('BRO-6531: Lower East Side neighbourhood labels cannot be written as venues', () => {
  for (const venue of ['Lower E Side', 'Lower East Side', '  LOWER E SIDE  ']) {
    assert.deepEqual(isPlaceholderVenue(venue), { placeholder: true, reason: 'neighbourhood_blob' });
    assert.equal(sanitizeVenueForWrite(venue), null);
  }
  for (const venue of ['Lower E Side at Parkside Lounge', 'Lower East Side: Parkside Lounge']) {
    assert.equal(isPlaceholderVenue(venue).placeholder, true);
    assert.equal(sanitizeVenueForWrite(venue), null);
  }
});

test('BRO-6531: real venue names and trailing neighbourhoods remain valid', () => {
  for (const venue of ['The Parkside Lounge', 'Lower East Side Playhouse', 'Parkside Lounge, Lower East Side', 'Richard Rodgers Theatre']) {
    assert.equal(isPlaceholderVenue(venue).placeholder, false, venue);
    assert.equal(sanitizeVenueForWrite(venue), venue);
  }
});
