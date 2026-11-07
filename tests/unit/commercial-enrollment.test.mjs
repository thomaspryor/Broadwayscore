import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findUnenrolled, nonprofitHouseCandidate } = require('../../scripts/lib/commercial-enrollment');
const { NP_VENUES, venueMatches } = require('../../scripts/lib/nonprofit-venues');

test('announced, upcoming, previews and open Broadway shows without a record are enrolled', () => {
  const shows = ['announced', 'upcoming', 'previews', 'open'].map(status => ({ slug: `s-${status}`, category: 'broadway', status }));
  assert.deepEqual(findUnenrolled(shows, {}).map(s => s.slug), ['s-announced', 's-upcoming', 's-previews', 's-open']);
});

test('closed, off-Broadway, west-end and dev rows are never enrolled; existing records are skipped', () => {
  const shows = [
    { slug: 'closed', category: 'broadway', status: 'closed' },
    { slug: 'ob', category: 'off-broadway', status: 'upcoming' },
    { slug: 'we', category: 'west-end', status: 'upcoming' },
    { slug: 'dev', status: 'upcoming', _devOnly: true },
    { slug: 'has', category: 'broadway', status: 'upcoming' },
    { slug: 'constructor', category: 'broadway', status: 'upcoming' },
    { slug: 'nokey', category: 'broadway', status: 'upcoming' },
    { category: 'broadway', status: 'upcoming' },
  ];
  assert.deepEqual(findUnenrolled(shows, { has: {} }).map(s => s.slug), ['constructor', 'nokey']);
});

test('a duplicate slug is enrolled once', () => {
  const shows = [{ slug: 'a', status: 'upcoming' }, { slug: 'a', status: 'previews' }];
  assert.equal(findUnenrolled(shows, {}).length, 1);
});

test('nonprofit house flags a candidate and nothing else', () => {
  assert.equal(nonprofitHouseCandidate({ venue: 'Todd Haimes Theatre' }), 'Roundabout Theatre Company');
  assert.equal(nonprofitHouseCandidate({ venue: 'Booth Theatre' }), null);
  assert.equal(nonprofitHouseCandidate(null), null);
});

test('an id-keyed legacy record counts as enrolled', () => {
  assert.equal(findUnenrolled([{ id: 'x-2026', slug: 'x', status: 'upcoming' }], { 'x-2026': {} }).length, 0);
});

test('venue spellings in shows.json resolve to their nonprofit, and the record check accepts that pairing', () => {
  assert.equal(nonprofitHouseCandidate({ venue: 'Hayes Theater' }), 'Second Stage Theater');
  assert.equal(nonprofitHouseCandidate({ venue: 'Vivian Beaumont Theater - Lincoln Center Theater' }), 'Lincoln Center Theater');
  assert.equal(venueMatches(NP_VENUES['Second Stage Theater'], 'Hayes Theater'), true);
  assert.equal(venueMatches(NP_VENUES['Second Stage Theater'], 'Booth Theatre'), false);
});

test('a slug with a pending add-commercial-entry plan is left to the plan', () => {
  const { pendingAddCommercialSlugs } = require('../../scripts/lib/commercial-enrollment.js');
  const plans = [
    { status: 'pending', plan: { actions: [{ type: 'add-commercial-entry', slug: 'x' }, { type: 'data-edit', slug: 'y' }] } },
    { status: 'applied', plan: { actions: [{ type: 'add-commercial-entry', slug: 'z' }] } },
  ];
  const skip = pendingAddCommercialSlugs(plans);
  assert.deepEqual([...skip], ['x']);
  const shows = ['x', 'z'].map(slug => ({ id: slug + '-2027', slug, status: 'announced', category: 'broadway', market: 'broadway', type: 'play' }));
  assert.deepEqual(findUnenrolled(shows, {}, skip).map(s => s.slug), ['z']);
});
