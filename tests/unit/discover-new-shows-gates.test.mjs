// Verify isNonTheaterContent / isOneNightShow keep filtering galas,
// benefits, readings, and education-program entries that Atlantic /
// Vineyard / Signature / MCC venue pages list alongside mainstage
// productions. Per pre-mortem primary scenario: these patterns are
// the only thing standing between the new sources and shows.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isNonTheaterContent } = require('../../scripts/discover-new-shows.js');

function gateCandidate(title) {
  return {
    displayName: title,
    name: title,
    subcategories: [{ name: 'Off Broadway' }],
    venue: { name: 'TBA' },
    description: '',
  };
}

test('isNonTheaterContent filters gala / benefit / reading-series titles', () => {
  const reject = [
    'Atlantic Spring Gala 2026',
    'Annual Gala Benefit',
    'MCC Reading Series: New Voices',
    'Signature Benefit Reading',
    'Vineyard Fundraiser',
    'Atlantic Education Program Showcase',
    'Staged Reading of New Plays',
  ];
  for (const title of reject) {
    assert.equal(isNonTheaterContent(gateCandidate(title)), true, `should filter: ${title}`);
  }
});

test('isNonTheaterContent does NOT filter real OB show titles', () => {
  const keep = [
    'The Reservoir',                           // Atlantic mainstage
    'Bughouse',                                // Vineyard mainstage
    'The Receptionist',                        // Signature mainstage
    'Birthright',                              // MCC mainstage
    'Indian Princesses',                       // Atlantic mainstage
    'Via Galactica',                           // 1972 Broadway — contains "gala" substring
    'Beneficence',                             // hypothetical title containing "benefit" substring (mid-word)
    'A Reading of Hamlet by Patrick Stewart',  // mainstage solo concert reading, not "reading series"
  ];
  for (const title of keep) {
    assert.equal(isNonTheaterContent(gateCandidate(title)), false, `should NOT filter: ${title}`);
  }
});

test('isNonTheaterContent still filters legacy excluded titles', () => {
  const reject = [
    'BATSU!',                          // restaurant game show
    'Selected Shorts: Whatever',       // book reading concert
    'The Museum of Broadway',          // explicit exclude
  ];
  for (const title of reject) {
    assert.equal(isNonTheaterContent(gateCandidate(title)), true, `legacy filter still applies: ${title}`);
  }
});
