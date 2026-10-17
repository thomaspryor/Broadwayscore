// BRO-5238: scoring-delta's inclusion mirror must replay explainExclusion's
// rejection gates (rejectionReason / rejectedByMultipleModels / rejectedAt),
// so a guard edit that lifts rejection-excluded files shows up as flips.
// Requires the real decideInclusion and review-guards (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideInclusion, FLAG_FIELDS } = require('./scoring-delta.js');
const guards = require('./lib/review-guards.js');

const show = { id: 'x-2026', title: 'X', openingDate: '2026-03-20', previewsStartDate: '2026-03-01', category: 'broadway' };
const base = { assignedScore: 80, contentTier: 'complete', fullText: 'x'.repeat(2000), publishDate: '2026-03-25', outletId: 'nyt' };

test('rejectionReason excludes, matching explainExclusion', () => {
  const r = decideInclusion({ ...base, rejectionReason: 'garbage_text' }, show, guards);
  assert.deepEqual(r, { included: false, reason: 'rejectionReason' });
});

test('wrong_production rejection with a human wrong-production clear is included (BRO-5238)', () => {
  const d = { ...base, rejectionReason: 'wrong_production', rejectedAt: '2026-03-26T00:00:00Z', rejectedBy: 'ensemble-scoreability-check', wrongProductionManualClear: true };
  assert.equal(decideInclusion(d, show, guards).included, true);
  const uncleared = { ...d, wrongProductionManualClear: undefined };
  assert.equal(decideInclusion(uncleared, show, guards).included, false);
});

test('rejectedAt alone excludes; multi-model rejectedBy excludes', () => {
  assert.equal(decideInclusion({ ...base, rejectedAt: '2026-03-26T00:00:00Z' }, show, guards).reason, 'rejectedAt');
  assert.equal(decideInclusion({ ...base, rejectedBy: ['a', 'b'] }, show, guards).reason, 'rejectedByMultipleModels');
});

test('a baseline guards module without the rejection helpers does not throw', () => {
  const old = { ...guards, isRejectedByReasonExclusion: undefined, isRejectedAtExclusion: undefined };
  assert.equal(decideInclusion({ ...base, rejectionReason: 'garbage_text' }, show, old).included, true);
});

test('wrongProduction:true with a human clear is included, matching rebuild/explainExclusion (BRO-5238)', () => {
  const d = { ...base, wrongProduction: true, wrongProductionReason: 'ensemble-unanimous-wrong-production' };
  assert.equal(decideInclusion(d, show, guards).reason, 'wrongProduction');
  for (const clear of [{ wrongProductionManualClear: true }, { wrongProductionOverride: true }, { humanReviewedWrongProduction: false }]) {
    assert.equal(decideInclusion({ ...d, ...clear }, show, guards).included, true, JSON.stringify(clear));
    assert.equal(guards.explainExclusion({ ...d, ...clear }, show, 'x.json'), null, JSON.stringify(clear));
  }
});

test('rejection fields are FLAG_FIELDS so a data sweep triggers the replay', () => {
  for (const f of ['rejectionReason', 'rejectedAt', 'rejectedBy']) assert.ok(FLAG_FIELDS.has(f), f);
});
