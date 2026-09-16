#!/usr/bin/env node
/**
 * check-scoring-queue-guard.js — BRO-2423 port of BRO-545/BRO-2424's
 * guard-escalation pattern to llm-ensemble-score.yml's daily "Check if
 * scoring needed" gate.
 *
 * scripts/count-scoring-queue.js exits 1 when it can't trust its corpus scan
 * (missing/unreadable shows.json under --require-shows, a scan crash, or
 * fewer than --min-scanned files found — a half-checked-out review-texts
 * tree). The workflow step running that command has no continue-on-error, so
 * a stuck checkout fails the ENTIRE daily LLM-scoring pipeline job — the same
 * pre-BRO-545 shape check-rebuild-staleness.js used to have, blocking new
 * reviews from ever getting scored for as long as the checkout stays broken.
 *
 * Runs count-scoring-queue.js as a child process (spawnSync, same pattern as
 * check-corpus-drift.js) so the scan logic itself stays single-source. On a
 * clean run, mirrors its stdout/stderr verbatim — the workflow's existing
 * `read_count()` grep-based cascade parses this script's output exactly as it
 * parsed count-scoring-queue.js's directly, unchanged.
 *
 * On auto-recovery (2nd+ consecutive scan failure, past the 24h floor), this
 * prints the SAME unscored=/rescore=/stale=/emergency= contract with every
 * count at 0 — never fabricating real queue depth from a scan that couldn't
 * run — so the workflow's existing cascade naturally falls through to
 * skip=true (a safe no-op this run) instead of the job failing outright.
 *
 * Usage: node scripts/check-scoring-queue-guard.js <args...>
 *   (workflow passes --github-output --require-shows --min-scanned=10000,
 *   forwarded verbatim to count-scoring-queue.js)
 *
 * Exit codes: 0 on a clean scan OR an auto-recovered failure (this step must
 * never hard-fail the job past the auto-recovery threshold); non-zero
 * (count-scoring-queue.js's own exit code) on a first-or-below-threshold scan
 * failure — fail loud, unchanged pre-port behavior.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
// BRO-2423 (port of BRO-545/BRO-2424's guard-escalation pattern): a crashed
// scan is right to fail this DAILY cron loud on its first occurrence, but the
// same crash recurring run after run (e.g. a checkout that stays broken)
// stalls scoring for every day it takes a human to notice a red job. See
// guard-escalation.js header for the shape this reuses.
const {
  nextGuardState,
  shouldAutoRecover,
  shouldEscalate,
  buildOverrideCommand,
  buildGuardBlockedAlert,
} = require('./lib/guard-escalation');

// Same state file check-rebuild-staleness.js / check-vercel-build-guard.js /
// check-corpus-drift.js use — keyed per-guard so multiple guards share one
// git-tracked file (data/audit/guard-escalation-state.json's merge driver,
// scripts/lib/merge-guard-escalation-state.js, already unions top-level keys
// across guards).
const GUARD_STATE_FILE = path.join(process.cwd(), 'data', 'audit', 'guard-escalation-state.json');
const GUARD_ID = 'scoring-queue-scan-failed';
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
    console.error(`::warning::[check-scoring-queue-guard] could not persist guard-escalation state: ${e.message}`);
  }
}

async function main() {
  const passthroughArgs = process.argv.slice(2);
  const scriptPath = path.join(__dirname, 'count-scoring-queue.js');
  const result = spawnSync(process.execPath, [scriptPath, ...passthroughArgs], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });

  // Mirror stdout/stderr so the human-readable report + KEY=value lines the
  // workflow's cascade greps for still appear exactly as before.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

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
    reason: 'BRO-2423 scoring-queue-scan guard manual override',
  });
  const baseMsg =
    `[check-scoring-queue-guard] count-scoring-queue.js exited ${result.status} — cannot trust ` +
    `the corpus scan (broken review-texts checkout, missing shows.json, or a partial scan). ` +
    `Override: ${overrideCommand}`;

  if (!shouldAutoRecover(GUARD_ID, state.consecutiveBlocks, { firstBlockedAt: state.firstBlockedAt, now: Date.now() })) {
    // First (or still-below-threshold) scan failure: fail loud, unchanged
    // from before BRO-2423 — a one-off broken checkout is worth flagging
    // immediately.
    console.error(`::error::${baseMsg}`);
    process.exit(result.status || 1);
  }

  // BRO-2423 auto-recovery: this scan has now failed state.consecutiveBlocks
  // runs in a row. Never fabricate real queue depth from a scan that
  // couldn't run — report the same zero-count contract count-scoring-queue.js
  // itself emits on an empty queue, so the workflow's existing cascade
  // naturally treats this run as a safe no-op (skip=true) instead of the job
  // failing outright and stalling every phase behind it indefinitely.
  console.log('unscored=0');
  console.log('rescore=0');
  console.log('stale=0');
  console.log('emergency=0');

  const alert = buildGuardBlockedAlert({
    guardId: GUARD_ID,
    guardLabel: 'Scoring-queue scan guard (count-scoring-queue.js)',
    consecutiveBlocks: state.consecutiveBlocks,
    workflowDisplayName: WORKFLOW_DISPLAY_NAME,
    overrideCommand,
    impact: 'new reviews have stopped being scored — the daily LLM-scoring cascade cannot see its own queue depth',
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
  console.error(`::error::[check-scoring-queue-guard] unexpected failure: ${e.stack || e.message}`);
  process.exit(1);
});
