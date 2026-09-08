/**
 * gate-cold-start-rules.test.mjs — regression coverage for the weekly
 * gate-cold-start A/B monitor's decision rules (scripts/lib/gate-cold-start-rules.js).
 *
 * BRO-2952: this file previously had NO test coverage at all — the
 * impression-split guardrail (IMPRESSION_SPLIT_EXPECTED_RATIO /
 * IMPRESSION_SPLIT_MIN_RATIO) was recalibrated with no regression test
 * pinning it, which is how a bad threshold shipped silently in the first
 * place. See docs/experiments/gate-cold-start.md "Amendments" (2026-09-07)
 * for the investigation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  decideGateColdStartAlerts,
  IMPRESSION_SPLIT_EXPECTED_RATIO,
  IMPRESSION_SPLIT_MIN_RATIO,
  IMPRESSION_SPLIT_MIN_SHOWN,
} = require('../../scripts/lib/gate-cold-start-rules.js');

const NOW = 1_800_000_000_000;

function summary(controlShown, coldStartShown, extra = {}) {
  return {
    flagHealthy: true,
    arms: {
      control: { exposed: 1100, shown: controlShown, dismissed: 0, captured: 0 },
      'cold-start': { exposed: 1100, shown: coldStartShown, dismissed: 0, captured: 0 },
    },
    totalCapturesPerWeek: 4,
    ...extra,
  };
}

function alertsFor(controlShown, coldStartShown) {
  const { alerts } = decideGateColdStartAlerts(
    { recent: summary(controlShown, coldStartShown), cumulative: {} },
    {},
    NOW,
  );
  return alerts.filter(a => a.kind === 'impression-split-broken');
}

test('impression-split guardrail: the real steady-state ratio (BRO-2952, 208:75 ≈ 2.8:1) does NOT alert', () => {
  // 2026-09-07 monitor snapshot, post row-cap-bug-fix (b6d48ce42f5) real data —
  // this exact shape fired a false-positive P1 before the guardrail was
  // recalibrated. Pin it so the threshold never regresses back to 10:1/5:1.
  assert.deepEqual(alertsFor(208, 75), [], 'expected/observed selection ratio must not alert');
  assert.deepEqual(alertsFor(230, 86), [], '2026-08-31 snapshot must not alert');
  assert.deepEqual(alertsFor(226, 86), [], '2026-09-01 snapshot must not alert');
});

test('impression-split guardrail: true parity (filter not applying) still alerts', () => {
  const alerts = alertsFor(150, 148);
  assert.equal(alerts.length, 1, 'near-1:1 split must still be caught as a real regression');
  assert.match(alerts[0].description, /client-side gate logic/);
});

test('impression-split guardrail: below IMPRESSION_SPLIT_MIN_SHOWN combined, no judgment is made either way', () => {
  assert.ok(IMPRESSION_SPLIT_MIN_SHOWN > 0);
  assert.deepEqual(alertsFor(5, 2), [], 'too little traffic to judge — must not alert');
});

test('impression-split guardrail: thresholds are calibrated to measured reality, not the untested pre-launch projection', () => {
  // Pre-launch (docs/experiments/gate-cold-start.md, written before any real
  // measurement existed) projected an 85-90% impression cut (~10:1). Real
  // data only became visible after the HogQL row-cap fix (2026-08-26,
  // b6d48ce42f5) — every measurement since has landed at ~2.5-2.8:1, not
  // 10:1. The guardrail must track the measured band, with a floor that
  // still catches an actual collapse toward 1:1.
  assert.ok(IMPRESSION_SPLIT_EXPECTED_RATIO <= 3 && IMPRESSION_SPLIT_EXPECTED_RATIO >= 2,
    `expected ratio (${IMPRESSION_SPLIT_EXPECTED_RATIO}) should track the measured ~2.5-2.8:1 band, not the old unvalidated 10:1`);
  assert.ok(IMPRESSION_SPLIT_MIN_RATIO < IMPRESSION_SPLIT_EXPECTED_RATIO,
    'floor must sit below the expected ratio');
  assert.ok(IMPRESSION_SPLIT_MIN_RATIO >= 1.2,
    'floor must still meaningfully exceed 1:1 parity to catch a real filter failure');
});
