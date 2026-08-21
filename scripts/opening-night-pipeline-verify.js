#!/usr/bin/env node
'use strict';

/**
 * CLI wrapper around scripts/lib/opening-night-pipeline-stages.js — called
 * as the last step of the fast_path job in
 * .github/workflows/opening-night-poller.yml. Reads each stage's outcome
 * from env vars set by earlier steps (GH Actions `steps.<id>.outcome` /
 * `steps.<id>.outputs.*`), verifies every stage, prints a summary (also to
 * $GITHUB_STEP_SUMMARY when present), and exits 1 if any stage crashed —
 * that non-zero exit is what makes the job conclusion `failure` and fires
 * the existing notify-failure step, instead of the crash disappearing
 * behind the per-stage `continue-on-error: true`.
 *
 * Env contract (all optional; a stage defaults to "nothing attempted"):
 *   GATHER_FAILED, GATHER_TOTAL
 *   COLLECT_ATTEMPTED, COLLECT_OUTCOME
 *   SCORE_FAILED, SCORE_TOTAL
 *   REBUILD_ATTEMPTED, REBUILD_OUTCOME
 *   DEPLOY_ATTEMPTED, DEPLOY_DISPATCHED, DEPLOY_VERIFIED, DEPLOY_TIMED_OUT, DEPLOY_REASON
 */

const fs = require('fs');
const {
  verifyGatherStage,
  verifyCollectStage,
  verifyScoreStage,
  verifyRebuildStage,
  verifyDeployStage,
  verifyPipeline,
} = require('./lib/opening-night-pipeline-stages');

const bool = (v) => v === 'true' || v === '1';
const int = (v) => (v === undefined || v === '' ? 0 : parseInt(v, 10) || 0);

function buildStageResults(env) {
  return [
    verifyGatherStage({ failed: int(env.GATHER_FAILED), total: int(env.GATHER_TOTAL) }),
    verifyCollectStage({
      attempted: env.COLLECT_ATTEMPTED === undefined ? true : bool(env.COLLECT_ATTEMPTED),
      outcome: env.COLLECT_OUTCOME,
    }),
    verifyScoreStage({ failed: int(env.SCORE_FAILED), total: int(env.SCORE_TOTAL) }),
    verifyRebuildStage({
      attempted: env.REBUILD_ATTEMPTED === undefined ? true : bool(env.REBUILD_ATTEMPTED),
      outcome: env.REBUILD_OUTCOME,
    }),
    verifyDeployStage({
      attempted: env.DEPLOY_ATTEMPTED === undefined ? true : bool(env.DEPLOY_ATTEMPTED),
      dispatched: bool(env.DEPLOY_DISPATCHED),
      verified: bool(env.DEPLOY_VERIFIED),
      timedOut: bool(env.DEPLOY_TIMED_OUT),
      reason: env.DEPLOY_REASON,
    }),
  ];
}

function main() {
  const stageResults = buildStageResults(process.env);
  const verdict = verifyPipeline(stageResults);

  const lines = ['## Opening night pipeline — stage verification', ''];
  for (const r of stageResults) {
    const icon = r.ok ? (r.degraded ? '⚠️' : '✅') : '❌';
    lines.push(`- ${icon} ${r.reason}`);
  }
  lines.push('');
  lines.push(verdict.ok ? '**Result: all stages verified.**' : `**Result: ${verdict.failed.length} stage(s) crashed.**`);

  const text = lines.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${text}\n`);
    } catch (e) {
      console.error(`::warning::Could not write GITHUB_STEP_SUMMARY: ${e.message}`);
    }
  }

  if (!verdict.ok) {
    for (const f of verdict.failed) {
      console.error(`::error::${f.reason}`);
    }
    process.exit(1);
  }
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { buildStageResults };
