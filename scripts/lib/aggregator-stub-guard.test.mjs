/**
 * aggregatorStubRejection: the guard on gather-reviews.js's BWW/LBO excerpt-stub
 * path (BRO-4884). Colocated so CI's scripts/lib/*.test.mjs glob runs it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { aggregatorStubRejection } = require('./aggregator-stub-guard.js');

const ohio = {
  id: 'how-to-dance-in-ohio-2023',
  creativeTeam: [{ name: 'Sammi Cannold', role: 'Director' }, { name: 'Jacob Yandura', role: 'Music' }],
};

test('incident: roundup fragment as outlet and the director as critic is refused', () => {
  const r = aggregatorStubRejection({ outletId: 'how-to-dance-in-ohio-is-an-underdog-itself', criticName: 'Sammi Cannold', show: ohio });
  assert.notEqual(r, null);
});

test('a creative team member as critic is refused even under a real outlet', () => {
  assert.equal(aggregatorStubRejection({ outletId: 'nytimes', criticName: 'Sammi Cannold', show: ohio }), 'creditedPersonAsCritic');
});

test('a sentence-fragment outlet id is refused even when the critic is unbylined', () => {
  const r = aggregatorStubRejection({ outletId: 'how-to-dance-in-ohio-is-an-underdog-itself', criticName: 'Unknown', show: ohio });
  assert.ok(['junkOutlet', 'suspiciousOutlet'].includes(r), r);
});

test('ordinary stubs pass, including unbylined ones and shows with no record', () => {
  assert.equal(aggregatorStubRejection({ outletId: 'nytimes', criticName: 'Jesse Green', show: ohio }), null);
  assert.equal(aggregatorStubRejection({ outletId: 'thestage', criticName: 'Unknown', show: ohio }), null);
  assert.equal(aggregatorStubRejection({ outletId: 'guardian', criticName: 'Arifa Akbar', show: null }), null);
});
