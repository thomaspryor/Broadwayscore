/**
 * BRO-4335: monotone tail stretch wired after the ensemble combine.
 *
 * Requires the real functions (CLAUDE.md §15): applyTailStretch from
 * ensemble.ts, finalizeScoredFile from ensemble-scorer.ts, and the exported
 * shouldSkip / recomputeEnsemble from re-ensemble-scores.ts. No API calls.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
process.env.TS_NODE_PROJECT = new URL('../tsconfig.json', import.meta.url).pathname;
require('ts-node/register');

const { ensembleScoreFromArray, applyTailStretch, scoreToBucket, TAIL_STRETCH_KNOTS_ID } = require('./ensemble');
const { EnsembleReviewScorer } = require('./ensemble-scorer');
const { shouldSkip, recomputeEnsemble, planReensemble, applyReensemble, applyStamp, progressFileFor } = require('../re-ensemble-scores');

function ms(model, score) {
  return { model, score, bucket: scoreToBucket(score), confidence: 'high' };
}

/** Deterministic spread of 1/2/3-model inputs across the whole 0-100 range. */
function inputMatrix() {
  const out = [];
  for (let a = 0; a <= 100; a += 7) {
    out.push([ms('claude', a)]);
    for (let b = 0; b <= 100; b += 11) {
      out.push([ms('claude', a), ms('openai', b)]);
      for (let c = 0; c <= 100; c += 13) out.push([ms('claude', a), ms('openai', b), ms('gemini', c)]);
    }
  }
  return out;
}

let savedEnv;
beforeEach(() => { savedEnv = process.env.ENSEMBLE_TAIL_STRETCH; delete process.env.ENSEMBLE_TAIL_STRETCH; });
afterEach(() => {
  if (savedEnv === undefined) delete process.env.ENSEMBLE_TAIL_STRETCH;
  else process.env.ENSEMBLE_TAIL_STRETCH = savedEnv;
});

describe('applyTailStretch (ensemble.ts)', () => {
  test('flag off: returns the identical object for every source, byte-identical JSON', () => {
    for (const models of inputMatrix()) {
      const base = ensembleScoreFromArray(models);
      const before = JSON.stringify(base);
      for (const src of ['llm-v6', 'anchored-v6', null, undefined]) {
        const out = applyTailStretch(base, src);
        assert.equal(out, base);
        assert.equal(JSON.stringify(out), before);
      }
    }
  });

  test('flag on: only llm-v6 is stretched; anchored-v6 / unstamped pass through untouched', () => {
    process.env.ENSEMBLE_TAIL_STRETCH = '1';
    const base = ensembleScoreFromArray([ms('claude', 95), ms('openai', 95), ms('gemini', 95)]);
    assert.equal(base.score, 95);
    for (const src of ['anchored-v6', null, undefined, 'llm-v5']) assert.equal(applyTailStretch(base, src), base);
    const out = applyTailStretch(base, 'llm-v6');
    assert.notEqual(out, base);
    assert.equal(out.score, 99);
    assert.equal(out.bucket, 'Rave');
    assert.deepEqual(out.tailStretch, { preStretchScore: 95, knots: TAIL_STRETCH_KNOTS_ID });
    assert.equal(base.score, 95, 'input not mutated');
    assert.equal(base.tailStretch, undefined);
  });

  test('flag on: monotone, in bounds, never lowers, bucket unchanged over the whole matrix', () => {
    const pairs = [];
    for (const models of inputMatrix()) {
      const base = ensembleScoreFromArray(models);
      const out = applyTailStretch(base, 'llm-v6', { enabled: true });
      assert.ok(out.score >= 0 && out.score <= 100, `bounds ${out.score}`);
      assert.ok(out.score >= base.score, `never lowers ${base.score} -> ${out.score}`);
      if (base.score <= 88) assert.equal(out.score, base.score, `identity to 88 (${base.score})`);
      assert.equal(out.bucket, scoreToBucket(out.score));
      assert.equal(out.bucket, base.bucket, `no bucket change at ${base.score}`);
      pairs.push([base.score, out.score]);
    }
    pairs.sort((x, y) => x[0] - y[0]);
    for (let i = 1; i < pairs.length; i++) assert.ok(pairs[i][1] >= pairs[i - 1][1], `monotone at ${pairs[i][0]}`);
  });

  test('flag on: all-failed and rejected results pass through', () => {
    const failed = ensembleScoreFromArray([null, null, null]);
    assert.equal(failed.allModelsFailed, true);
    assert.equal(applyTailStretch(failed, 'llm-v6', { enabled: true }), failed);
    const rejected = { ...ensembleScoreFromArray([ms('claude', 95)]), rejected: true };
    assert.equal(applyTailStretch(rejected, 'llm-v6', { enabled: true }), rejected);
  });
});

