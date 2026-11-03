// Run: node --test scripts/lib/parent-building-wrongprod.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parentBuildingFlagCandidate: pick } = require('./parent-building-wrongprod.js');

const girls = { venue: 'The Maria Theatre', category: 'off-west-end' };
const flagged = (reason, extra = {}) => ({ wrongProduction: true, wrongProductionReason: reason, ...extra });

test('flag naming the parent building of the show\'s own stage is a candidate', () => {
  assert.deepEqual(pick(girls, flagged('Review is of a production at the Young Vic, not The Maria')), { candidate: true, parent: 'Young Vic' });
  assert.equal(pick({ venue: 'Lyttelton Theatre', category: 'west-end' }, flagged('staged at National Theatre earlier')).candidate, true);
});
test('reason from contentVerification also counts', () => {
  assert.equal(pick(girls, { wrongProduction: true, contentVerification: { reasoning: 'This was at the Young Vic' } }).candidate, true);
});
test('non-matching cases', () => {
  assert.equal(pick({ venue: 'Gielgud Theatre', category: 'west-end' }, flagged('at the Young Vic')).candidate, false);
  assert.equal(pick(girls, flagged('different production in Chicago')).candidate, false);
  assert.equal(pick(girls, { ...flagged('at the Young Vic'), wrongProduction: false }).candidate, false);
  assert.equal(pick(girls, flagged('at the Young Vic', { wrongProductionOverride: true })).candidate, false);
  assert.equal(pick(girls, flagged('Young Victoria film')).candidate, false);
  assert.equal(pick(null, flagged('Young Vic')).candidate, false);
});
