/**
 * Unit tests for the rolling-EMA per-model calibration script (Phase B, task
 * #384; generalized to all 4 ensemble models, BRO-197).
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { computeSignedGap, computeEma, recommendedOffsetFromEma, statePath, VALID_MODELS, DEFAULT_MODEL } = require('../../scripts/llm-scoring/gemini-calibration-ema');

describe('computeSignedGap', () => {
  test('positive gap when Gemini scores higher than the majority', () => {
    const entry = {
      outlier: { model: 'gemini', score: 90 },
      models: [
        { model: 'claude', score: 70 },
        { model: 'openai', score: 74 },
        { model: 'gemini', score: 90 },
      ],
    };
    assert.strictEqual(computeSignedGap(entry), 18);
  });

  test('negative gap when Gemini scores lower than the majority', () => {
    const entry = {
      outlier: { model: 'gemini', score: 40 },
      models: [
        { model: 'claude', score: 65 },
        { model: 'openai', score: 63 },
        { model: 'gemini', score: 40 },
      ],
    };
    assert.strictEqual(computeSignedGap(entry), -24);
  });

  test('returns null when the outlier is not gemini', () => {
    const entry = {
      outlier: { model: 'claude', score: 40 },
      models: [
        { model: 'claude', score: 40 },
        { model: 'openai', score: 65 },
        { model: 'gemini', score: 63 },
      ],
    };
    assert.strictEqual(computeSignedGap(entry), null);
  });

  test('returns null for a malformed entry', () => {
    assert.strictEqual(computeSignedGap({}), null);
    assert.strictEqual(computeSignedGap(null), null);
    assert.strictEqual(computeSignedGap({ outlier: { model: 'gemini', score: 90 } }), null);
  });

  test('defaults to gemini when no model is passed', () => {
    const entry = {
      outlier: { model: 'gemini', score: 90 },
      models: [
        { model: 'claude', score: 70 },
        { model: 'openai', score: 74 },
        { model: 'gemini', score: 90 },
      ],
    };
    assert.strictEqual(computeSignedGap(entry), computeSignedGap(entry, 'gemini'));
  });

  test('computes the gap for openai as the sole outlier', () => {
    const entry = {
      outlier: { model: 'openai', score: 15 },
      models: [
        { model: 'claude', score: 35 },
        { model: 'openai', score: 15 },
        { model: 'gemini', score: 15 },
      ],
    };
    assert.strictEqual(computeSignedGap(entry, 'openai'), -10);
  });

  test('computes the gap for claude as the sole outlier', () => {
    const entry = {
      outlier: { model: 'claude', score: 62 },
      models: [
        { model: 'claude', score: 62 },
        { model: 'gemini', score: 75 },
        { model: 'kimi', score: 76 },
      ],
    };
    assert.strictEqual(computeSignedGap(entry, 'claude'), -13.5);
  });

  test('computes the gap for kimi as the sole outlier', () => {
    const entry = {
      outlier: { model: 'kimi', score: 77 },
      models: [
        { model: 'claude', score: 62 },
        { model: 'gemini', score: 65 },
        { model: 'kimi', score: 77 },
      ],
    };
    assert.strictEqual(computeSignedGap(entry, 'kimi'), 13.5);
  });

  test('returns null when the requested model is not the outlier, even for other models', () => {
    const entry = {
      outlier: { model: 'openai', score: 15 },
      models: [
        { model: 'claude', score: 35 },
        { model: 'openai', score: 15 },
        { model: 'gemini', score: 15 },
      ],
    };
    assert.strictEqual(computeSignedGap(entry, 'claude'), null);
    assert.strictEqual(computeSignedGap(entry, 'gemini'), null);
    assert.strictEqual(computeSignedGap(entry, 'kimi'), null);
  });
});

describe('per-model state paths', () => {
  test('gemini is the default model and its path matches the original filename', () => {
    assert.strictEqual(DEFAULT_MODEL, 'gemini');
    assert.ok(statePath('gemini').endsWith('data/audit/gemini-calibration-ema-state.json'));
    assert.strictEqual(statePath(), statePath('gemini'));
  });

  test('each valid model gets its own state file path', () => {
    const paths = VALID_MODELS.map(m => statePath(m));
    assert.strictEqual(new Set(paths).size, VALID_MODELS.length);
    for (const model of VALID_MODELS) {
      assert.ok(statePath(model).endsWith(`${model}-calibration-ema-state.json`));
    }
  });
});

describe('computeEma', () => {
  test('single observation moves the EMA by alpha * gap', () => {
    const ema = computeEma([20], 0.1, 0);
    assert.strictEqual(ema, 2);
  });

  test('converges toward a constant stream of observations', () => {
    const ema = computeEma(Array(200).fill(10), 0.1, 0);
    assert.ok(Math.abs(ema - 10) < 0.001, `expected ~10, got ${ema}`);
  });

  test('empty observation list returns the seed unchanged', () => {
    assert.strictEqual(computeEma([], 0.1, 5), 5);
  });

  test('real Cititour-style gap sequence biases positive (Gemini high)', () => {
    // Same shape as the ensemble-sole-outlier-queue.jsonl data: mostly positive
    // gaps averaging ~12pts, matching the measured 82%-positive / +12.2pt mean.
    const gaps = [14, 18, 9, -3, 15, 20, 11, 8, -5, 17];
    const ema = computeEma(gaps, 0.05, 0);
    assert.ok(ema > 0, `expected a positive EMA for a high-biased sequence, got ${ema}`);
  });
});

describe('recommendedOffsetFromEma', () => {
  test('positive EMA (Gemini scores high) recommends a negative correction', () => {
    assert.strictEqual(recommendedOffsetFromEma(10.51), -11);
  });

  test('negative EMA (Gemini scores low) recommends a positive correction', () => {
    assert.strictEqual(recommendedOffsetFromEma(-6.2), 6);
  });

  test('zero EMA recommends no correction', () => {
    assert.strictEqual(recommendedOffsetFromEma(0), -0);
  });
});
