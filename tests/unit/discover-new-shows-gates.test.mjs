// Verify isNonTheaterContent / isOneNightShow keep filtering galas,
// benefits, readings, and education-program entries that Atlantic /
// Vineyard / Signature / MCC venue pages list alongside mainstage
// productions. Per pre-mortem primary scenario: these patterns are
// the only thing standing between the new sources and shows.json.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isNonTheaterContent, londonListingTitleRejected } = require('../../scripts/discover-new-shows.js');

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

// shouldExcludeVenueShow: the WE solo-performer heuristic was REMOVED 2026-07-31
// after a live TodayTix audit showed its "FirstName LastName" hits were real
// productions (Space Dogs, Kimberly Akimbo, Jane Eyre, Twelfth Night…) — plays
// are routinely titled after their protagonist. Two-word titles must pass;
// scripts/discover-new-shows.test.mjs pins that direction with real show titles.
const { shouldExcludeVenueShow } = require('../../scripts/discover-new-shows.js');

test('shouldExcludeVenueShow keeps two-word titles, determiner-led or not', () => {
  const keep = [
    'The Producers',   // Menier 2026 — the 2026-07-21 miss
    'A Number',        // Caryl Churchill
    'An Inspector',    // determiner + single noun
    'Space Dogs',      // Other Palace 2026 — the 2026-07-31 miss
    'Jane Eyre',       // protagonist-titled show, person-name-shaped
  ];
  for (const title of keep) {
    assert.equal(shouldExcludeVenueShow(title), false, `should NOT exclude: ${title}`);
  }
});

test('shouldExcludeVenueShow still drops workshops and masterclasses', () => {
  assert.equal(shouldExcludeVenueShow('Comedy Workshop'), true);
  assert.equal(shouldExcludeVenueShow('Acting Masterclass'), true);
});

test('Menier linkPattern admits show slugs, rejects booking-system and utility slugs', () => {
  const { VENUE_LISTING_PAGES } = require('../../scripts/discover-new-shows.js');
  const menier = VENUE_LISTING_PAGES.find(v => v.name === 'Menier Chocolate Factory');
  assert.ok(menier, 'Menier config present');
  const admit = ['/tickets/midnight-at-the-never-get', '/tickets/the-producers', '/tickets/tru', '/tickets/gifted'];
  const reject = ['/tickets/series/MATNG', '/tickets/gift-vouchers', '/tickets/vouchers', '/tickets/membership', '/tickets/support-us', '/tickets/donate', '/tickets/access'];
  for (const href of admit) assert.ok(menier.linkPattern.test(href), `should admit: ${href}`);
  for (const href of reject) assert.ok(!menier.linkPattern.test(href), `should reject: ${href}`);
});

test('londonListingTitleRejected: the OLT/Theatremonkey title gate rejects concerts, NT Live screenings and prizes, keeps plays (BRO-4204 S8-T2)', () => {
  // The Rachel Zegler concert reached shows.json on 2026-09-29 because the
  // listing loops only ran the substring lists; NON_THEATRE_TITLE_RE lived in
  // isNonTheaterContent(), which those loops never call.
  for (const title of ['Rachel Zegler – Live in London', 'NT Live: All My Sons', 'Stiles + Drewe Best New Song Prize 2026', 'Hamilton in Concert', 'Bar Events']) {
    assert.equal(londonListingTitleRejected(title), true, `${title} must be rejected`);
  }
  for (const title of ['Romeo & Juliet', 'Guess How Much I Love You?', 'Lost in Del Valle', 'Dick Whittington: Adults Only', 'The Lehman Trilogy']) {
    assert.equal(londonListingTitleRejected(title), false, `${title} must be kept`);
  }
  assert.equal(londonListingTitleRejected(''), false);
  assert.equal(londonListingTitleRejected(undefined), false);
});

test('shouldExcludeVenueShow (venue-page candidates) runs the same title gate: events, screenings and prizes never reach staging', () => {
  for (const title of ['Bar Events', 'NT Live: Les Liaisons Dangereuses', 'Stiles + Drewe Best New Song Prize 2026', 'Rachel Zegler – Live in London']) {
    assert.equal(shouldExcludeVenueShow(title), true, `${title} must be excluded`);
  }
  for (const title of ['Flush', 'A Ghost in Your Ear', 'Dick Whittington and His Cat']) {
    assert.equal(shouldExcludeVenueShow(title), false, `${title} must be kept`);
  }
});
