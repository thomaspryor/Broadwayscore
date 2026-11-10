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
