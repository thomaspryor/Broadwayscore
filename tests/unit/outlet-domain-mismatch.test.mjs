/**
 * Regression tests for isOutletDomainMismatch — the audit-review-contamination.js
 * class C (C_domain_mismatch) decision.
 *
 * 2026-06-22 incident: 12 legitimate West End aggregator star-stubs (real outlets
 * like telegraph/financialtimes/timeout, real star scores, url = the
 * westendtheatre.com roundup page) were flagged as C_domain_mismatch and failed
 * Data Validation. Aggregator ROUNDUP URLs are shared across every real outlet the
 * roundup covers, so domain→outlet matching doesn't apply to them. This test locks
 * in that exemption while keeping genuine real-outlet→real-outlet misattribution
 * (e.g. a talkinbroadway file on stagebuddy.com) flagged.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isOutletDomainMismatch, AGGREGATOR_OUTLET_IDS } = require('../../scripts/lib/aggregator-domains');

const WIRE = new Set(['ap', 'reuters', 'upi']);

describe('isOutletDomainMismatch', () => {
  test('aggregator roundup URL on a real outlet → NOT a mismatch (the 12 WET stubs)', () => {
    // domain westendtheatre.com → expected "westendtheatre"; outletId is a real outlet
    assert.equal(isOutletDomainMismatch('westendtheatre', 'telegraph', { wireOutlets: WIRE }), false);
    assert.equal(isOutletDomainMismatch('westendtheatre', 'financialtimes', { wireOutlets: WIRE }), false);
    assert.equal(isOutletDomainMismatch('stagedoor', 'guardian', { wireOutlets: WIRE }), false);
    assert.equal(isOutletDomainMismatch('show-score', 'nytimes', { wireOutlets: WIRE }), false);
  });

  test('genuine real-outlet → real-outlet misattribution → IS a mismatch', () => {
    // stagebuddy.com → "stagebuddy" (a real outlet, NOT an aggregator) on a talkinbroadway file
    assert.equal(isOutletDomainMismatch('stagebuddy', 'talkinbroadway', { wireOutlets: WIRE }), true);
    assert.equal(isOutletDomainMismatch('nytimes', 'guardian', { wireOutlets: WIRE }), true);
  });

  test('same outlet → not a mismatch', () => {
    assert.equal(isOutletDomainMismatch('nytimes', 'nytimes', { wireOutlets: WIRE }), false);
    // an aggregator review legitimately filed under the aggregator outletId
    assert.equal(isOutletDomainMismatch('westendtheatre', 'westendtheatre', { wireOutlets: WIRE }), false);
  });

  test('wire services syndicate across domains → not a mismatch', () => {
    assert.equal(isOutletDomainMismatch('nytimes', 'ap', { wireOutlets: WIRE }), false);
    assert.equal(isOutletDomainMismatch('washingtonpost', 'reuters', { wireOutlets: WIRE }), false);
  });

  test('unresolvable domain (expected falsy) → not a mismatch', () => {
    assert.equal(isOutletDomainMismatch(undefined, 'telegraph', { wireOutlets: WIRE }), false);
    assert.equal(isOutletDomainMismatch('', 'telegraph', { wireOutlets: WIRE }), false);
  });

  test('exemption is keyed on the canonical aggregator-outlet set', () => {
    // Every aggregator outlet must be exempt as a roundup-URL source.
    for (const agg of AGGREGATOR_OUTLET_IDS) {
      assert.equal(isOutletDomainMismatch(agg, 'some-real-outlet', { wireOutlets: WIRE }), false, agg);
    }
  });

  test('works without a wireOutlets set (optional opts)', () => {
    assert.equal(isOutletDomainMismatch('westendtheatre', 'telegraph'), false);
    assert.equal(isOutletDomainMismatch('nytimes', 'guardian'), true);
  });
});
