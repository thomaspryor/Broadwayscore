/**
 * Unit tests for scripts/lib/wrong-production-autoclear.js — the dual-guard
 * fix preventing rebuild from stripping wrongProduction/wrongShow flags that
 * were explicitly set by manual flags, audit scripts, or high-confidence CV.
 *
 * Historical incident: 2026-04-15 — audit-review-contamination flagged 5
 * cross-market files as wrongProduction=true. Local rebuild stripped all 5
 * within hours because they had allowEarlyDate:true. The auto-clear path
 * didn't check for an explicit wrongProductionReason, so cross-market
 * contamination kept reappearing on every rebuild.
 *
 * Run: node --test tests/unit/wrong-production-autoclear.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { shouldAutoClearWrongProduction, shouldAutoClearWrongShow } =
  require('../../scripts/lib/wrong-production-autoclear');

describe('shouldAutoClearWrongProduction', () => {
  it('returns false when wrongProduction is not set', () => {
    assert.strictEqual(shouldAutoClearWrongProduction({ allowEarlyDate: true }), false);
  });

  it('returns false when no allow* flag is present', () => {
    assert.strictEqual(shouldAutoClearWrongProduction({ wrongProduction: true }), false);
  });

  it('returns true when wrongProduction + allowEarlyDate, no reason, no CV', () => {
    assert.strictEqual(
      shouldAutoClearWrongProduction({ wrongProduction: true, allowEarlyDate: true }),
      true
    );
  });

  it('returns true when wrongProduction + allowCrossMarket, no reason, no CV', () => {
    assert.strictEqual(
      shouldAutoClearWrongProduction({ wrongProduction: true, allowCrossMarket: true }),
      true
    );
  });

  it('returns false when wrongProductionReason is set (audit-flagged)', () => {
    // Regression: 2026-04-15 cross-market audit fix was getting stripped
    assert.strictEqual(
      shouldAutoClearWrongProduction({
        wrongProduction: true,
        allowEarlyDate: true,
        wrongProductionReason: 'cross-market-audit-2026-04-15',
      }),
      false
    );
  });

  it('returns false when wrongProductionReason is set (manual flag)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProduction({
        wrongProduction: true,
        allowCrossMarket: true,
        wrongProductionReason: 'manual:2026-04-11 systematic audit',
      }),
      false
    );
  });

  it('returns false when CV high-confidence wrongProduction is set', () => {
    assert.strictEqual(
      shouldAutoClearWrongProduction({
        wrongProduction: true,
        allowEarlyDate: true,
        contentVerification: { wrongProduction: true, confidence: 'high' },
      }),
      false
    );
  });

  it('returns true when CV is low confidence (low conf is not authoritative)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProduction({
        wrongProduction: true,
        allowEarlyDate: true,
        contentVerification: { wrongProduction: true, confidence: 'low' },
      }),
      true
    );
  });

  it('returns true when CV has wrongProduction:false (CV says correct production)', () => {
    assert.strictEqual(
      shouldAutoClearWrongProduction({
        wrongProduction: true,
        allowEarlyDate: true,
        contentVerification: { wrongProduction: false, confidence: 'high' },
      }),
      true
    );
  });
});

describe('shouldAutoClearWrongShow', () => {
  it('returns false when wrongShow is not set', () => {
    assert.strictEqual(shouldAutoClearWrongShow({ allowEarlyDate: true }), false);
  });

  it('returns true when wrongShow + allowEarlyDate, no reason, no CV', () => {
    assert.strictEqual(
      shouldAutoClearWrongShow({ wrongShow: true, allowEarlyDate: true }),
      true
    );
  });

  it('returns false when wrongShowReason is set', () => {
    assert.strictEqual(
      shouldAutoClearWrongShow({
        wrongShow: true,
        allowCrossMarket: true,
        wrongShowReason: 'CV-promoted: review is for film adaptation',
      }),
      false
    );
  });

  it('returns false when CV high-confidence wrongArticle is set', () => {
    assert.strictEqual(
      shouldAutoClearWrongShow({
        wrongShow: true,
        allowEarlyDate: true,
        contentVerification: { wrongArticle: true, confidence: 'high' },
      }),
      false
    );
  });
});