describe('finalizeScoredFile (live path, sync + --batch share it)', () => {
  const LONG = Array(12).fill('The revival is a considerable pleasure, finely acted and handsomely designed, and it lingers well after the curtain falls.').join(' ');
  function setup() {
    const scorer = new EnsembleReviewScorer('sk-ant-fake', 'sk-fake', 'fake-gemini', undefined, { verbose: false });
    const reviewFile = {
      showId: 'a-catered-affair-2008', showTitle: 'A Catered Affair', outletId: 'nytimes',
      outlet: 'The New York Times', criticName: 'Ben Brantley', publishDate: '2008-04-18',
      category: 'broadway', venue: 'Walter Kerr Theatre', fullText: LONG, originalScore: null,
    };
    const prepared = scorer.prepareScoringInput(reviewFile);
    assert.equal(prepared.ok, true);
    const ens = ensembleScoreFromArray([ms('claude', 95), ms('openai', 95), ms('gemini', 95)]);
    return { scorer, reviewFile, prep: { ...prepared.prep, anchoredBandScoreSource: 'llm-v6' }, ens };
  }
  const strip = (f) => { const c = JSON.parse(JSON.stringify(f)); delete c.llmMetadata.scoredAt; return c; };

  test('flag off: llm-v6 file keeps the raw combine and gets no tailStretch stamp', () => {
    const { scorer, reviewFile, prep, ens } = setup();
    const out = scorer.finalizeScoredFile(reviewFile, ens, prep);
    assert.equal(out.success, true);
    assert.equal(out.scoredFile.llmScore.score, 95);
    assert.equal(out.scoredFile.assignedScore, 95);
    assert.equal('tailStretch' in out.scoredFile.ensembleData, false);
    assert.equal(out.scoredFile.scoreSource, 'llm-v6');
  });

  test('flag on: llm-v6 file is stretched, per-model scores stay raw, pre-stretch score stamped', () => {
    const { scorer, reviewFile, prep, ens } = setup();
    const offFile = strip(scorer.finalizeScoredFile(reviewFile, ens, prep).scoredFile);
    process.env.ENSEMBLE_TAIL_STRETCH = '1';
    const onFile = strip(scorer.finalizeScoredFile(reviewFile, ens, prep).scoredFile);
    assert.equal(onFile.llmScore.score, 99);
    assert.equal(onFile.assignedScore, 99);
    assert.deepEqual(onFile.llmScore.range, { low: 94, high: 100 }, 'range clamped to 0..100');
    assert.equal(onFile.ensembleData.claudeScore, 95);
    assert.deepEqual(onFile.ensembleData.tailStretch, { preStretchScore: 95, knots: TAIL_STRETCH_KNOTS_ID });
    // anchored path untouched even with the flag on
    const anch = scorer.finalizeScoredFile(reviewFile, ens, { ...prep, anchoredBandScoreSource: 'anchored-v6' });
    assert.equal(anch.scoredFile.llmScore.score, 95);
    assert.notEqual(offFile.llmScore.score, onFile.llmScore.score);
  });
});

