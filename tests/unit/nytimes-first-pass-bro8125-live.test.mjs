// LIVE-DATA-LANE: reads the real data/shows.json (the Lefty and Grinch collisions only exist in production data); runs in check-corpus-drift.yml, not the blocking batch.
// BRO-8125 class guard: the fixture tests pass on fixtures that differ from production data, so this one loads the real file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rss = require('../../scripts/lib/rss-discovery.js');
const names = require('../../scripts/lib/show-names.js');

test('real data/shows.json: Lefty review matches, Grinch sequel news does not', () => {
  names.setPressNameShows(null);
  assert.equal(rss.titleMatchesShow('‘Waiting for Lefty’ Review: A Labor Play Rouses Again', 'Clifford Odets’ Waiting for Lefty', {}), true);
  const grinch = 'Dr. Seuss\u2019 How the Grinch Stole Christmas!';
  assert.equal(rss.titleMatchesShow('Jim Carrey Returns for How the Grinch Stole Christmas! Sequel', grinch, {}), false);
});
