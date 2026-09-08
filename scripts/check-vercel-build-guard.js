#!/usr/bin/env node
/**
 * check-vercel-build-guard.js — self-healing check that Vercel's git-triggered
 * builds stay blocked (the project's `commandForIgnoringBuildStep` must stay
 * `exit 0`; 39,176 accidental builds cost $3,500 in Feb 2026 before this
 * existed). Runs every 30 minutes.
 *
 * The common case already self-heals: setting drifts → PATCH restores it →
 * job stays green. BRO-2424 ports BRO-545's guard-escalation.js pattern
 * (see its header) to the ONE path that genuinely blocks: the setting
 * drifted AND the auto-restore PATCH itself also failed (revoked token,
 * Vercel API outage, project renamed). That path used to fail loud every 30
 * minutes forever — its notify-failure call carried no `severity` override,
 * defaulting to 'low', a no-op for anything but 'critical' (see
 * .github/actions/notify-failure). Now: fail loud on the first occurrence,
 * auto-recover (exit 0) with an escalating owner-alert-router digest entry
 * after 2 consecutive occurrences.
 *
 * Previously pure inline bash in vercel-build-guard.yml — moved to a script
 * so it can require() guard-escalation.js like every other ported guard.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const {
  nextGuardState,
  shouldAutoRecover,
  shouldEscalate,
  buildOverrideCommand,
  buildGuardBlockedAlert,
} = require('./lib/guard-escalation');

const USAGE = `Usage: node scripts/check-vercel-build-guard.js

Verifies the Vercel project's commandForIgnoringBuildStep setting is
'exit 0' (git-triggered builds stay blocked); auto-restores it via PATCH if
it drifted. Requires VERCEL_TOKEN. See file header for the guard-escalation
auto-recovery behavior on repeated restore failures.`;

const PROJECT_ID = 'prj_wmBnDUrCQCwabIAYPbnMiIP3wg15';
const EXPECTED_SETTING = 'exit 0';
// Shared with check-rebuild-staleness.js and check-corpus-drift.js — each
// guard only ever writes its OWN top-level GUARD_ID key, and a write only
// happens when that key's state actually changes (not every run), so a
// same-file push race across guards would need two DIFFERENT guards' states
// to change inside the same push-with-retry.sh rebase window — narrow, and
// not registered in core-data-merge-registry.js's per-key reconciliation
// (that machinery is opt-in, whole-module infra disproportionate to this
// guard's low-frequency writes). Accepted per /second-opinion review
// (BRO-2424): the concurrency group below removes the far likelier same-
// workflow overlap; a lost cross-guard write just means one guard fails
// loud once more before re-escalating, not silent data loss.
const GUARD_STATE_FILE = path.join(process.cwd(), 'data', 'audit', 'guard-escalation-state.json');
const GUARD_ID = 'vercel-build-guard-restore-failed';
const WORKFLOW_DISPLAY_NAME = 'Vercel Build Guard';
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
    console.error(`::warning::[check-vercel-build-guard] could not persist guard-escalation state: ${e.message}`);
  }
}

// Clear an open streak (self-heal, or the setting was never wrong this run).
// Skips the write entirely when there is nothing to clear — this guard runs
// every 30 min, and unconditionally writing/committing on every clean run
// would churn the repo forever for no reason.
function clearStreakIfOpen() {
  const priorState = loadGuardState();
  if (!priorState || priorState.consecutiveBlocks <= 0) return;
  try {
    const { resolveCondition } = require('./lib/owner-alert-router');
    resolveCondition(ALERT_CONDITION_KEY);
  } catch (e) { /* best-effort — a missing router/ledger never blocks a healthy run */ }
  saveGuardState(nextGuardState(priorState, false, Date.now()));
}

// A real Vercel outage (or a WAF/edge error page) can return a non-2xx,
// non-JSON body — res.json() throwing there must NOT escape uncaught, or it
// bypasses guard-escalation entirely (no state save, no digest alert) and
// this reverts to exactly the "fails loud forever, no real escalation"
// behavior BRO-2424 exists to fix. Treat a malformed/errored response the
// same as an explicit bad-setting value — the caller's normal drift/restore
// logic (and the guard-escalation streak it feeds) already handles that.
// 15s cap so a hung connection can't eat the job's 5-min timeout before the
// always()-gated commit step gets a chance to run (Codex adversarial review).
const FETCH_TIMEOUT_MS = 15000;