describe('re-ensemble-scores.ts reapply (stored per-model scores, no API calls)', () => {
  function rec(overrides = {}) {
    return {
      scoreSource: 'llm-v6',
      llmScore: { score: 95, bucket: 'Rave' },
      assignedScore: 95,
      ensembleData: { claudeScore: 95, claudeBucket: 'Rave', openaiScore: 95, openaiBucket: 'Rave', geminiScore: 95, geminiBucket: 'Rave' },
      ...overrides,
    };
  }

  test('shouldSkip flag off is unchanged; tail-stretch run skips non-llm-v6', () => {
    assert.equal(shouldSkip(rec()), null);
    assert.equal(shouldSkip(rec({ scoreSource: undefined })), null);
    assert.equal(shouldSkip(rec({ scoreSource: 'anchored-v6' })), 'band-anchored');
    assert.equal(shouldSkip(rec({ llmScore: { score: 90, bucket: 'Rave', band: { floor: 83, ceiling: 100 } } })), 'band-anchored');
    assert.equal(shouldSkip(rec({ scoreSource: undefined }), { tailStretch: true }), 'not llm-v6 (tail-stretch run)');
    assert.equal(shouldSkip(rec({ scoreSource: 'anchored-v6' }), { tailStretch: true }), 'band-anchored');
    assert.equal(shouldSkip(rec(), { tailStretch: true }), null);
    assert.equal(shouldSkip(rec({ rejectedAt: 'x' }), { tailStretch: true }), 'rejected');
    assert.equal(shouldSkip(rec({ varietyPromoStrip: { restored: true } }), { tailStretch: true }), 'variety-strip score kept');
  });

  test('recomputeEnsemble flag off equals the plain combine (byte-identical)', () => {
    for (const models of inputMatrix()) {
      if (models.length < 2) continue;
      const ed = {};
      for (const m of models) { ed[`${m.model}Score`] = m.score; ed[`${m.model}Bucket`] = m.bucket; }
      const plain = ensembleScoreFromArray(models.map((m) => ({ ...m })));
      assert.equal(JSON.stringify(recomputeEnsemble(rec({ ensembleData: ed }))), JSON.stringify(plain));
    }
  });

  /** Run one file through the script's real per-file decision + write path. */
  function runOnce(data, opts) {
    const plan = planReensemble(data, opts);
    if (plan.action === 'changed') applyReensemble(data, plan.result);
    else if (plan.action === 'restamp') applyStamp(data, plan.result);
    return plan;
  }

  test('flag on: stretch applied once, rerun hits the real unchanged branch, flag-off rollback restores', () => {
    const r = rec();
    const first = runOnce(r, { tailStretch: true });
    assert.equal(first.action, 'changed');
    assert.equal(r.llmScore.score, 99);
    assert.equal(r.assignedScore, 99);
    assert.equal(r.ensembleData.claudeScore, 95, 'per-model scores stay raw');
    assert.deepEqual(r.ensembleData.tailStretch, { preStretchScore: 95, knots: TAIL_STRETCH_KNOTS_ID });
    assert.equal(r.rescoreReason, 're-ensemble-tail-stretch');

    const second = runOnce(r, { tailStretch: true });
    assert.equal(second.action, 'unchanged');
    assert.equal(r.llmScore.score, 99);

    const back = runOnce(r);
    assert.equal(back.action, 'changed');
    assert.equal(r.llmScore.score, 95);
    assert.equal(r.assignedScore, 95);
    assert.equal('tailStretch' in r.ensembleData, false);
    assert.equal(runOnce(r).action, 'unchanged');
  });

  test('flag on: a no-op stretch (<= 88) writes no stamp', () => {
    const ed = { claudeScore: 80, claudeBucket: 'Positive', openaiScore: 80, openaiBucket: 'Positive', geminiScore: 80, geminiBucket: 'Positive' };
    const r = rec({ llmScore: { score: 80, bucket: 'Positive' }, assignedScore: 80, ensembleData: ed });
    assert.equal(runOnce(r, { tailStretch: true }).action, 'unchanged');
    assert.equal('tailStretch' in r.ensembleData, false);
  });

  test('rollback drops a stale stamp even when the score is unchanged', () => {
    const r = rec({ llmScore: { score: 95, bucket: 'Rave' } });
    r.ensembleData.tailStretch = { preStretchScore: 95, knots: 'tail-only-v1' };
    const plan = runOnce(r);
    assert.equal(plan.action, 'restamp');
    assert.equal('tailStretch' in r.ensembleData, false);
    assert.equal(r.llmScore.score, 95);
    assert.equal(runOnce(r).action, 'unchanged');
  });

  test('flag on: combine drift (stored score is not the plain combine) is skipped, not re-declustered', () => {
    // stored 91 but per-model scores combine to 95: something else moved this score
    const r = rec({ llmScore: { score: 91, bucket: 'Rave' }, assignedScore: 91 });
    assert.deepEqual(runOnce(r, { tailStretch: true }), { action: 'skip', reason: 'combine drift' });
    assert.equal(r.llmScore.score, 91);
    // stamped file whose stamped pre-stretch no longer matches the combine: also drift
    const s = rec({ llmScore: { score: 99, bucket: 'Rave' } });
    s.ensembleData.tailStretch = { preStretchScore: 94, knots: 'tail-only-v1' };
    assert.equal(planReensemble(s, { tailStretch: true }).reason, 'combine drift');
    // flag off keeps the old behaviour: drift is re-ensembled as before
    assert.equal(planReensemble(rec({ llmScore: { score: 91, bucket: 'Rave' } })).action, 'changed');
  });

  test('progress checkpoint is per mode, so a rollback run is never skipped by a stretch run', () => {
    assert.match(progressFileFor(false), /re-ensemble-progress\.json$/);
    assert.match(progressFileFor(true), /re-ensemble-progress-tail-stretch\.json$/);
    assert.notEqual(progressFileFor(true), progressFileFor(false));
  });
});
