// Unit tests for scripts/lib/commercial-model-drift.js.
// Per feedback_test_extraction_pattern.md — require() the real lib.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { computeCommercialModelDriftStatus } = require('./commercial-model-drift.js');

describe('computeCommercialModelDriftStatus', () => {
  it('warns when history is missing or empty', () => {
    assert.equal(computeCommercialModelDriftStatus(undefined).status, 'warn');
    assert.equal(computeCommercialModelDriftStatus(null).status, 'warn');
    assert.equal(computeCommercialModelDriftStatus([]).status, 'warn');
  });

  it('passes with a single entry (no prior week to compare)', () => {
    const history = [
      { date: '2026-07-01T00:00:00.000Z', modelDesignationFlagCount: 2, aiEstimatedCount: 100 },
    ];
    const result = computeCommercialModelDriftStatus(history);
    assert.equal(result.status, 'pass');
    assert.match(result.message, /2 modelDesignationFlag/);
    assert.match(result.message, /100 ai-estimated/);
  });

  it('passes when latest entry is stable vs prior', () => {
    const history = [
      { date: '2026-07-01T00:00:00.000Z', modelDesignationFlagCount: 4, aiEstimatedCount: 116 },
      { date: '2026-07-08T00:00:00.000Z', modelDesignationFlagCount: 4, aiEstimatedCount: 116 },
    ];
    const result = computeCommercialModelDriftStatus(history);
    assert.equal(result.status, 'pass');
  });

  it('passes when counts decrease (improvement, not drift)', () => {
    const history = [
      { date: '2026-07-01T00:00:00.000Z', modelDesignationFlagCount: 6, aiEstimatedCount: 120 },
      { date: '2026-07-08T00:00:00.000Z', modelDesignationFlagCount: 3, aiEstimatedCount: 110 },
    ];
    const result = computeCommercialModelDriftStatus(history);
    assert.equal(result.status, 'pass');
  });

  it('warns when modelDesignationFlag contradictions increase week over week', () => {
    const history = [
      { date: '2026-07-01T00:00:00.000Z', modelDesignationFlagCount: 4, aiEstimatedCount: 116 },
      { date: '2026-07-08T00:00:00.000Z', modelDesignationFlagCount: 9, aiEstimatedCount: 116 },
    ];
    const result = computeCommercialModelDriftStatus(history);
    assert.equal(result.status, 'warn');
    assert.match(result.message, /modelDesignationFlag contradictions up 5 \(4 → 9\)/);
  });

  it('warns when ai-estimated tier count jumps week over week', () => {
    const history = [
      { date: '2026-07-01T00:00:00.000Z', modelDesignationFlagCount: 4, aiEstimatedCount: 116 },
      { date: '2026-07-08T00:00:00.000Z', modelDesignationFlagCount: 4, aiEstimatedCount: 140 },
    ];
    const result = computeCommercialModelDriftStatus(history);
    assert.equal(result.status, 'warn');
    assert.match(result.message, /ai-estimated tier count up 24 \(116 → 140\)/);
  });

  it('warns and reports both signals when both drift', () => {
    const history = [
      { date: '2026-07-01T00:00:00.000Z', modelDesignationFlagCount: 4, aiEstimatedCount: 116 },
      { date: '2026-07-08T00:00:00.000Z', modelDesignationFlagCount: 10, aiEstimatedCount: 150 },
    ];
    const result = computeCommercialModelDriftStatus(history);
    assert.equal(result.status, 'warn');
    assert.match(result.message, /modelDesignationFlag contradictions up 6/);
    assert.match(result.message, /ai-estimated tier count up 34/);
  });

  it('treats missing counts as 0 defensively', () => {
    const history = [{ date: '2026-07-01T00:00:00.000Z' }, { date: '2026-07-08T00:00:00.000Z' }];
    const result = computeCommercialModelDriftStatus(history);
    assert.equal(result.status, 'pass');
  });
});
