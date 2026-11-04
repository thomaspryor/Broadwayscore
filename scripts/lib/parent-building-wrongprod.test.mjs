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
test('a human-confirmed flag (true) or human-cleared (false) is never a candidate', () => {
  assert.equal(pick(girls, flagged('at the Young Vic', { humanReviewedWrongProduction: true })).candidate, false);
  assert.equal(pick(girls, flagged('at the Young Vic', { humanReviewedWrongProduction: false })).candidate, false);
});
test('other national companies are not the National Theatre', () => {
  assert.equal(pick({ venue: 'Lyttelton Theatre', category: 'west-end' }, flagged('National Theatre of Scotland production')).candidate, false);
});

// BRO-6946: too-short candidates are triaged for a full-text fetch, never cleared by metadata
const { shortCandidateDecision: decide } = require('./parent-building-wrongprod.js');
const run = { previewsStartDate: '2025-07-10', openingDate: '2025-07-23', closingDate: '2025-09-13' };
const rec = (publishDate, reason = 'Review of Inter Alia at the National Theatre, wrong venue', url = 'https://example.com/r') => ({ wrongProduction: true, publishDate, wrongProductionReason: reason, url });
test('short: in-window or undated with a url is worth fetching; never a direct clear', () => {
  assert.equal(decide(run, rec('2025-07-24')).decision, 'fetch');
  assert.equal(decide(run, rec(undefined)).decision, 'fetch');
  for (const d of ['2025-07-24', undefined]) assert.notEqual(decide(run, rec(d)).decision, 'clear');
});
test('short: out-of-window date, no url, or other-production wording holds', () => {
  assert.equal(decide(run, rec('2024-12-06')).decision, 'hold');
  assert.equal(decide(run, rec('2026-10-28')).decision, 'hold');
  assert.equal(decide(run, rec('2025-07-24', undefined, '')).decision, 'hold');
  assert.equal(decide(run, rec('2025-07-24', "National Theatre's 2018 production")).decision, 'hold');
  assert.equal(decide(run, rec('2025-07-24', 'a UK touring production')).decision, 'hold');
  assert.equal(decide(run, rec('2025-07-24', 'anticipatory_pre_opening_post National Theatre')).decision, 'hold');
});
const { isCleanVerdict: clean } = require('./parent-building-wrongprod.js');
const ok = { isValid: true, wrongProduction: false, confidence: 'high', verifiedBy: 'llm:x' };
test('clean verdict needs explicit booleans from a real LLM verdict', () => {
  assert.equal(clean(ok), true);
  assert.equal(clean({ ...ok, wrongProduction: undefined }), false);
  assert.equal(clean({ ...ok, wrongProduction: 'true' }), false);
  assert.equal(clean({ ...ok, isValid: 'true' }), false);
  assert.equal(clean({ ...ok, confidence: 'low' }), false);
  assert.equal(clean({ ...ok, verifiedBy: 'heuristic' }), false);
  assert.equal(clean(null), false);
});
