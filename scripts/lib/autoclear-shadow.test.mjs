import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  wouldAutoClear,
  assessShadowEvidence,
  shadowObservation,
  SHADOW_MIN_CANDIDATES,
  SHADOW_MIN_WINDOW_HOURS,
} = require('./autoclear-shadow.js');

// --- Replay case 1: Grace Pervades (POSITIVE — auto-clear WOULD fire, human agrees) ---
// Real class: a West End review flagged wrongProduction:true, re-verified by a
// LATER high-confidence CV as a valid right-production review. A human resolved
// it by CLEARING the flag (ground truth = clear).
const GRACE = {
  showId: 'grace-pervades-west-end-2026',
  outletId: 'financialtimes',
  wrongProduction: true,
  wrongProductionFlaggedAt: '2026-04-15T19:50:55.444Z',
  contentVerification: {
    isValid: true, wrongProduction: false, wrongArticle: false, confidence: 'high',
    reasoning: 'Valid review of the West End (Theatre Royal Haymarket) production.',
    verifiedAt: '2026-06-06T06:04:00.397Z',
  },
};

// --- Replay case 2: Cyrano (NEGATIVE — auto-clear must NOT fire, human agrees) ---
// Real class: garbage/invalid scraped content flagged wrongProduction. The CV
// says isValid:false — auto-clear must refuse (the review isn't recoverable;
// the flag stands). Ground truth = NOT cleared.
const CYRANO_GARBAGE = {
  showId: 'cyrano-2026',
  outletId: 'nytimes',
  wrongProduction: true,
  wrongProductionFlaggedAt: '2026-04-15T00:00:00.000Z',
  contentVerification: {
    isValid: false, wrongProduction: true, confidence: 'high',
    reasoning: 'Scraped content is garbage / not a coherent review.',
    verifiedAt: '2026-06-06T00:00:00.000Z',
  },
};

test('REPLAY Grace: auto-clear WOULD fire (matches human clear)', () => {
  const d = wouldAutoClear(GRACE);
  assert.equal(d.clear, true);
  assert.equal(d.flag, 'wrongProduction');
});

test('REPLAY Cyrano: auto-clear must NOT fire (matches human non-clear)', () => {
  const d = wouldAutoClear(CYRANO_GARBAGE);
  assert.equal(d.clear, false);
});

test('auto-clear refuses a LOW-confidence CV even when the flag is contradicted', () => {
  const lowConf = {
    ...GRACE,
    contentVerification: { ...GRACE.contentVerification, confidence: 'low' },
  };
  const d = wouldAutoClear(lowConf);
  assert.equal(d.clear, false);
  assert.equal(d.reason, 'cv-confidence-low');
});

test('manual-cleared file: auto-clear no-ops (nothing left to clear)', () => {
  const cleared = { ...GRACE, wrongProductionManualClear: true };
  assert.equal(wouldAutoClear(cleared).clear, false);
});

test('shadowObservation carries the decision + a null humanVerdict', () => {
  const obs = shadowObservation({
    showId: 'grace-pervades-west-end-2026', file: 'financialtimes--x.json',
    outletId: 'financialtimes', tier: 1,
    decision: wouldAutoClear(GRACE), observedAt: '2026-07-22T12:00:00Z',
  });
  assert.equal(obs.flag, 'wrongProduction');
  assert.equal(obs.humanVerdict, null);
  assert.equal(obs.observedAt, '2026-07-22T12:00:00Z');
});

test('evidence gate: 0 candidates → insufficient (vacuous by construction)', () => {
  const r = assessShadowEvidence({ observations: [], windowHours: 72 });
  assert.equal(r.verdict, 'insufficient-evidence');
  assert.equal(r.candidates, 0);
});

test('evidence gate: <3 candidates → insufficient (extend the window)', () => {
  const obs = [
    { humanVerdict: 'agree' }, { humanVerdict: 'agree' },
  ];
  const r = assessShadowEvidence({ observations: obs, windowHours: 72 });
  assert.equal(r.verdict, 'insufficient-evidence');
  assert.match(r.reasons.join(' '), /only 2 live candidate/);
});

test('evidence gate: <48h window → insufficient even with 3 agreed', () => {
  const obs = [{ humanVerdict: 'agree' }, { humanVerdict: 'agree' }, { humanVerdict: 'agree' }];
  const r = assessShadowEvidence({ observations: obs, windowHours: 10 });
  assert.equal(r.verdict, 'insufficient-evidence');
  assert.match(r.reasons.join(' '), /window/);
});

test('evidence gate: any disagreement → insufficient (auto-clear unsafe)', () => {
  const obs = [{ humanVerdict: 'agree' }, { humanVerdict: 'agree' }, { humanVerdict: 'disagree' }];
  const r = assessShadowEvidence({ observations: obs, windowHours: 72 });
  assert.equal(r.verdict, 'insufficient-evidence');
  assert.equal(r.disagreed, 1);
});

test('evidence gate: 3+ agreed over ≥48h with 0 disagreements → clean', () => {
  const obs = [{ humanVerdict: 'agree' }, { humanVerdict: 'agree' }, { humanVerdict: 'agree' }];
  const r = assessShadowEvidence({ observations: obs, windowHours: 49 });
  assert.equal(r.verdict, 'clean');
  assert.equal(r.agreed, 3);
});

test('evidence gate: un-reviewed candidates (null verdict) do NOT count as clean', () => {
  const obs = [{ humanVerdict: 'agree' }, { humanVerdict: 'agree' }, { humanVerdict: null }];
  const r = assessShadowEvidence({ observations: obs, windowHours: 72 });
  assert.equal(r.verdict, 'insufficient-evidence');
});

test('gate constants match the plan (≥3 candidates / ≥48h)', () => {
  assert.equal(SHADOW_MIN_CANDIDATES, 3);
  assert.equal(SHADOW_MIN_WINDOW_HOURS, 48);
});
