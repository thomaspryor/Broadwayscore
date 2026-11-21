// Requires the real metrics module (CLAUDE.md rule 15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const M = require('./openai-leg-ab-metrics.js');

const arm = (score, bucket, extra = {}) => ({ success: true, score, bucket, openaiScore: score, ...extra });
const rec = (showId, control, shadow, extra = {}) => ({ showId, weight: 1, control, shadow, ...extra });

test('identical arms pass every gate', () => {
  const rs = [];
  const band = { floor: 51, ceiling: 70 };
  for (let i = 0; i < 60; i++) rs.push(rec(`s${i % 12}`, arm(60, 'Positive'), arm(60, 'Positive'), { band }));
  const r = M.computeReport(rs);
  assert.equal(r.allPass, true);
  assert.equal(r.gates.meanDrift.value, 0);
});

test('a Mixed collapse (task #504 pattern) fails the bucket gate even when the mean barely moves', () => {
  const rs = [];
  for (let i = 0; i < 30; i++) rs.push(rec('a', arm(55, 'Mixed'), arm(i % 2 ? 72 : 38, i % 2 ? 'Positive' : 'Negative')));
  for (let i = 0; i < 70; i++) rs.push(rec('b', arm(80, 'Positive'), arm(80, 'Positive')));
  const r = M.computeReport(rs);
  assert.equal(r.gates.bucketShiftPp.pass, false);
  assert.ok(r.gates.bucketShiftPp.value.Mixed <= -25);
  assert.ok(Math.abs(r.gates.meanDrift.value) < 1, 'mean hides it');
});

test('more rejections by the shadow fail the rejection gate', () => {
  const rs = [];
  for (let i = 0; i < 100; i++) rs.push(rec('x', arm(70, 'Positive'), i < 5 ? { success: true, rejected: true } : arm(70, 'Positive')));
  assert.equal(M.computeReport(rs).gates.rejectionDelta.pass, false);
});

test('weights reweight a stratified sample to the population', () => {
  const rs = [rec('x', arm(90, 'Rave'), arm(90, 'Rave'), { weight: 9 }), rec('y', arm(50, 'Mixed'), arm(50, 'Mixed'), { weight: 1 })];
  const r = M.computeReport(rs);
  assert.equal(r.sharesControl.Rave, 0.9);
});

test('leg accuracy uses the star-band midpoint, not the clamped final', () => {
  const band = { floor: 71, ceiling: 90 };
  const rs = [];
  for (let i = 0; i < 10; i++) rs.push(rec('x', arm(80, 'Positive', { openaiScore: 80 }), arm(80, 'Positive', { openaiScore: 95 }), { band }));
  const r = M.computeReport(rs);
  assert.equal(r.gates.legAccuracy.pass, false, 'finals identical, but the shadow leg is 14.5 pts off the band');
});

test('shadow hard failures above 1% fail; control failures are excluded and counted', () => {
  const rs = [];
  for (let i = 0; i < 50; i++) rs.push(rec('x', arm(70, 'Positive'), i < 2 ? { success: false } : arm(70, 'Positive')));
  rs.push(rec('x', { success: false }, arm(70, 'Positive')));
  const r = M.computeReport(rs);
  assert.equal(r.controlFailed, 1);
  assert.equal(r.gates.shadowErrors.pass, false);
});

test('shares are paired: a shadow that fails on the hard reviews cannot shrink its own denominator', () => {
  const rs = [];
  for (let i = 0; i < 20; i++) rs.push(rec('x', arm(50, 'Mixed'), { success: false }));
  for (let i = 0; i < 80; i++) rs.push(rec('x', arm(80, 'Positive'), arm(80, 'Positive')));
  const r = M.computeReport(rs);
  assert.equal(r.paired, 80);
  assert.equal(r.gates.bucketShiftPp.value.Mixed, 0, 'unpaired shares would show a fake -20pp Mixed shift');
  assert.equal(r.gates.shadowErrors.pass, false, 'the failures are caught by their own gate');
});

test('a shadow OpenAI call that errors on every review fails, even though the 2-model arm still scores', () => {
  const rs = [];
  for (let i = 0; i < 60; i++) rs.push(rec(`s${i % 12}`, arm(70, 'Positive', { openaiLegOk: true }), arm(70, 'Positive', { openaiLegOk: false, openaiLegRejected: false, openaiScore: null }), { band: { floor: 51, ceiling: 70 } }));
  const r = M.computeReport(rs);
  assert.equal(r.gates.shadowErrors.pass, false);
  assert.equal(r.gates.shadowErrors.value.shadow, 1);
  assert.equal(r.gates.legAccuracy.pass, false, 'no shadow leg scores = no evidence, not a pass');
});

