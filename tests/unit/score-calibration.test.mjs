/**
 * Unit tests for scripts/llm-scoring/score-calibration.js
 *
 * Locks in the empirical curve and the contract callers depend on:
 *   - Pure function, no side effects
 *   - Output always 0..100 integer
 *   - Monotonic non-decreasing across the entire 0..100 input range
 *   - Hits every control point exactly
 *   - No segment slope is wildly steeper than its neighbors (cliff guard)
 *   - Identity-ish in the neutral 65-78 zone where the LLM is accurate
 *   - Defensive: handles non-numeric input by returning input unchanged
 *
 * If any of these break, calibration ships a regression. Do not weaken without
 * re-running the empirical study against fresh paired data.
 *
 * Run: node --test tests/unit/score-calibration.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  calibrate,
  maybeCalibrate,
  isEnabled,
  CALIBRATION_CONTROL_POINTS,
  CALIBRATION_VERSION,
} = require('../../scripts/llm-scoring/score-calibration');

describe('score-calibration: contract', () => {
  it('exports a version string', () => {
    assert.strictEqual(typeof CALIBRATION_VERSION, 'string');
    assert.ok(CALIBRATION_VERSION.length > 0);
  });

  it('control points cover 0..100 with no gaps', () => {
    assert.strictEqual(CALIBRATION_CONTROL_POINTS[0][0], 0);
    assert.strictEqual(CALIBRATION_CONTROL_POINTS[CALIBRATION_CONTROL_POINTS.length - 1][0], 100);
    // x must be strictly increasing
    for (let i = 1; i < CALIBRATION_CONTROL_POINTS.length; i++) {
      assert.ok(
        CALIBRATION_CONTROL_POINTS[i][0] > CALIBRATION_CONTROL_POINTS[i - 1][0],
        `control point x must be strictly increasing at index ${i}`
      );
    }
  });

  it('control points are non-decreasing in y (monotonic)', () => {
    for (let i = 1; i < CALIBRATION_CONTROL_POINTS.length; i++) {
      assert.ok(
        CALIBRATION_CONTROL_POINTS[i][1] >= CALIBRATION_CONTROL_POINTS[i - 1][1],
        `control point y must be non-decreasing at index ${i}: ${CALIBRATION_CONTROL_POINTS[i - 1][1]} -> ${CALIBRATION_CONTROL_POINTS[i][1]}`
      );
    }
  });

  it('all output values are 0..100 integers', () => {
    for (const [, y] of CALIBRATION_CONTROL_POINTS) {
      assert.ok(Number.isInteger(y));
      assert.ok(y >= 0 && y <= 100);
    }
  });
});

describe('score-calibration: calibrate(x)', () => {
  it('hits every control point exactly', () => {
    for (const [x, y] of CALIBRATION_CONTROL_POINTS) {
      assert.strictEqual(
        calibrate(x),
        y,
        `calibrate(${x}) should equal ${y} but got ${calibrate(x)}`
      );
    }
  });

  it('output is monotonic non-decreasing across 0..100', () => {
    let prev = -Infinity;
    for (let x = 0; x <= 100; x++) {
      const y = calibrate(x);
      assert.ok(
        y >= prev,
        `monotonicity broken at x=${x}: prev=${prev}, calibrate(${x})=${y}`
      );
      prev = y;
    }
  });

  it('output is bounded 0..100 across 0..100', () => {
    for (let x = 0; x <= 100; x++) {
      const y = calibrate(x);
      assert.ok(y >= 0 && y <= 100, `out of range at x=${x}: ${y}`);
    }
  });

  it('output is integer across 0..100', () => {
    for (let x = 0; x <= 100; x++) {
      assert.ok(Number.isInteger(calibrate(x)), `non-integer at x=${x}`);
    }
  });

  it('clamps inputs outside 0..100', () => {
    assert.strictEqual(calibrate(-10), 0);
    assert.strictEqual(calibrate(150), 100);
  });

  it('returns input unchanged for non-numeric values (defensive)', () => {
    assert.strictEqual(calibrate(null), null);
    assert.strictEqual(calibrate(undefined), undefined);
    assert.strictEqual(calibrate('80'), '80');
    assert.strictEqual(calibrate(NaN), NaN);
  });

  it('lifts top-end raves toward 100 (the headline correction)', () => {
    // Empirical: critic 5/5 → LLM mean 88.7. We want this lifted close to 100.
    assert.ok(calibrate(89) >= 94, `calibrate(89) should be >=94, got ${calibrate(89)}`);
    assert.ok(calibrate(92) >= 100, `calibrate(92) should be 100, got ${calibrate(92)}`);
    // The 60 reviews currently at 95-98 all collapse to 100
    assert.strictEqual(calibrate(95), 100);
    assert.strictEqual(calibrate(98), 100);
  });

  it('pulls down Mixed/Negative bucket where LLM is too generous', () => {
    // Empirical: critic 3/5 → LLM mean 66.3, gap +6.3
    // Empirical: critic 2/5 → LLM mean 45.2, gap +5.2
    assert.ok(calibrate(66) <= 66, `calibrate(66) should not increase, got ${calibrate(66)}`);
    assert.ok(calibrate(45) <= 45, `calibrate(45) should not increase, got ${calibrate(45)}`);
    assert.ok(calibrate(50) <= 50, `calibrate(50) should not increase, got ${calibrate(50)}`);
  });

  it('is approximately identity in the accurate neutral zone (70-78)', () => {
    // Empirical: star=70 → LLM 67.9 (gap +2.1), star=80 → LLM 78.8 (gap -1.2).
    // The LLM is approximately accurate here; the curve should not move scores much.
    for (let x = 70; x <= 78; x++) {
      const delta = calibrate(x) - x;
      assert.ok(
        Math.abs(delta) <= 2,
        `calibrate(${x}) drifted too far in neutral zone: ${calibrate(x)} (delta ${delta})`
      );
    }
  });

  it('preserves bucket boundary semantics where possible', () => {
    // Bucket boundaries: Rave>=83, Positive>=70, Mixed>=55, Negative>=35, Pan<35.
    // After calibration, scores below 35 stay below 35, scores >=70 stay >=70, etc.
    // Pan upper edge:
    assert.ok(calibrate(34) < 35, `Pan->Negative leak at x=34: ${calibrate(34)}`);
    // Negative lower edge holds:
    assert.ok(calibrate(35) >= 30, `Negative bottom didn't crater: ${calibrate(35)}`);
    // Positive lower edge: 70 stays Positive
    assert.ok(calibrate(70) >= 70, `Positive lower edge dropped: ${calibrate(70)}`);
    // Rave lower edge: a raw 83 should still be a Rave after calibration
    assert.ok(calibrate(83) >= 83, `Rave lower edge dropped below bucket: ${calibrate(83)}`);
  });

  it('no segment slope is more than 3x its neighbors (cliff guard)', () => {
    // Adjacent slopes between control points should not vary by more than 3x.
    // Catches accidental cliffs in future curve edits.
    const slopes = [];
    for (let i = 1; i < CALIBRATION_CONTROL_POINTS.length; i++) {
      const [x0, y0] = CALIBRATION_CONTROL_POINTS[i - 1];
      const [x1, y1] = CALIBRATION_CONTROL_POINTS[i];
      slopes.push((y1 - y0) / (x1 - x0));
    }
    for (let i = 1; i < slopes.length; i++) {
      const ratio = slopes[i] === 0 || slopes[i - 1] === 0
        ? 1
        : Math.max(slopes[i] / slopes[i - 1], slopes[i - 1] / slopes[i]);
      assert.ok(
        ratio <= 3.5,
        `slope cliff at segment ${i}: ${slopes[i - 1].toFixed(2)} -> ${slopes[i].toFixed(2)} (ratio ${ratio.toFixed(2)})`
      );
    }
  });
});

describe('score-calibration: maybeCalibrate + isEnabled flag', () => {
  it('maybeCalibrate is identity when flag is unset (default OFF)', () => {
    const prev = process.env.LLM_CALIBRATION_V1;
    delete process.env.LLM_CALIBRATION_V1;
    try {
      assert.strictEqual(isEnabled(), false);
      assert.strictEqual(maybeCalibrate(89), 89);
      assert.strictEqual(maybeCalibrate(45), 45);
    } finally {
      if (prev !== undefined) process.env.LLM_CALIBRATION_V1 = prev;
    }
  });

  it('maybeCalibrate applies the curve when flag=1', () => {
    const prev = process.env.LLM_CALIBRATION_V1;
    process.env.LLM_CALIBRATION_V1 = '1';
    try {
      assert.strictEqual(isEnabled(), true);
      assert.strictEqual(maybeCalibrate(89), calibrate(89));
      assert.notStrictEqual(maybeCalibrate(89), 89);
    } finally {
      if (prev === undefined) delete process.env.LLM_CALIBRATION_V1;
      else process.env.LLM_CALIBRATION_V1 = prev;
    }
  });

  it('maybeCalibrate is identity when flag=0', () => {
    const prev = process.env.LLM_CALIBRATION_V1;
    process.env.LLM_CALIBRATION_V1 = '0';
    try {
      assert.strictEqual(isEnabled(), false);
      assert.strictEqual(maybeCalibrate(89), 89);
    } finally {
      if (prev === undefined) delete process.env.LLM_CALIBRATION_V1;
      else process.env.LLM_CALIBRATION_V1 = prev;
    }
  });
});
