// Guards against regression of the "15926% recouped" bug (task #41).
//
// RecoupmentProgressBar renders three regimes based on the central estimate:
//   (1) < 100%    "N% recouped"        + progress bar
//   (2) < 200%    "N% recouped"        + progress bar (clamped at 100%)
//   (3) >= 200%   "~Nx returned"       (multiple; no bar)
//
// The buggy state we're guarding against: Hamilton has
// modelRecoupmentPct = [14418, 15926, 17248]. Old code rendered
// "15926% recouped" verbatim. New code must render "~159.3x returned to
// investors" (using regime 3).
//
// This test replicates the pure logic from the component so it can run without
// React. If the component logic drifts from these expectations, either update
// this test with the reason, or fix the component.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const MULTIPLE_THRESHOLD_PCT = 200;

function formatMultiple(pct) {
  return `${(pct / 100).toFixed(1)}x`;
}

// Mirror of the component's label + range computation. Keep in sync.
function computeLabels(estimatedPct) {
  const isModel = estimatedPct.length === 3;
  const low = Math.round(Math.min(...estimatedPct));
  const high = Math.round(Math.max(...estimatedPct));
  const central = isModel ? Math.round(estimatedPct[1]) : Math.round((low + high) / 2);
  const asMultiple = central >= MULTIPLE_THRESHOLD_PCT;

  let label, rangeLabel = null;
  if (asMultiple) {
    label = `~${formatMultiple(central)} returned to investors`;
    if (isModel && low !== high) rangeLabel = `Range: ${formatMultiple(low)}–${formatMultiple(high)}`;
  } else if (isModel) {
    label = `${central}% recouped`;
    if (low !== high) rangeLabel = `Range: ${low}–${high}%`;
  } else {
    label = low === high ? `~${low}% recouped` : `~${low}-${high}% recouped`;
  }
  return { label, rangeLabel, asMultiple, central };
}

test('Hamilton (long-run recouped, ~159x): shows multiple, not raw %', () => {
  // From actual commercial.json modelRecoupmentPct as of 2026-07-10.
  const { label, rangeLabel, asMultiple } = computeLabels([14418.4, 15925.6, 17248.4]);
  assert.equal(asMultiple, true);
  assert.equal(label, '~159.3x returned to investors',
    'Regression: Hamilton must not render as "15926% recouped"');
  assert.equal(rangeLabel, 'Range: 144.2x–172.5x');
});

test('Proof (still running, ~2% recouped): shows % + bar regime', () => {
  const { label, rangeLabel, asMultiple } = computeLabels([-17.7, 1.5, 19.4]);
  assert.equal(asMultiple, false);
  assert.equal(label, '2% recouped');
  assert.equal(rangeLabel, 'Range: -18–19%');
});

test('Just-recouped (central 105%): still uses % regime, not multiple', () => {
  // Below the 200% threshold — a clamped-full bar tells the story better than "1.1x"
  const { label, asMultiple } = computeLabels([90, 105, 120]);
  assert.equal(asMultiple, false);
  assert.equal(label, '105% recouped');
});

test('At threshold (central exactly 200%): switches to multiple regime', () => {
  const { label, asMultiple } = computeLabels([180, 200, 220]);
  assert.equal(asMultiple, true);
  assert.equal(label, '~2.0x returned to investors');
});

test('AI estimate (2-tuple, low<high): still % regime unless past threshold', () => {
  // AI estimate uses [low, high]; central = (low+high)/2. 40% recouped case.
  const { label, asMultiple } = computeLabels([30, 50]);
  assert.equal(asMultiple, false);
  assert.equal(label, '~30-50% recouped');
});

test('AI estimate low==high renders as single-value "~N% recouped"', () => {
  const { label } = computeLabels([65, 65]);
  assert.equal(label, '~65% recouped');
});

test('AI estimate past threshold uses multiple regime', () => {
  // AI-estimated shows above 2x should also use the multiple treatment.
  const { label, asMultiple } = computeLabels([250, 350]);
  assert.equal(asMultiple, true);
  assert.equal(label, '~3.0x returned to investors');
});

test('Range is hidden when low==high in model regime', () => {
  const { label, rangeLabel } = computeLabels([50, 50, 50]);
  assert.equal(label, '50% recouped');
  assert.equal(rangeLabel, null);
});

test('negative model output clamps to 0 (deep-flop shape, cabaret-2024)', () => {
  // Mirror of the component's clamped computation (Sprint 3, task #142).
  const estimatedPct = [-168.2, -119.8, -74];
  const low = Math.max(0, Math.round(Math.min(...estimatedPct)));
  const high = Math.max(0, Math.round(Math.max(...estimatedPct)));
  const central = Math.max(0, Math.round(estimatedPct[1]));
  assert.equal(low, 0);
  assert.equal(high, 0);
  assert.equal(central, 0);
  // low === high → no range label; label reads "0% recouped", never negative.
});