test('a leg REJECTION is an outcome, not an error', () => {
  const rs = [rec('x', arm(70, 'Positive', { openaiLegOk: true }), arm(70, 'Positive', { openaiLegOk: false, openaiLegRejected: true }))];
  assert.equal(M.computeReport(rs).gates.shadowErrors.value.shadow, 0);
});

test('too few shows or banded pairs is not enough evidence', () => {
  const rs = [];
  for (let i = 0; i < 10; i++) rs.push(rec('one-show', arm(70, 'Positive'), arm(70, 'Positive')));
  const r = M.computeReport(rs);
  assert.equal(r.gates.showDrift.pass, false);
  assert.equal(r.gates.legAccuracy.pass, false);
});

// Combined two-leg A/B (owner 2026-11-21): both legs swapped in one ensemble.
test("leg 'both': leg accuracy must hold for EACH swapped leg", () => {
  const rs = [];
  // OpenAI shadow leg as accurate as control; Claude shadow leg 10 pts further from the band midpoint.
  for (let i = 0; i < 40; i++) rs.push(rec(`s${i % 12}`, arm(60, 'Mixed', { openaiScore: 60, claudeScore: 60 }), arm(60, 'Mixed', { openaiScore: 60, claudeScore: 70 }), { band: { floor: 51, ceiling: 70 } }));
  const both = M.computeReport(rs, { leg: 'both' });
  assert.equal(both.gates.legAccuracy.pass, false, 'the Claude leg got worse');
  assert.deepEqual(Object.keys(both.gates.legAccuracy.value).sort(), ['claude', 'openai']);
  assert.equal(M.computeReport(rs).gates.legAccuracy.pass, true, 'red-then-green: the OpenAI-only view misses it');
});

test("leg 'both': a record fails when EITHER shadow leg errored", () => {
  const rs = [];
  for (let i = 0; i < 60; i++) rs.push(rec(`s${i % 12}`, arm(70, 'Positive', { openaiLegOk: true, claudeLegOk: true }), arm(70, 'Positive', { openaiLegOk: true, claudeLegOk: false, claudeLegRejected: false })));
  assert.equal(M.computeReport(rs, { leg: 'both' }).gates.shadowErrors.value.shadow, 1);
  assert.equal(M.computeReport(rs).gates.shadowErrors.value.shadow, 0, 'red-then-green: the OpenAI-only view misses it');
});

test("multi-leg: each leg is gated on its OWN error rate, not the union", () => {
  const rs = [];
  // 0.6% errors on each leg, on different reviews: each passes the 1% gate.
  for (let i = 0; i < 1000; i++) {
    const sh = { openaiLegOk: !(i < 6), claudeLegOk: !(i >= 6 && i < 12), openaiLegRejected: false, claudeLegRejected: false };
    rs.push(rec(`s${i % 12}`, arm(70, 'Positive', { openaiLegOk: true, claudeLegOk: true }), arm(70, 'Positive', sh)));
  }
  const r = M.computeReport(rs, { leg: 'both' });
  assert.equal(r.gates.shadowErrors.pass, true);
  assert.deepEqual(r.gates.shadowErrors.value.perLeg, { openai: { shadow: 0.006, control: 0 }, claude: { shadow: 0.006, control: 0 } });
});

test("leg 'all' covers the Gemini leg", () => {
  const rs = [];
  for (let i = 0; i < 40; i++) rs.push(rec(`s${i % 12}`, arm(60, 'Mixed', { claudeScore: 60, geminiScore: 60 }), arm(60, 'Mixed', { claudeScore: 60, geminiScore: 75 }), { band: { floor: 51, ceiling: 70 } }));
  assert.equal(M.computeReport(rs, { leg: 'all' }).gates.legAccuracy.pass, false, 'the Gemini leg got worse');
  assert.throws(() => M.computeReport(rs, { leg: 'bogus' }), /unknown leg/);
});

test('interactionTerm: 0 when the combined change is the sum of the single changes', () => {
  const r = (c, s1, s2, both) => ({ weight: 1, control: arm(c, 'Positive'), a: arm(s1, 'Positive'), b: arm(s2, 'Positive'), ab: arm(both, 'Positive') });
  assert.deepEqual(M.interactionTerm([r(75, 77, 74, 76)], 'ab', ['a', 'b']), { n: 1, meanInteraction: 0, meanAbsInteraction: 0, over5Pts: 0 });
  const x = M.interactionTerm([r(75, 77, 74, 76), r(75, 75, 75, 82)], 'ab', ['a', 'b']);
  assert.equal(x.meanInteraction, 3.5);
  assert.equal(x.over5Pts, 0.5);
});
