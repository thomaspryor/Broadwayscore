// Coverage Verdict S0 (task #902) — kill switch + blast-radius guard.
//
// The whole point of these two helpers is that they FAIL OPEN. Most of what
// follows asserts the permissive direction: broken input, tiny sample, missing
// snapshot, thrown predicate — all must let the caller proceed. Only a
// confidently-measured mass state change refuses.
//
// Run: node --test scripts/lib/coverage-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { coverageGateDisabled, coverageGateAllows, blastRadiusCheck } = require('./coverage-gate.js');

test('coverageGateDisabled reads the documented truthy spellings', () => {
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
    assert.strictEqual(coverageGateDisabled({ COVERAGE_GATE_DISABLED: v }), true, `expected ${JSON.stringify(v)} to disable`);
  }
  for (const v of [undefined, '', '0', 'false', 'no', 'off', 'maybe']) {
    assert.strictEqual(coverageGateDisabled({ COVERAGE_GATE_DISABLED: v }), false, `expected ${JSON.stringify(v)} NOT to disable`);
  }
});

test('coverageGateAllows: kill switch and a throwing predicate both fail open', () => {
  const env = {};
  assert.strictEqual(coverageGateAllows(() => true, { env }), true);
  assert.strictEqual(coverageGateAllows(() => false, { env }), false);
  // kill switch → never gate
  assert.strictEqual(coverageGateAllows(() => true, { env: { COVERAGE_GATE_DISABLED: '1' } }), false);
  // a broken verdict read → never gate
  assert.strictEqual(coverageGateAllows(() => { throw new Error('verdict file missing'); }, { env }), false);
  // a non-boolean return is not a green light
  assert.strictEqual(coverageGateAllows(() => 'incomplete', { env }), false);
});

const state = (n, s) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`show-${i}`, s]));

