import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  verifyGatherStage,
  verifyCollectStage,
  verifyScoreStage,
  verifyRebuildStage,
  verifyDeployStage,
  verifyPipeline,
} = require('./lib/opening-night-pipeline-stages.js');
const { buildStageResults } = require('./opening-night-pipeline-verify.js');

describe('verifyGatherStage / verifyScoreStage (counted, per-show)', () => {
  test('nothing to do is ok', () => {
    assert.deepEqual(verifyGatherStage({ failed: 0, total: 0 }), {
      ok: true,
      reason: 'gather: nothing to do',
    });
  });

  test('all shows succeeded is ok, not degraded', () => {
    const r = verifyGatherStage({ failed: 0, total: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.degraded, undefined);
  });

  test('partial failure is ok but degraded — does not stop the pipeline', () => {
    const r = verifyScoreStage({ failed: 1, total: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.degraded, true);
    assert.match(r.reason, /1\/3 failed/);
  });

  test('total failure across every show is not ok', () => {
    const r = verifyGatherStage({ failed: 4, total: 4 });
    assert.equal(r.ok, false);
    assert.match(r.reason, /all 4 failed/);
  });
});

describe('verifyCollectStage / verifyRebuildStage (single step outcome)', () => {
  test('skipped when not attempted', () => {
    assert.equal(verifyCollectStage({ attempted: false }).ok, true);
  });

  test('success outcome is ok', () => {
    assert.equal(verifyCollectStage({ attempted: true, outcome: 'success' }).ok, true);
  });

  test('skipped outcome (GH Actions step-level skip) is ok', () => {
    assert.equal(verifyRebuildStage({ attempted: true, outcome: 'skipped' }).ok, true);
  });

  test('failure outcome crashes the stage', () => {
    const r = verifyRebuildStage({ attempted: true, outcome: 'failure' });
    assert.equal(r.ok, false);
    assert.match(r.reason, /crashed/);
  });

  test('missing outcome (unattempted step) is treated as a crash, not silently ok', () => {
    const r = verifyCollectStage({ attempted: true, outcome: undefined });
    assert.equal(r.ok, false);
  });
});

describe('verifyDeployStage', () => {
  test('skipped when no rebuild happened', () => {
    assert.equal(verifyDeployStage({ attempted: false }).ok, true);
  });

  test('dispatch call failure is ok but degraded — the 5-min cron gate is the backstop, not a page-worthy failure', () => {
    const r = verifyDeployStage({ attempted: true, dispatched: false });
    assert.equal(r.ok, true);
    assert.equal(r.degraded, true);
    assert.match(r.reason, /dispatch call failed/);
  });

  test('verified live is ok, not degraded', () => {
    const r = verifyDeployStage({ attempted: true, dispatched: true, verified: true });
    assert.equal(r.ok, true);
    assert.equal(r.degraded, undefined);
  });

  test('timed out waiting is ok but degraded (cron gate is the backstop) — not silent', () => {
    const r = verifyDeployStage({ attempted: true, dispatched: true, verified: false, timedOut: true });
    assert.equal(r.ok, true);
    assert.equal(r.degraded, true);
    assert.match(r.reason, /cron gate/);
  });

  test('dispatched but verification genuinely failed (not a timeout) is a hard failure', () => {
    const r = verifyDeployStage({
      attempted: true,
      dispatched: true,
      verified: false,
      timedOut: false,
      reason: 'Vercel API 500',
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /Vercel API 500/);
  });
});

describe('verifyPipeline — fail-fast aggregation', () => {
  test('all-ok stages produce an ok pipeline', () => {
    const v = verifyPipeline([
      verifyGatherStage({ failed: 0, total: 2 }),
      verifyCollectStage({ attempted: true, outcome: 'success' }),
    ]);
    assert.equal(v.ok, true);
    assert.equal(v.failed.length, 0);
  });

  test('one crashed stage fails the whole pipeline even if others are fine', () => {
    const v = verifyPipeline([
      verifyGatherStage({ failed: 0, total: 2 }),
      verifyCollectStage({ attempted: true, outcome: 'failure' }),
      verifyRebuildStage({ attempted: true, outcome: 'success' }),
    ]);
    assert.equal(v.ok, false);
    assert.equal(v.failed.length, 1);
    assert.match(v.failed[0].reason, /collect/);
  });

  test('degraded (partial/timeout) stages do not fail the pipeline but are reported', () => {
    const v = verifyPipeline([
      verifyScoreStage({ failed: 1, total: 2 }),
      verifyDeployStage({ attempted: true, dispatched: true, verified: false, timedOut: true }),
    ]);
    assert.equal(v.ok, true);
    assert.equal(v.degraded.length, 2);
  });

  test('empty/missing stage list is vacuously ok (no data this run)', () => {
    assert.equal(verifyPipeline([]).ok, true);
    assert.equal(verifyPipeline(undefined).ok, true);
  });
});

describe('buildStageResults — env-var contract used by the CLI wrapper', () => {
  test('a fully empty env defaults each stage to "attempted" — missing outcome reads as a crash, not a silent pass', () => {
    // Fail-safe default: if the workflow forgets to wire a stage's env vars,
    // that must surface as a verification failure, not a silently-ok skip.
    const v = verifyPipeline(buildStageResults({}));
    assert.equal(v.ok, false);
  });

  test('explicitly marking every stage unattempted verifies ok (a genuine no-op run)', () => {
    const v = verifyPipeline(
      buildStageResults({
        GATHER_FAILED: '0',
        GATHER_TOTAL: '0',
        COLLECT_ATTEMPTED: 'false',
        SCORE_FAILED: '0',
        SCORE_TOTAL: '0',
        REBUILD_ATTEMPTED: 'false',
        DEPLOY_ATTEMPTED: 'false',
      })
    );
    assert.equal(v.ok, true);
  });

  test('parses GH Actions-style env vars end to end and fails fast on a crashed stage', () => {
    const results = buildStageResults({
      GATHER_FAILED: '0',
      GATHER_TOTAL: '3',
      COLLECT_ATTEMPTED: 'true',
      COLLECT_OUTCOME: 'success',
      SCORE_FAILED: '0',
      SCORE_TOTAL: '3',
      REBUILD_ATTEMPTED: 'true',
      REBUILD_OUTCOME: 'failure',
      DEPLOY_ATTEMPTED: 'false',
    });
    const v = verifyPipeline(results);
    assert.equal(v.ok, false);
    assert.equal(v.failed.length, 1);
    assert.match(v.failed[0].reason, /rebuild/);
  });

  test('a fully healthy dispatched-and-verified deploy passes end to end', () => {
    const results = buildStageResults({
      GATHER_FAILED: '0',
      GATHER_TOTAL: '1',
      COLLECT_ATTEMPTED: 'true',
      COLLECT_OUTCOME: 'success',
      SCORE_FAILED: '0',
      SCORE_TOTAL: '1',
      REBUILD_ATTEMPTED: 'true',
      REBUILD_OUTCOME: 'success',
      DEPLOY_ATTEMPTED: 'true',
      DEPLOY_DISPATCHED: 'true',
      DEPLOY_VERIFIED: 'true',
    });
    assert.equal(verifyPipeline(results).ok, true);
  });
});
