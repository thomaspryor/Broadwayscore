import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { censusRecallResult } = require('../../scripts/health-check.js');

const NOW = Date.parse('2026-08-02T12:00:00Z');
const hoursAgo = (h) => new Date(NOW - h * 3600000).toISOString();

const ok = (over = {}) => ({
  generatedAt: hoursAgo(6),
  verdict: 'ok',
  reason: '2 arm(s) within 0.15 of their 4-run median',
  regressions: [],
  comparedArms: 2,
  latest: { shows: 5, truthUrls: 120, families: { scoped: 0.283, naive: 0.551, onDisk: 0.645 } },
  ...over,
});

test('a healthy run reports the per-arm recall the owner is meant to watch', () => {
  const r = censusRecallResult(ok(), { nowMs: NOW });
  assert.equal(r.status, 'pass');
  // Plain English, not internal vocabulary: no "scoped"/"naive"/"recall 0.28".
  assert.match(r.message, /our targeted searches found 28%/);
  assert.match(r.message, /a plain Google search found 55%/);
  assert.match(r.message, /120 review pages any of our searches could find/);
  assert.doesNotMatch(r.message, /scoped|naive|onDisk|recall/);
});

test('a regression is a warn, not a page — the gate it feeds is fail-open', () => {
  const r = censusRecallResult(ok({
    verdict: 'regressed',
    comparedArms: 2,
    regressions: [{ arm: 'scoped', baseline: 0.8, current: 0.2, drop: 0.6, reason: 'x' }],
  }), { nowMs: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /our targeted searches now finds 20% vs 80% recently/);
  // Says what it MEANS for the owner, not just that a number moved.
  assert.match(r.message, /published reviews missing/);
  assert.match(r.hint, /audit-serp-census-recall\.js/);
});

test('a vanished arm renders as absent rather than as a bare number', () => {
  const r = censusRecallResult(ok({
    verdict: 'regressed',
    regressions: [{ arm: 'naive', baseline: 0.9, current: null, drop: 0.9, reason: 'x' }],
  }), { nowMs: NOW });
  assert.match(r.message, /a plain Google search stopped reporting/);
});

test('missing data warns instead of passing — a silent detector is the #898 failure', () => {
  const r = censusRecallResult(null, { nowMs: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /No census-recall data/);
});

test('a stale weekly run warns that the detector itself has gone blind', () => {
  const r = censusRecallResult(ok({ generatedAt: hoursAgo(24 * 11) }), { nowMs: NOW });
  assert.equal(r.status, 'warn');
  assert.match(r.message, /last measured/);
  assert.match(r.hint, /stale or disabled/);
});

test('an unparseable generatedAt is treated as stale, never as fresh', () => {
  const r = censusRecallResult(ok({ generatedAt: 'not-a-date' }), { nowMs: NOW });
  assert.equal(r.status, 'warn');
});

test('blind and insufficient-sample verdicts say so instead of claiming health', () => {
  for (const verdict of ['blind', 'insufficient-sample']) {
    const r = censusRecallResult(ok({ verdict, reason: `it is ${verdict}` }), { nowMs: NOW });
    assert.equal(r.status, 'warn', verdict);
    assert.match(r.message, new RegExp(verdict));
  }
});
