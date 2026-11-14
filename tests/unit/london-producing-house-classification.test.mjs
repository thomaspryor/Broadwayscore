import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isWestEndVenue } = require('../../scripts/lib/venue-classification.js');

// Locks the West End / Off-West End boundary for London producing houses,
// decided 2026-07-01. The prior state was inconsistent: Regent's Park Open Air
// was in west-end-venues.json (→ West End) while its peer producing house
// Shakespeare's Globe was not (→ Off-West End), so the two Midsummer productions
// playing at once landed in different sections. Rule chosen: keep the large
// high-profile subsidised houses (National, Old Vic, Royal Court) as West End,
// but treat the open-air / reconstructed producing houses (Regent's Park, Globe)
// as Off-West End. This test fails if a venue drifts back across that line.

test('Off-West End producing houses are NOT classified West End', () => {
  for (const venue of [
    "Regent's Park Open Air Theatre",
    "Shakespeare's Globe",
    'Sam Wanamaker Playhouse',
    'Bridge Theatre',
    'Young Vic',
    'Almeida Theatre',
    'Donmar Warehouse',
    'Kiln Theatre',
    'Hampstead Theatre',
  ]) {
    assert.equal(isWestEndVenue(venue), false, `${venue} should be Off-West End`);
  }
});

test('West End houses (incl. the big subsidised ones we keep as WE) stay West End', () => {
  for (const venue of [
    'Cambridge Theatre',   // commercial Theatreland — must not be caught by "bridge" substring
    'Dorfman',             // National Theatre
    'Adelphi Theatre',
    'London Coliseum',
  ]) {
    assert.equal(isWestEndVenue(venue), true, `${venue} should be West End`);
  }
});

test('the two concurrent Midsummer venues both resolve Off-West End', () => {
  // Globe production and Regent's Park production play at the same time with
  // very different scores; both belong on the Off-West End page.
  assert.equal(isWestEndVenue("Shakespeare's Globe"), false);
  assert.equal(isWestEndVenue("Regent's Park Open Air Theatre"), false);
});
