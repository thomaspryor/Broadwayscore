// Run: node --test scripts/lib/related-shows-mobile.test.mjs
// The app reads public/data/related-shows-mobile.json; these pin the compact format it decodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildMobileRelated } = require('./related-shows-mobile.js');
const { isEligibleSource, closedPoolAllows, qualityBonus } = require('./related-shows-eligibility.js');

const SHOWS = [
  { id: 'a-2026', slug: 'a' }, { id: 'b-2020', slug: 'b-2020' },
  { id: 'c-2019', slug: 'c' }, { id: 'd-2018', slug: 'd' },
];
const decode = (out, id) => {
  const row = out.r[out.ids.indexOf(id)];
  return row && { open: row[0].map(i => out.ids[i]), closed: row[1].map(i => out.ids[i]) };
};

test('picks round-trip through the id table, slugs resolve to ids, unknowns and self are dropped', () => {
  const out = buildMobileRelated({
    'a-2026': { relatedOpenIds: ['b-2020', 'c', 'nope', 'a-2026'], relatedClosedIds: ['d-2018'] },
  }, SHOWS);
  assert.deepEqual(decode(out, 'a-2026'), { open: ['b-2020', 'c-2019'], closed: ['d-2018'] });
  assert.equal(out._v, 1);
});

test('sources missing from shows.json and entries with no usable picks are omitted', () => {
  const out = buildMobileRelated({
    'ghost': { relatedOpenIds: ['b-2020'] },
    'b-2020': { relatedOpenIds: ['nope'], relatedClosedIds: [] },
    'c-2019': {},
  }, SHOWS);
  assert.deepEqual(out.r, {});
});

test('active shows are eligible with no reviews; closed shows still need 5', () => {
  assert.equal(isEligibleSource({ status: 'previews' }, 0), true);
  assert.equal(isEligibleSource({ status: 'open' }, 2), true);
  assert.equal(isEligibleSource({ status: 'upcoming' }, 0), true);
  assert.equal(isEligibleSource({ status: 'closed' }, 4), false);
  assert.equal(isEligibleSource({ status: 'closed' }, 5), true);
});

test('closed pool floor and quality bonus', () => {
  assert.equal(closedPoolAllows(59.9), false);
  assert.equal(closedPoolAllows(60), true);
  assert.equal(closedPoolAllows(null), true);
  assert.equal(qualityBonus(100), 5);
  assert.equal(qualityBonus(null), 0);
  assert.ok(qualityBonus(90) > qualityBonus(70));
});
