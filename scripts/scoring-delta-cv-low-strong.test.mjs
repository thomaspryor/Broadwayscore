// BRO-3512: scoring-delta's inclusion mirror must honour the cvLowButStrong
// carve-out that rebuild-all-reviews.js applies. Requires the real
// decideInclusion and the real review-guards module (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideInclusion } = require('./scoring-delta.js');
const guards = require('./lib/review-guards.js');

const show = { id: 'x-2026', title: 'X', openingDate: '2026-03-20', previewsStartDate: '2026-03-01', category: 'broadway' };
const mk = (cv) => ({
  assignedScore: 80, contentTier: 'complete', fullText: 'x'.repeat(2000), publishDate: '2026-03-25',
  outletId: 'nyt', contentVerification: { isValid: false, wrongProduction: true, ...cv },
});

test('low-confidence CV that names a different show is excluded (carve-out)', () => {
  const r = decideInclusion(mk({ confidence: 'low', reasoning: 'This is a review of a completely different show.' }), show, guards);
  assert.equal(r.included, false);
  assert.match(r.reason, /low-but-strong-signal/);
});

test('low-confidence CV without a strong signal stays included', () => {
  const r = decideInclusion(mk({ confidence: 'low', reasoning: 'Unsure about the venue.' }), show, guards);
  assert.equal(r.included, true);
});

test('a guards module without hasStrongDifferentShowSignal (old baseline) does not throw', () => {
  const old = { ...guards, hasStrongDifferentShowSignal: undefined };
  const r = decideInclusion(mk({ confidence: 'low', reasoning: 'completely different show' }), show, old);
  assert.equal(r.included, true);
});
