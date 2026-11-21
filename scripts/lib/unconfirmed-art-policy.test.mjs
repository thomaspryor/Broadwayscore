import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { USER_UPLOADED_TIERS, unconfirmedArtReason } = require('./unconfirmed-art-policy.js');

test('user-uploaded tiers refuse the verifier fail-open answer', () => {
  assert.ok(USER_UPLOADED_TIERS.has('Mezzanine'));
  // Exactly what verifyImage returns with no key / download error / API error.
  const failOpen = { match: true, confidence: 'low', issues: [], description: 'Verification skipped' };
  assert.match(unconfirmedArtReason('Mezzanine', failOpen), /low confidence/);
});

test('user-uploaded tiers accept medium and high confidence matches', () => {
  assert.equal(unconfirmedArtReason('Mezzanine', { match: true, confidence: 'high' }), null);
  assert.equal(unconfirmedArtReason('Mezzanine', { match: true, confidence: 'medium' }), null);
});

test('a confident no is left to the normal rejection path; a low-confidence no is refused', () => {
  assert.equal(unconfirmedArtReason('Mezzanine', { match: false, confidence: 'high' }), null);
  assert.ok(unconfirmedArtReason('Mezzanine', { match: false, confidence: 'low' }));
});

test('publisher-art tiers keep their existing behaviour', () => {
  for (const t of ['TodayTix scrape', 'Playbill', 'IBDB', 'Theatr', 'ShowScore', 'Google Images']) {
    assert.equal(unconfirmedArtReason(t, { match: true, confidence: 'low' }), null, t);
  }
});

test('missing or malformed verifier output is refused for user-uploaded tiers', () => {
  assert.ok(unconfirmedArtReason('Mezzanine', null));
  assert.ok(unconfirmedArtReason('Mezzanine', {}));
});
