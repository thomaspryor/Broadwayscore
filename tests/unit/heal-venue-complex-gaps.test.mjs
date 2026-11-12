import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { healCandidateGaps } = require('../../scripts/lib/heal-venue-complex-gaps.js');
const { findCandidateGaps } = require('../../scripts/lib/venue-complex-audit.js');

const shows = [
  { id: 'a', category: 'off-broadway', venue: 'Theatre Row' },
  { id: 'b', category: 'off-broadway', venue: 'The Lion Theatre at Theatre Row' },
];
const defs = { 'theatre-row': { name: 'Theatre Row', subVenueSlugs: [] } };
const isOB = (s) => s.category === 'off-broadway';

test('fixture has an unlinked gap before healing', () => {
  assert.ok(Object.keys(findCandidateGaps(shows, defs, isOB)).length > 0);
});
test('heal links the gap so the live-data gate condition clears', () => {
  const { defs: healed, added } = healCandidateGaps(shows, defs, isOB);
  assert.ok(added['theatre-row'].includes('the-lion-theatre-at-theatre-row'));
  assert.deepEqual(findCandidateGaps(shows, healed, isOB), {});
  assert.deepEqual(defs['theatre-row'].subVenueSlugs, [], 'input not mutated');
});

test('keyword-only matches (different venues) are NOT auto-linked; they stay for a human', () => {
  const sh = [
    { id: 'a', category: 'off-broadway', venue: 'Pershing Square Signature Center' },
    { id: 'b', category: 'off-broadway', venue: 'One Times Square Signature Skywalk' },
  ];
  const d = { 'pershing-square-signature-center': { name: 'Pershing Square Signature Center', subVenueSlugs: [] } };
  assert.ok(Object.keys(findCandidateGaps(sh, d, isOB)).length > 0, 'fixture must be a heuristic candidate');
  const { added } = healCandidateGaps(sh, d, isOB);
  assert.deepEqual(added, {});
});
test('a slug matched by two complexes is never auto-linked', () => {
  const sh = [{ id: 'b', category: 'off-broadway', venue: 'Foo Theatre at Alpha Hall Beta Hall' }];
  const d = { alpha: { name: 'Alpha Hall', subVenueSlugs: [] }, beta: { name: 'Beta Hall', subVenueSlugs: [] } };
  assert.deepEqual(healCandidateGaps(sh, d, isOB).added, {});
});