test('blastRadiusCheck refuses when >5% of a large comparable set changes state', () => {
  const prev = state(100, 'complete');
  const next = { ...prev };
  for (let i = 0; i < 6; i++) next[`show-${i}`] = 'incomplete'; // 6%
  const r = blastRadiusCheck(prev, next, { env: {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.compared, 100);
  assert.strictEqual(r.changed, 6);
  assert.match(r.reason, /blast radius 6\.0%/);
  assert.match(r.reason, /COVERAGE_BLAST_RADIUS_OVERRIDE/);
});

test('blastRadiusCheck allows a change at or under the threshold', () => {
  const prev = state(100, 'complete');
  const next = { ...prev };
  for (let i = 0; i < 5; i++) next[`show-${i}`] = 'incomplete'; // exactly 5%
  const r = blastRadiusCheck(prev, next, { env: {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, 5);
});

test('blastRadiusCheck never refuses a scoped run (sample below minSample)', () => {
  // The `--show=X` case that would otherwise read as a 100% flip.
  const r = blastRadiusCheck({ 'the-car-man-west-end-2026': 'complete' }, { 'the-car-man-west-end-2026': 'incomplete' }, { env: {} });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.compared, 1);
  assert.match(r.reason, /sample too small/);
});

test('blastRadiusCheck fails open on missing / malformed snapshots', () => {
  for (const [prev, next] of [[null, null], [undefined, state(100, 'complete')], ['garbage', 42], [{}, state(100, 'incomplete')]]) {
    const r = blastRadiusCheck(prev, next, { env: {} });
    assert.strictEqual(r.ok, true, `expected fail-open for ${JSON.stringify(prev)} → ${JSON.stringify(next)?.slice(0, 40)}`);
  }
});

test('blastRadiusCheck ignores added and removed shows (not state changes)', () => {
  const prev = state(50, 'complete');
  // 50 unchanged carried ids + 50 brand-new ids, all of them 'incomplete'.
  const grown = { ...prev };
  for (let i = 100; i < 150; i++) grown[`show-${i}`] = 'incomplete';
  const r = blastRadiusCheck(prev, grown, { env: {} });
  assert.strictEqual(r.compared, 50, 'new ids must not count toward the compared set');
  assert.strictEqual(r.changed, 0);
  assert.strictEqual(r.ok, true);
  // removals likewise
  const shrunk = Object.fromEntries(Object.entries(prev).slice(0, 25));
  const r2 = blastRadiusCheck(prev, shrunk, { env: {} });
  assert.strictEqual(r2.compared, 25);
  assert.strictEqual(r2.changed, 0);
  assert.strictEqual(r2.ok, true);
});

test('blastRadiusCheck does not refuse on a small absolute change (2026-08-09 gap-audit regression)', () => {
  // The exact production numbers that reddened "Audit Aggregator Review Gap"
  // 13 times in 3 days: a time-budget-partial run audited 22 shows, 2 of them
  // genuinely changed coverage state, and 2/22 = 9.1% tripped the 5% threshold.
  // The audit rolled back its freshness stamps and exited 1 — hourly.
  const prev = state(22, 'complete');
  const next = { ...prev };
  next['show-0'] = 'incomplete';
  next['show-1'] = 'incomplete';
  const r = blastRadiusCheck(prev, next, { env: {}, label: 'review-gap' });
  assert.strictEqual(r.compared, 22);
  assert.strictEqual(r.changed, 2);
  assert.ok(r.changedPct > 5, 'precondition: this case IS over the percentage threshold');
  assert.strictEqual(r.ok, true, '2 changed shows must never read as a broken input');
  assert.match(r.reason, /too few to be a broken input/);
});

test('blastRadiusCheck still catches the outage it exists for on the same small batch', () => {
  // Dead SERP provider / empty census on that same 22-show partial run: the
  // whole batch flips, which clears both the percentage AND the absolute floor.
  const prev = state(22, 'complete');
  const next = state(22, 'unknown');
  const r = blastRadiusCheck(prev, next, { env: {}, label: 'review-gap' });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.changed, 22);
  assert.match(r.reason, /blast radius 100\.0%/);
});

test('blastRadiusCheck: minChanged is the binding constraint exactly at the boundary', () => {
  const prev = state(40, 'complete');
  const mutate = (n) => {
    const next = { ...prev };
    for (let i = 0; i < n; i++) next[`show-${i}`] = 'incomplete';
    return next;
  };
  // 4/40 = 10% — over the 5% threshold, under the 5-show floor → allowed.
  const under = blastRadiusCheck(prev, mutate(4), { env: {} });
  assert.strictEqual(under.ok, true);
  assert.strictEqual(under.changed, 4);
  // 5/40 = 12.5% — clears both → refused.
  const at = blastRadiusCheck(prev, mutate(5), { env: {} });
  assert.strictEqual(at.ok, false);
  assert.strictEqual(at.changed, 5);
});

test('blastRadiusCheck: minChanged is configurable and 0 restores pure-percentage behaviour', () => {
  const prev = state(22, 'complete');
  const next = { ...prev };
  next['show-0'] = 'incomplete';
  next['show-1'] = 'incomplete';
  const r = blastRadiusCheck(prev, next, { env: {}, minChanged: 0 });
  assert.strictEqual(r.ok, false, 'minChanged:0 must reproduce the old percentage-only gate');
});

test('blastRadiusCheck: isRiskyChange narrows which transitions count as changed (BRO-513)', () => {
  // The recurring false positive: a batch of shows genuinely goes
  // complete -> incomplete because the census found real new gaps, not
  // because anything broke. With a review-gap-style isRiskyChange (only a
  // regression TO 'no-census-yet' is risky), that batch must never refuse.
  const prev = state(29, 'complete');
  const next = { ...prev };
  for (let i = 0; i < 6; i++) next[`show-${i}`] = 'incomplete'; // 20.7%, the exact BRO-513 numbers
  const isRiskyChange = (p, n) => n === 'no-census-yet' && p !== 'no-census-yet';
  const r = blastRadiusCheck(prev, next, { env: {}, label: 'review-gap', isRiskyChange });
  assert.strictEqual(r.compared, 29, 'denominator is unaffected by the filter');
  assert.strictEqual(r.changed, 0, 'complete -> incomplete is not a risky transition');
  assert.strictEqual(r.ok, true);
});

test('blastRadiusCheck: isRiskyChange still catches the failure mode it is FOR', () => {
  // A dead SERP provider / empty census manifests as verdicts regressing to
  // 'no-census-yet' — that direction must still refuse even though the
  // complete<->incomplete churn above is now ignored.
  const prev = state(29, 'complete');
  const next = { ...prev };
  for (let i = 0; i < 6; i++) next[`show-${i}`] = 'no-census-yet';
  const isRiskyChange = (p, n) => n === 'no-census-yet' && p !== 'no-census-yet';
  const r = blastRadiusCheck(prev, next, { env: {}, label: 'review-gap', isRiskyChange });
  assert.strictEqual(r.changed, 6);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /blast radius/);
});

test('blastRadiusCheck: isRiskyChange omitted preserves the original direction-blind behavior', () => {
  const prev = state(100, 'complete');
  const next = { ...prev };
  for (let i = 0; i < 6; i++) next[`show-${i}`] = 'incomplete';
  const r = blastRadiusCheck(prev, next, { env: {} });
  assert.strictEqual(r.changed, 6);
  assert.strictEqual(r.ok, false);
});

test('both env overrides force the write through', () => {
  const prev = state(100, 'complete');
  const next = state(100, 'incomplete'); // 100% change
  assert.strictEqual(blastRadiusCheck(prev, next, { env: {} }).ok, false);
  for (const env of [{ COVERAGE_BLAST_RADIUS_OVERRIDE: '1' }, { COVERAGE_GATE_DISABLED: 'true' }]) {
    const r = blastRadiusCheck(prev, next, { env });
    assert.strictEqual(r.ok, true, `expected ${JSON.stringify(env)} to bypass`);
    assert.match(r.reason, /bypassed/);
  }
});
