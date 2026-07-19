import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildDataPlan } = require('./autonomous-triage.js');

// Fixture entries shaped like scripts/autonomous-triage.js's `entries` array:
// a Tier-1 'skip' with a real triage.size (the common Tier-2 case — the card
// reached the LLM, which correctly said eligible:false for touching data/,
// but still estimated size independent of eligibility).
function skipped(card, size) {
  return { decision: 'skip', card, triage: size ? { eligible: false, size, reason: 'touches data/', checkableDone: 'n/a' } : null };
}

test('a real byline-recovery card (Tier-1 skip, LLM size M) becomes a Tier-2 dataPlan item', () => {
  const card = { id: 'card-27', name: 'Byline recovery: outlet--unknown entries in reviews.json where a named sibling file exists', priority: 'P1 Next', tags: ['review-recovery', 'bylines'] };
  const plan = buildDataPlan([skipped(card, 'M')]);
  assert.deepEqual(plan, [{ id: 'card-27', name: card.name, priority: 'P1 Next', size: 'M', class: 'byline-recovery' }]);
});

test('pre-filter skip (no triage object at all) still classifies, defaults size to M', () => {
  const card = { id: 'card-x', name: 'Missing show: Some Regional Transfer', priority: 'P2 Later', tags: ['missing-show', 'commercial'] }; // deny-tag → pre-filter skip, never reaches LLM
  const plan = buildDataPlan([skipped(card, null)]);
  assert.deepEqual(plan, [{ id: 'card-x', name: card.name, priority: 'P2 Later', size: 'M', class: 'missing-show' }]);
});

test('attempt/split/failed decisions never enter the data plan, even if classifiable', () => {
  const card = { id: 'card-z', name: 'Missing show: Whatever', priority: 'P1 Next', tags: ['missing-show'] };
  assert.deepEqual(buildDataPlan([{ decision: 'attempt', card, triage: { size: 'S' } }]), []);
  assert.deepEqual(buildDataPlan([{ decision: 'split', card, triage: { size: 'L' } }]), []);
  assert.deepEqual(buildDataPlan([{ decision: 'failed', card, triage: null }]), []);
});

test('unclassifiable skipped cards are excluded (default-deny holds)', () => {
  const card = { id: 'card-q', name: 'Rage clicks on Hamilton show page', priority: 'P1 Next', tags: [] };
  assert.deepEqual(buildDataPlan([skipped(card, 'S')]), []);
});

test('a transient fetch-failure entry (no real card) never enters the plan', () => {
  const entry = { decision: 'skip', transient: true, card: { id: 'card-t' }, triage: null };
  assert.deepEqual(buildDataPlan([entry]), []);
});

test('a card claimed in-flight by an interactive session is NEVER requeued as Tier-2, even if classifiable (ship-check finding)', () => {
  const card = { id: 'card-claimed', name: 'Byline recovery: outlet--unknown entries in reviews.json where a named sibling file exists', priority: 'P1 Next', tags: ['review-recovery', 'bylines'] };
  const entry = {
    decision: 'skip', card,
    preFilter: { eligible: false, reason: 'claimed in-flight (shared task #151 is in_progress — already being worked interactively)' },
    triage: null,
  };
  assert.deepEqual(buildDataPlan([entry]), []);
});

test('a policy-excluded skip (deny-tag) is NOT the same as claimed-in-flight — still enters the plan', () => {
  const card = { id: 'card-x', name: 'Missing show: Some Regional Transfer', priority: 'P2 Later', tags: ['missing-show', 'commercial'] };
  const entry = { decision: 'skip', card, preFilter: { eligible: false, reason: 'deny-tag "commercial"' }, triage: null };
  assert.equal(buildDataPlan([entry]).length, 1);
});

test('ordering matches priority then size, same as the Tier-1 plan', () => {
  const p0m = skipped({ id: 'a', name: 'Missing show: A', priority: 'P0 Now', tags: ['missing-show'] }, 'M');
  const p1s = skipped({ id: 'b', name: 'Missing show: B', priority: 'P1 Next', tags: ['missing-show'] }, 'S');
  const p0s = skipped({ id: 'c', name: 'Missing show: C', priority: 'P0 Now', tags: ['missing-show'] }, 'S');
  const plan = buildDataPlan([p1s, p0m, p0s]);
  assert.deepEqual(plan.map(p => p.id), ['c', 'a', 'b']); // P0-S, P0-M, P1-S
});

test('auto-stamped cards never occupy a plan slot (2026-07-17..19 wedge: attemptDataCard refuses auto!=null, so planning one = 3 nights of state-moved skips)', () => {
  const failed = { id: 'card-f', name: 'Byline recovery: wedged failed card', priority: 'P1 Next', tags: ['review-recovery'], auto: 'failed' };
  const attempted = { id: 'card-a', name: 'Missing show: stranded attempted card', priority: 'P1 Next', tags: ['missing-show'], auto: 'attempted' };
  const clean = { id: 'card-c', name: 'Missing show: fresh card', priority: 'P2 Later', tags: ['missing-show'], auto: null };
  const plan = buildDataPlan([skipped(failed, 'M'), skipped(attempted, 'S'), skipped(clean, 'M')]);
  assert.deepEqual(plan.map(p => p.id), ['card-c']);
});