async function fetchSetting(token) {
  try {
    const res = await fetch(`https://api.vercel.com/v9/projects/${PROJECT_ID}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    // A non-2xx response (401 revoked token, 429, 5xx) can still return a
    // JSON body — don't let an error-shaped payload that happens to omit
    // commandForIgnoringBuildStep read as a real 'NOT SET' setting without
    // the response status showing up in the log (Codex adversarial review).
    if (!res.ok) {
      console.error(`::warning::[check-vercel-build-guard] GET returned HTTP ${res.status} — treating as NOT SET`);
      return 'NOT SET';
    }
    const data = await res.json();
    return data.commandForIgnoringBuildStep || 'NOT SET';
  } catch (e) {
    console.error(`::warning::[check-vercel-build-guard] GET failed (${e.message}) — treating as NOT SET`);
    return 'NOT SET';
  }
}

async function restoreSetting(token) {
  try {
    const res = await fetch(`https://api.vercel.com/v9/projects/${PROJECT_ID}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commandForIgnoringBuildStep: EXPECTED_SETTING }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`::warning::[check-vercel-build-guard] PATCH returned HTTP ${res.status} — treating as FAILED`);
      return 'FAILED';
    }
    const data = await res.json();
    return data.commandForIgnoringBuildStep || 'FAILED';
  } catch (e) {
    console.error(`::warning::[check-vercel-build-guard] PATCH failed (${e.message}) — treating as FAILED`);
    return 'FAILED';
  }
}

// Shared by every way this guard can end up blocked (restore-PATCH failure,
// missing token) — a missing VERCEL_TOKEN is itself a "guard cannot confirm
// builds are blocked" condition, not a config error to just exit(1) on
// forever with no escalation (Codex adversarial review: that path bypassed
// guard-escalation entirely, reintroducing the exact "fails loud forever, no
// real escalation" bug this port exists to fix).
async function handleBlocked(baseMsg, impact) {
  const priorState = loadGuardState();
  const state = nextGuardState(priorState, true, Date.now());
  saveGuardState(state);

  const overrideCommand = buildOverrideCommand({
    workflowDisplayName: WORKFLOW_DISPLAY_NAME,
    reason: 'BRO-2424 vercel-build-guard restore-failure manual override',
  });
  const fullMsg = `${baseMsg} Override: ${overrideCommand}`;

  if (!shouldAutoRecover(GUARD_ID, state.consecutiveBlocks)) {
    // First (or still-below-threshold) failure: fail loud, unchanged from
    // before BRO-2424 — a one-off failure is worth flagging immediately.
    console.error(`::error::${fullMsg}`);
    process.exit(1);
  }

  // BRO-2424 auto-recovery: this condition has now fired state.consecutiveBlocks
  // runs in a row (>= 1 hour at this workflow's 30-min cadence). Failing loud
  // every 30 min forever just adds noise once the owner has been told once —
  // degrade to a loud, escalating alert instead of blocking the job (and
  // every job depending on it staying green) indefinitely.
  const alert = buildGuardBlockedAlert({
    guardId: GUARD_ID,
    guardLabel: 'Vercel build-guard restore failure (check-vercel-build-guard.js)',
    consecutiveBlocks: state.consecutiveBlocks,
    workflowDisplayName: WORKFLOW_DISPLAY_NAME,
    overrideCommand,
    impact,
    runUrl: process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : undefined,
  });
  console.error(`::warning::${fullMsg}`);
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
      // Lower severity than BRO-545's reviews.json-stalled case: an
      // unblocked build guard risks unwanted Vercel spend, not data loss —
      // 'digest', not 'human' (no page).
      await routeAlert({
        conditionKey: ALERT_CONDITION_KEY,
        title: alert.title,
        description: alert.description,
        disposition: 'digest',
        cooldownHours: 1,
      });
    } catch (e) {
      console.error(`::warning::[guard-escalation] routeAlert failed (${e.message}) — escalation was logged above regardless.`);
    }
  }
  // Auto-recovered: exit 0 so the job stays green — the condition is
  // already visible via the warnings/summary/digest alert above.
}

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); return; }
  const token = process.env.VERCEL_TOKEN;
  if (!token) {
    await handleBlocked(
      '[check-vercel-build-guard] VERCEL_TOKEN not set — cannot verify or restore the build-guard setting.',
      'the guard cannot verify whether git-triggered Vercel builds are blocked at all — VERCEL_TOKEN needs to be re-added as a repo secret',
    );
    return;
  }

  const setting = await fetchSetting(token);
  console.log(`Current setting: '${setting}'`);

  if (setting === EXPECTED_SETTING) {
    console.log('Build guard is active. All good.');
    clearStreakIfOpen();
    return;
  }

  console.error(`::error::Build guard is NOT 'exit 0' — it is '${setting}'. Restoring now...`);
  const verified = await restoreSetting(token);
  console.log(`After fix: '${verified}'`);

  if (verified === EXPECTED_SETTING) {
    console.error('::warning::Build guard was missing and has been restored. Check Vercel billing for unwanted builds.');
    // Self-healed — not the double-failure gap this port targets.
    clearStreakIfOpen();
    return;
  }

  // Auto-restore itself failed — the genuine double-failure gap.
  await handleBlocked(
    `[check-vercel-build-guard] setting drifted to '${setting}' AND the auto-restore PATCH failed ` +
      `(verify returned '${verified}') — manual intervention required.`,
    `the ignore-build-step setting is still '${setting}' (not 'exit 0') — git-triggered Vercel builds are NOT blocked and may bill unexpectedly`,
  );
}

main().catch((e) => {
  console.error(`::error::[check-vercel-build-guard] unexpected failure: ${e.stack || e.message}`);
  process.exit(1);
});
