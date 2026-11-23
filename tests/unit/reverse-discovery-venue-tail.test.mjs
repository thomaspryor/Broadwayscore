// BRO-8149: "<SHOW> at <Venue>" roundup headlines resolve to the catalogued show only when its venue proves the tail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const rd = require('../../scripts/lib/reverse-discovery.js');

const shows = [
  { id: 'good-thief', title: 'The Good Thief', slug: 'the-good-thief', category: 'off-broadway', status: 'open', venue: 'Irish Repertory Theatre' },
  { id: 'midnight', title: 'Midnight', slug: 'midnight', category: 'off-broadway', status: 'open', venue: 'Some Other Theatre' },
];
const idx = rd.buildShowTitleIndex(shows, 'nyc');

test('venue tail that matches the catalogued venue resolves', () => {
  assert.equal(rd.resolveMatchedShowId('THE GOOD THIEF at Irish Repertory Theatre', idx), 'good-thief');
  assert.equal(rd.titleMatchesIndex('THE GOOD THIEF at Irish Repertory Theatre', idx), true);
});

test('a title containing " at the " is not suppressed by a same-head show at another venue', () => {
  assert.equal(rd.resolveMatchedShowId('MIDNIGHT AT THE NEVER GET', idx), null);
});
