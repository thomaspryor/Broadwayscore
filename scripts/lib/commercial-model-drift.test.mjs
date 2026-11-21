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
    assert.match(result.message, /2 unexplained modelDesignationFlag/);
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

// BRO-6755: an explained false negative (Legally Blonde's owner-sourced recoup) appearing in the
// flag list is not drift; a new unexplained contradiction still is.
describe('explained contradictions', () => {
  const mk = (date, shows) => ({ date, modelDesignationFlagCount: shows.length,
    modelDesignationFlags: shows.map((show) => ({ show, flag: 'Model: -59% vs designation: Recouped' })) });
  it('does not warn when the new flag is an explained false negative', () => {
    const h = [mk('2026-07-01T00:00:00.000Z', ['harry-potter', 'kimberly-akimbo-2022']),
      mk('2026-07-08T00:00:00.000Z', ['harry-potter', 'kimberly-akimbo-2022', 'legally-blonde-2007'])];
    assert.equal(computeCommercialModelDriftStatus(h, NOW).status, 'pass');
  });
  it('still warns when the new flag is unexplained', () => {
    const h = [mk('2026-07-01T00:00:00.000Z', ['harry-potter']), mk('2026-07-08T00:00:00.000Z', ['harry-potter', 'some-new-show'])];
    assert.equal(computeCommercialModelDriftStatus(h, NOW).status, 'warn');
  });
});
describe('explained kind only (BRO-6755 review)', () => {
  it('counts a listed show that flips to a different contradiction', () => {
    const h = [{ date: '2026-07-01T00:00:00.000Z', modelDesignationFlags: [{ show: 'legally-blonde-2007', flag: 'Model: -59% vs designation: Recouped' }] },
      { date: '2026-07-08T00:00:00.000Z', modelDesignationFlags: [{ show: 'legally-blonde-2007', flag: 'Model: 150% vs designation: Flop' }] }];
    const r = computeCommercialModelDriftStatus(h, NOW);
    assert.equal(r.status, 'warn');
    assert.match(r.message, /unexplained modelDesignationFlag contradictions up 1/);
  });
});
describe('explained winner labels (BRO-6755 ship-check)', () => {
  const { unexplainedFlagCount } = require('./commercial-model-drift.js');
  const f = (show, flag) => ({ modelDesignationFlags: [{ show, flag }] });
  it('excludes explained shows under every winner label', () => {
    assert.equal(unexplainedFlagCount(f('sea-wall-a-life-2019', 'Model: -3% vs designation: Easy Winner')), 0);
    assert.equal(unexplainedFlagCount(f('next-to-normal-2009', 'Model: -218% vs designation: Windfall')), 0);
    assert.equal(unexplainedFlagCount(f('legally-blonde-2007', 'Model: -59% vs designation: Recouped')), 0);
  });
  it('counts a listed show with a non-winner or non-negative contradiction, and unlisted shows', () => {
    assert.equal(unexplainedFlagCount(f('legally-blonde-2007', 'Model: 417% vs designation: Trickle')), 1);
    assert.equal(unexplainedFlagCount(f('legally-blonde-2007', 'Model: 150% vs designation: Flop')), 1);
    assert.equal(unexplainedFlagCount(f('some-new-show', 'Model: -59% vs designation: Recouped')), 1);
  });
  it('falls back to the stored count without a per-show list', () => {
    assert.equal(unexplainedFlagCount({ modelDesignationFlagCount: 4 }), 4);
  });
});
