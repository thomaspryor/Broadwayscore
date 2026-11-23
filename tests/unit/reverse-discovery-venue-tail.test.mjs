// BRO-8149: "<SHOW> at <Venue>" roundup headlines resolve to the catalogued show only when its venue proves the tail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const rd = require('../../scripts/lib/reverse-discovery.js');

const shows = [
  { id: 'good-thief', title: 'The Good Thief', slug: 'the-good-thief', category: 'off-broadway', status: 'open', venue: 'Irish Repertory Theatre' },
  { id: 'lost-boys', title: 'The Lost Boys', slug: 'the-lost-boys', category: 'broadway', status: 'open', venue: 'Palace Theatre' },
  { id: 'cell-show', title: 'The Charioteer', slug: 'the-charioteer', category: 'off-broadway', status: 'open', venue: 'The Cell' },
  { id: 'tour-show', title: 'The Great Gatsby', slug: 'the-great-gatsby', category: 'broadway', status: 'open', venue: 'North American Tour' },
  { id: 'old-run', title: 'Old Run', slug: 'old-run', category: 'off-broadway', status: 'closed', venue: 'Irish Repertory Theatre' },
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

test('titleMatchesIndex (the alert-suppression path) stays false for the Midnight case', () => {
  assert.equal(rd.titleMatchesIndex('MIDNIGHT AT THE NEVER GET', idx), false);
});

test('generic tails ("at the Theatre", "at the Center") and partial words do not count as venue proof', () => {
  assert.equal(rd.resolveMatchedShowId('The Lost Boys at the Theatre', idx), null);
  assert.equal(rd.resolveMatchedShowId('The Lost Boys at New World Stages', idx), null);
  assert.equal(rd.resolveMatchedShowId('The Charioteer at the Cellar', idx), null);
  assert.equal(rd.resolveMatchedShowId('The Great Gatsby at Broadway', idx), null);
  assert.equal(rd.resolveMatchedShowId('The Great Gatsby at North American Tour', idx), null);
});

test('a real venue still resolves, and a closed show at that venue does not', () => {
  assert.equal(rd.resolveMatchedShowId('The Lost Boys at Palace Theatre', idx), 'lost-boys');
  assert.equal(rd.resolveMatchedShowId('Old Run at Irish Repertory Theatre', idx), null);
});
