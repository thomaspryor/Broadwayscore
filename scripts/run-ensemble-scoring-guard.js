#!/usr/bin/env node
/**
 * run-ensemble-scoring-guard.js — BRO-2423 port of BRO-545/BRO-2424's
 * guard-escalation pattern to llm-ensemble-score.yml's "Run ensemble scoring
 * pipeline" step.
 *
 * scripts/llm-scoring/index.ts is the daily scoring cascade's actual worker —
 * a crash there (any non-zero exit: an API outage, a malformed review file
 * the scorer doesn't defend against, a budget-cap abort) hard-fails the
 * workflow step with no continue-on-error, and that step's "Notify on
 * failure" call carries no `severity:` override, defaulting to 'low' — a
 * no-op for anything but 'critical' (see .github/actions/notify-failure). A
 * scorer that keeps crashing therefore stalls the ENTIRE daily LLM-scoring
 * pipeline for as long as it takes a human to notice a red job in the
 * Actions tab.
 *
 * Runs scripts/llm-scoring/index.ts as a child process with inherited stdio
 * (same live-streamed shape the workflow used to get directly — this run can
 * take many minutes across a batch, so buffering it would hide progress) so
 * the scoring logic itself stays single-source.
 *
 * Usage: node scripts/run-ensemble-scoring-guard.js <args...>
 *   (workflow passes ${{ steps.build-args.outputs.args }} verbatim)
 *
 * Exit codes: 0 on a clean run OR an auto-recovered crash (this step must
 * never hard-fail the job past the auto-recovery threshold); index.ts's own
 * exit code on a first-or-below-threshold crash — fail loud, unchanged
 * pre-port behavior.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
// BRO-2423 (port of BRO-545/BRO-2424's guard-escalation pattern): a crashed
// scoring run is right to fail this DAILY cron loud on its first occurrence,
// but the same crash recurring run after run stalls the whole daily scoring
// cascade — new reviews never get scored — for every day it takes a human to
// notice. See guard-escalation.js header for the shape this reuses.
const {
  nextGuardState,
  shouldAutoRecover,
  shouldEscalate,
  buildOverrideCommand,
  buildGuardBlockedAlert,
} = require('./lib/guard-escalation');

const USAGE = `Usage: node scripts/run-ensemble-scoring-guard.js <args...>

Guard-escalation wrapper around scripts/llm-scoring/index.ts (see this
file's header). Forwards <args...> verbatim; run
'npx ts-node scripts/llm-scoring/index.ts --help' for its own flags.`;

// Same state file check-rebuild-staleness.js / check-vercel-build-guard.js /
// check-corpus-drift.js / check-scoring-queue-guard.js use — keyed per-guard
// so multiple guards share one git-tracked file
// (data/audit/guard-escalation-state.json's merge driver,
// scripts/lib/merge-guard-escalation-state.js, already unions top-level keys
// across guards).
const GUARD_STATE_FILE = path.join(process.cwd(), 'data', 'audit', 'guard-escalation-state.json');
const GUARD_ID = 'ensemble-scoring-pipeline-crashed';
const WORKFLOW_DISPLAY_NAME = 'LLM Ensemble Score Reviews';
const ALERT_CONDITION_KEY = `guard-escalation:${GUARD_ID}`;

function loadJSON(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadGuardState() {
  const doc = loadJSON(GUARD_STATE_FILE, {});
  return (doc && doc[GUARD_ID]) || null;
}

function saveGuardState(state) {
  const doc = loadJSON(GUARD_STATE_FILE, {});
  doc[GUARD_ID] = state;
  try {
    fs.mkdirSync(path.dirname(GUARD_STATE_FILE), { recursive: true });
    fs.writeFileSync(GUARD_STATE_FILE, JSON.stringify(doc, null, 2) + '\n');
  } catch (e) {
    console.error(`::warning::[run-ensemble-scoring-guard] could not persist guard-escalation state: ${e.message}`);
  }
}

async function main() {
  const scoringArgs = process.argv.slice(2);
  if (hasHelpFlag(scoringArgs)) { console.log(USAGE); return; }
  const result = spawnSync(
    'npx',
    ['ts-node', '--project', 'scripts/tsconfig.json', 'scripts/llm-scoring/index.ts', ...scoringArgs],
    { stdio: 'inherit' },
  );

  if (result.status === 0) {
    const priorState = loadGuardState();
    if (priorState && priorState.consecutiveBlocks > 0) {
      try {
        const { resolveCondition } = require('./lib/owner-alert-router');
        resolveCondition(ALERT_CONDITION_KEY);
      } catch (e) { /* best-effort — a missing router/ledger never blocks a healthy run */ }
      saveGuardState(nextGuardState(priorState, false, Date.now()));
    }
    return;
  }

  const priorState = loadGuardState();
  const state = nextGuardState(priorState, true, Date.now());
  saveGuardState(state);

  const overrideCommand = buildOverrideCommand({
    workflowDisplayName: WORKFLOW_DISPLAY_NAME,
    reason: 'BRO-2423 ensemble-scoring-pipeline guard manual override',
  });
  const baseMsg =
    `[run-ensemble-scoring-guard] scripts/llm-scoring/index.ts exited ${result.status} — the ` +
    `ensemble scoring pipeline crashed. Override: ${overrideCommand}`;

  if (!shouldAutoRecover(GUARD_ID, state.consecutiveBlocks, { firstBlockedAt: state.firstBlockedAt, now: Date.now() })) {
    // First (or still-below-threshold) crash: fail loud, unchanged from
    // before BRO-2423 — a one-off scoring crash is worth flagging
    // immediately.
    console.error(`::error::${baseMsg}`);
    process.exit(result.status || 1);
  }

  // BRO-2423 auto-recovery: this pipeline has now crashed state.consecutiveBlocks
  // runs in a row. Whatever the scorer managed to write to review-text files
  // before crashing is already on disk (index.ts saves per-review, not in one
  // final batch write) — proceeding just stops marking this DAILY job red for
  // a condition that keeps reproducing, so downstream steps (commit, push,
  // rebuild dispatch) still run against whatever partial progress exists
  // instead of the whole run being discarded.
  const alert = buildGuardBlockedAlert({
    guardId: GUARD_ID,
    guardLabel: 'Ensemble scoring pipeline crash guard (scripts/llm-scoring/index.ts)',
    consecutiveBlocks: state.consecutiveBlocks,
    workflowDisplayName: WORKFLOW_DISPLAY_NAME,
    overrideCommand,
    impact: 'new reviews have stopped being scored — the ensemble scoring pipeline itself is crashing',
    runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined,
  });
  console.error(`::warning::${baseMsg}`);
  console.error(`::warning::[guard-escalation] AUTO-RECOVERING — ${alert.description.replace(/\n/g, ' | ')}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `\n## ⚠️ Guard auto-recovery — ${alert.title}\n\n${alert.description.replace(/\n/g, '\n\n')}\n`,
      );
    } catch (e) { /* summary write is best-effort */ }
  }

  if (shouldEscalate(state.consecutiveBlocks)) {
    try {
      const { routeAlert } = require('./lib/owner-alert-router');
      await routeAlert({
        conditionKey: ALERT_CONDITION_KEY,
        title: alert.title,
        description: alert.description,
        disposition: 'human',
        cooldownHours: 1,
      });
    } catch (e) {
      console.error(`::warning::[guard-escalation] routeAlert failed (${e.message}) — escalation was logged above regardless.`);
    }
  }
  // Auto-recovered: exit 0 so this step (and the job) stays green — the
  // condition is already visible via the warnings/summary/alert above.
}

main().catch((e) => {
  console.error(`::error::[run-ensemble-scoring-guard] unexpected failure: ${e.stack || e.message}`);
  process.exit(1);
});
