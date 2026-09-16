#!/usr/bin/env node
/**
 * check-review-count-drift-guard.js — BRO-2423 port of BRO-545/BRO-2424's
 * guard-escalation pattern to check-review-count-drift.yml's daily "Run
 * drift check" step.
 *
 * scripts/check-review-count-drift.js's default report mode never fails a job
 * (exit 0 even on a breach — it's already registered as a SOFT_WARN_GUARDS
 * entry in guard-escalation.js). But check-review-count-drift.yml's scheduled
 * (daily cron) run always passes --strict (see that step's own comment), so
 * on THIS caller a breach hard-exits 2, and a "cannot run" precondition
 * failure (missing review-texts/reviews.json checkout) hard-exits 1 — both
 * with no continue-on-error and an escalation (opening-night-broadcast.yml's
 * separate per-show gate aside) that only reaches severity: 'warning'
 * (Discord/digest, not real-time). A checkout that stays broken, or a
 * suppression breach that keeps recurring, fails this daily job loud forever
 * with nobody paged in real time until the next digest.
 *
 * Runs check-review-count-drift.js as a child process (spawnSync, same
 * pattern as check-corpus-drift.js) so the drift-detection logic itself stays
 * single-source — including its OWN callers (opening-night-broadcast.yml's
 * pre-broadcast per-show gate calls check-review-count-drift.js directly, NOT
 * through this guard; its exit(2) semantics there are untouched).
 *
 * Usage: node scripts/check-review-count-drift-guard.js <args...>
 *   (workflow passes --strict, optionally --show=ID)
 *
 * Exit codes: 0 on a clean/no-breach run OR an auto-recovered block (this
 * step must never hard-fail the job past the auto-recovery threshold);
 * check-review-count-drift.js's own exit code (1 "cannot run" or 2 "breach
 * under --strict") on a first-or-below-threshold block — fail loud,
 * unchanged pre-port behavior.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
// BRO-2423 (port of BRO-545/BRO-2424's guard-escalation pattern): a blocked
// drift check is right to fail this DAILY cron loud on its first occurrence,
// but the same block recurring run after run (a checkout that stays broken,
// or a suppression breach nobody has acted on) used to fail loud forever with
// no real-time escalation. See guard-escalation.js header for the shape this
// reuses.
const {
  nextGuardState,
  shouldAutoRecover,
  shouldEscalate,
  buildOverrideCommand,
  buildGuardBlockedAlert,
} = require('./lib/guard-escalation');

// Same state file check-rebuild-staleness.js / check-vercel-build-guard.js /
// check-corpus-drift.js / check-scoring-queue-guard.js use — keyed per-guard
// so multiple guards share one git-tracked file
// (data/audit/guard-escalation-state.json's merge driver,
// scripts/lib/merge-guard-escalation-state.js, already unions top-level keys
// across guards).
const GUARD_STATE_FILE = path.join(process.cwd(), 'data', 'audit', 'guard-escalation-state.json');
const GUARD_ID = 'review-count-drift-strict-breach';
const WORKFLOW_DISPLAY_NAME = 'Check Review-Count Drift';
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
    console.error(`::warning::[check-review-count-drift-guard] could not persist guard-escalation state: ${e.message}`);
  }
}

async function main() {
  const passthroughArgs = process.argv.slice(2);
  const scriptPath = path.join(__dirname, 'check-review-count-drift.js');
  // check-review-count-drift.js writes its audit JSON (and any --show-scoped
  // variant) BEFORE deciding whether to process.exit(2) on a strict breach —
  // inherited stdio streams the report live and guarantees the audit file
  // this run produced is already on disk before any auto-recovery decision
  // below, so the workflow's downstream "Check for changes"/commit step still
  // picks it up either way.
  const result = spawnSync(process.execPath, [scriptPath, ...passthroughArgs], { stdio: 'inherit' });

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
    reason: 'BRO-2423 review-count-drift strict guard manual override',
  });
  const baseMsg =
    `[check-review-count-drift-guard] check-review-count-drift.js exited ${result.status} — ` +
    `reviews.json is either stale, dropping opening-window reviews (a --strict breach), or the ` +
    `checkout could not be scanned at all. Override: ${overrideCommand}`;

  if (!shouldAutoRecover(GUARD_ID, state.consecutiveBlocks, { firstBlockedAt: state.firstBlockedAt, now: Date.now() })) {
    // First (or still-below-threshold) block: fail loud, unchanged from
    // before BRO-2423 — a one-off freshness/suppression breach is worth
    // flagging immediately.
    console.error(`::error::${baseMsg}`);
    process.exit(result.status || 1);
  }

  // BRO-2423 auto-recovery: this guard has now blocked state.consecutiveBlocks
  // runs in a row. The audit JSON (if the script got far enough to write one)
  // already reflects this run's findings, so proceeding just stops marking
  // this DAILY monitor red for a condition that keeps reproducing — it
  // degrades to a loud, escalating alert instead of stalling indefinitely.
  const alert = buildGuardBlockedAlert({
    guardId: GUARD_ID,
    guardLabel: 'Review-count drift strict-breach guard (check-review-count-drift.js)',
    consecutiveBlocks: state.consecutiveBlocks,
    workflowDisplayName: WORKFLOW_DISPLAY_NAME,
    overrideCommand,
    impact: 'reviews.json freshness/suppression breaches are no longer being caught in real time — opening-window reviews may be silently missing from the site',
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
  console.error(`::error::[check-review-count-drift-guard] unexpected failure: ${e.stack || e.message}`);
  process.exit(1);
});
