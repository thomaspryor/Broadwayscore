// LIVE-DATA-LANE: reads data/reviews.json (untracked core data); data/shows.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-7621 class guard: every live review on the site reviews its own production, so the
// "<title> at <another New York house>" census rule must never fire on one. Before the
// company/venue groups it fired on 4 (Lobby Hero at Second Stage, Laowang at Primary Stages,
// The Saviors at Atlantic, twice).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { urlNamesOtherNyHouse } = require('../../scripts/lib/census-other-place.js');

const have = fs.existsSync(new URL('../../data/reviews.json', import.meta.url))
  && fs.existsSync(new URL('../../data/shows.json', import.meta.url));

test('urlNamesOtherNyHouse never fires on a live review of its own show', { skip: !have && 'data files not present' }, () => {
  const shows = require('../../data/shows.json');
  const byId = new Map((Array.isArray(shows) ? shows : shows.shows).map((s) => [s.id, s]));
  const rv = require('../../data/reviews.json');
  const hits = (Array.isArray(rv) ? rv : rv.reviews)
    .filter((r) => r && r.url && byId.has(r.showId) && urlNamesOtherNyHouse(r.url, byId.get(r.showId)))
    .map((r) => `${r.showId} ${r.url}`);
  assert.deepEqual(hits, []);
});
