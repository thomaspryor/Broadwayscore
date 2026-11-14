import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { matchTheatrToShows, THEATR_SKIP_SHOWS } = require('../../scripts/scrape-theatr-audience.js');

// Synthetic shows.json — three same-titled-revival collisions reproducing
// the 2026-05-24 contamination triage (audience-buzz commit 67dd4435)
// plus a control show without a collision.
const ourShows = [
  { id: 'pal-joey-2008', title: 'Pal Joey', category: 'broadway', openingDate: '2008-12-18', status: 'closed' },
  { id: 'pal-joey-1976', title: 'Pal Joey', category: 'broadway', openingDate: '1976-06-27', status: 'closed' },
  { id: 'show-boat-1994', title: 'Show Boat', category: 'broadway', openingDate: '1994-10-02', status: 'closed' },
  { id: 'show-boat-1983', title: 'Show Boat', category: 'broadway', openingDate: '1983-04-24', status: 'closed' },
  { id: 'the-merchant-of-venice-2010', title: 'The Merchant of Venice', category: 'broadway', openingDate: '2010-11-13', status: 'closed' },
  { id: 'the-merchant-of-venice-1989', title: 'The Merchant of Venice', category: 'broadway', openingDate: '1989-12-19', status: 'closed' },
  { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', openingDate: '2015-08-06', status: 'open' },
];

function theatrEntry(name) {
  return {
    id: 'tid-' + name.toLowerCase().replace(/\s/g, '-'),
    name,
    eventCategory: 'Broadway',
    totalWatchedUsers: 30,
  };
}

describe('THEATR_SKIP_SHOWS guard', () => {
  test('skip set contains the 3 contamination IDs', () => {
    assert.ok(THEATR_SKIP_SHOWS.has('pal-joey-2008'));
    assert.ok(THEATR_SKIP_SHOWS.has('show-boat-1994'));
    assert.ok(THEATR_SKIP_SHOWS.has('the-merchant-of-venice-2010'));
  });

  test('matcher drops Theatr matches that would land on a skip-listed show', () => {
    const matches = matchTheatrToShows(
      [theatrEntry('Pal Joey'), theatrEntry('Show Boat'), theatrEntry('The Merchant of Venice')],
      ourShows
    );
    const ids = matches.map(m => m.show.id);
    assert.ok(!ids.includes('pal-joey-2008'), `expected pal-joey-2008 to be skipped, got: ${ids.join(',')}`);
    assert.ok(!ids.includes('show-boat-1994'), `expected show-boat-1994 to be skipped, got: ${ids.join(',')}`);
    assert.ok(!ids.includes('the-merchant-of-venice-2010'), `expected the-merchant-of-venice-2010 to be skipped, got: ${ids.join(',')}`);
  });

  test('matcher does not silently fall through to the prior revival when skipped', () => {
    // After skipping pal-joey-2008, matcher must NOT re-map "Pal Joey" to
    // pal-joey-1976 (the older revival). Skip = no match at all.
    const matches = matchTheatrToShows([theatrEntry('Pal Joey')], ourShows);
    const ids = matches.map(m => m.show.id);
    assert.strictEqual(ids.length, 0, `expected zero matches for Pal Joey, got: ${ids.join(',')}`);
  });

  test('non-skip-listed shows still match normally (control)', () => {
    const matches = matchTheatrToShows([theatrEntry('Hamilton')], ourShows);
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0].show.id, 'hamilton-2015');
  });
});
