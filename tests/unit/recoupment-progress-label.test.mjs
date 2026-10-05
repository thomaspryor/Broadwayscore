// Guards the recoupment-estimate labels (task #41 "15926% recouped" bug;
// BRO-4623 P0-1 removed the "~Nx returned to investors" regime).
//
// The model's modelRecoupmentPct is a percent of capitalization NET of SVOG
// grants plus a reserve. It is not an investor return: Hamilton's 15926%
// rendered as "~159.3x returned to investors" and Chicago's as ~958x, neither
// of which any source reports. Past 100% the label now only says "100%+",
// always as an estimate, with the range.
//
// BRO-4623 moved this file from tests/unit-test-manifest.txt (node batch) to
// tests/unit-test-manifest-tsx.txt and replaced the copied-in logic with an
// import of the real getModelRecoupmentLabels (CLAUDE.md §15), which
// RecoupmentProgressBar and ApproachingRecoupmentCard both render.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { getModelRecoupmentLabels } = await import('../../src/lib/commercial-display.ts');

test('Hamilton (central 15926%): "100%+", never a raw percent or an investor multiple', () => {
  // From commercial.json modelRecoupmentPct as of 2026-07-10.
  const l = getModelRecoupmentLabels([14418.4, 15925.6, 17248.4]);
  assert.equal(l.valueText, '100%+');
  assert.equal(l.label, 'Est. 100%+ recouped');
  assert.equal(l.rangeLabel, 'Range: 100%+ in every case');
  assert.equal(l.barWidth, 100);
  for (const text of [l.label, l.rangeLabel, l.ariaLabel]) {
    assert.doesNotMatch(text, /15926|\d+(?:\.\d+)?x\b|returned to investors/,
      'Regression: no raw percent past 100 and no modeled investor multiple');
  }
});

test('Proof (still running, ~2% recouped): estimate label + range, negative low clamps to 0', () => {
  const l = getModelRecoupmentLabels([-17.7, 1.5, 19.4]);
  assert.equal(l.label, 'Est. 2% recouped');
  assert.equal(l.rangeLabel, 'Range: 0–19%');
  assert.equal(l.barWidth, 2);
});

test('just past capitalization (central 105%): "100%+" with a range that crosses 100', () => {
  const l = getModelRecoupmentLabels([90, 105, 120]);
  assert.equal(l.label, 'Est. 100%+ recouped');
  assert.equal(l.rangeLabel, 'Range: 90%–100%+');
  assert.equal(l.barWidth, 100);
});

test('central exactly 200%: no multiple regime any more', () => {
  const l = getModelRecoupmentLabels([180, 200, 220]);
  assert.equal(l.label, 'Est. 100%+ recouped');
  assert.equal(l.rangeLabel, 'Range: 100%+ in every case');
});

test('every model label says "Est." (it is an estimate, never a reported figure)', () => {
  for (const pct of [[10, 20, 30], [40, 55, 70], [90, 105, 120], [500, 600, 700]]) {
    assert.match(getModelRecoupmentLabels(pct).label, /^Est\. /);
  }
});

test('range is hidden when low == high', () => {
  const l = getModelRecoupmentLabels([50, 50, 50]);
  assert.equal(l.label, 'Est. 50% recouped');
  assert.equal(l.rangeLabel, null);
});

test('negative model output clamps to 0 (deep-flop shape, cabaret-2024)', () => {
  const l = getModelRecoupmentLabels([-168.2, -119.8, -74]);
  assert.equal(l.low, 0);
  assert.equal(l.high, 0);
  assert.equal(l.central, 0);
  assert.equal(l.label, 'Est. 0% recouped');
  assert.equal(l.rangeLabel, null);
  assert.equal(l.barWidth, 0);
});

test('legacy 2-value estimate: "~low–high%", capped at "100%+"', () => {
  assert.equal(getModelRecoupmentLabels([30, 50]).label, 'Est. ~30–50% recouped');
  assert.equal(getModelRecoupmentLabels([65, 65]).label, 'Est. ~65% recouped');
  assert.equal(getModelRecoupmentLabels([80, 150]).label, 'Est. ~80%–100%+ recouped');
  assert.equal(getModelRecoupmentLabels([250, 350]).label, 'Est. ~100%+ recouped');
  assert.equal(getModelRecoupmentLabels([30, 50]).rangeLabel, null);
});
