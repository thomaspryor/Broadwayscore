// Unit tests for scripts/lib/commercial-model-drift.js.
// Per feedback_test_extraction_pattern.md — require() the real lib.

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const NOW = Date.parse('2026-07-08T12:00:00Z');
const { computeCommercialModelDriftStatus, aiEstimatedShare } = require('./commercial-model-drift.js');

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
    const result = computeCommercialModelDriftStatus(history, NOW);
    assert.equal(result.status, 'pass');
    assert.match(result.message, /2 modelDesignationFlag/);
    assert.match(result.message, /100 ai-estimated/);
  });

  it('passes when latest entry is stable vs prior', () => {
    const history = [
      { date: '2026-07-01T00:00:00.000Z', modelDesignationFlagCount: 4, aiEstimatedCount: 116 },
      { date: '2026-07-08T00:00:00.000Z', modelDesignationFlagCount: 4, aiEstimatedCount: 116 },
    ];
    const result = computeCommercialModelDriftStatus(history, NOW);
    assert.equal(result.status, 'pass');
  });

  it('passes when counts decrease (improvement, not drift)', () => {
    const history = [
      { date: '2026-07-01T00:00:00.000Z', modelDesignationFlagCount: 6, aiEstimatedCount: 120 },
      { date: '2026-07-08T00:00:00.000Z', modelDesignationFlagCount: 3, aiEstimatedCount: 110 },
    ];
    const result = computeCommercialModelDriftStatus(history, NOW);
    assert.equal(result.status, 'pass');
  });

  it('warns when modelDesignationFlag contradictions increase week over week', () => {
    const history = [
      { date: '2026-07-01T00:00:00.000Z', modelDesignationFlagCount: 4, aiEstimatedCount: 116 },
      { date: '2026-07-08T00:00:00.000Z', modelDesignationFlagCount: 9, aiEstimatedCount: 116 },
    ];
    const result = computeCommercialModelDriftStatus(history, NOW);
    assert.equal(result.status, 'warn');
    assert.match(result.message, /modelDesignationFlag contradictions up 5 \(4 → 9\)/);
  });

  it('warns when ai-estimated tier count jumps week over week', () => {
    const history = [
      { date: '2026-07-01T00:00:00.000Z', modelDesignationFlagCount: 4, aiEstimatedCount: 116 },
      { date: '2026-07-08T00:00:00.000Z', modelDesignationFlagCount: 4, aiEstimatedCount: 140 },
    ];
    const result = computeCommercialModelDriftStatus(history, NOW);
    assert.equal(result.status, 'warn');
    assert.match(result.message, /ai-estimated tier count up 24 \(116 → 140\)/);
  });

  it('warns and reports both signals when both drift', () => {
    const history = [
      { date: '2026-07-01T00:00:00.000Z', modelDesignationFlagCount: 4, aiEstimatedCount: 116 },
      { date: '2026-07-08T00:00:00.000Z', modelDesignationFlagCount: 10, aiEstimatedCount: 150 },
    ];
    const result = computeCommercialModelDriftStatus(history, NOW);
    assert.equal(result.status, 'warn');
    assert.match(result.message, /modelDesignationFlag contradictions up 6/);
    assert.match(result.message, /ai-estimated tier count up 34/);
  });

  // BRO-5749: real 2026-10-24 → 2026-10-31 rows. The modelled set grew
  // 425 → 476, so 8 more ai-estimated shows is a falling share, not drift.
  it('passes when ai-estimated count rises only because the modelled set grew', () => {
    const history = [
      { date: '2026-07-01T00:00:00.000Z', modelDesignationFlagCount: 5, aiEstimatedCount: 118,
        modelMethodBreakdown: { 'simplified-lifetime': 8, 'ai-estimated': 118, 'weekly-model': 299 } },
      { date: '2026-07-08T00:00:00.000Z', modelDesignationFlagCount: 2, aiEstimatedCount: 126,
        modelMethodBreakdown: { 'simplified-lifetime': 8, 'ai-estimated': 126, 'weekly-model': 342 } },
    ];
    const result = computeCommercialModelDriftStatus(history, NOW);
    assert.equal(result.status, 'pass', result.message);
  });

  it('warns when the ai-estimated share of modelled shows rises', () => {
    const history = [
      { date: '2026-07-01T00:00:00.000Z', modelDesignationFlagCount: 2, aiEstimatedCount: 100,
        modelMethodBreakdown: { 'ai-estimated': 100, 'weekly-model': 300 } },
      { date: '2026-07-08T00:00:00.000Z', modelDesignationFlagCount: 2, aiEstimatedCount: 120,
        modelMethodBreakdown: { 'ai-estimated': 120, 'weekly-model': 280 } },
    ];
    const result = computeCommercialModelDriftStatus(history, NOW);
    assert.equal(result.status, 'warn');
    assert.match(result.message, /ai-estimated share up 5\.0 pts \(25\.0% → 30\.0%; count 100 → 120\)/);
  });

  it('ignores a share rise below the rounding tolerance', () => {
    const history = [
      { date: '2026-07-01T00:00:00.000Z', aiEstimatedCount: 100, modelMethodBreakdown: { 'ai-estimated': 100, 'weekly-model': 300 } },
      { date: '2026-07-08T00:00:00.000Z', aiEstimatedCount: 101, modelMethodBreakdown: { 'ai-estimated': 101, 'weekly-model': 300 } },
    ];
    assert.equal(computeCommercialModelDriftStatus(history, NOW).status, 'pass');
  });

  it('aiEstimatedShare returns null without a usable breakdown', () => {
    assert.equal(aiEstimatedShare({ aiEstimatedCount: 5 }), null);
    assert.equal(aiEstimatedShare({ aiEstimatedCount: 5, modelMethodBreakdown: {} }), null);
    assert.equal(aiEstimatedShare({ aiEstimatedCount: 1, modelMethodBreakdown: { 'ai-estimated': 1, 'weekly-model': 3 } }), 0.25);
  });

  it('treats missing counts as 0 defensively', () => {
    const history = [{ date: '2026-07-01T00:00:00.000Z' }, { date: '2026-07-08T00:00:00.000Z' }];
    const result = computeCommercialModelDriftStatus(history, NOW);
    assert.equal(result.status, 'pass');
  });
});
