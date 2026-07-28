#!/usr/bin/env node
/**
 * dispatch-orphan-rescore-requeue.js — #356 self-heal for the orphan-unscored
 * broadcast gate.
 *
 * scripts/verify-all-scored.js writes data/audit/orphan-unscored-{showId}.json
 * when reviews with includable text land unscored, and dispatches a rescore
 * (llm-ensemble-score.yml) unless it's within its own 60-min per-show cooldown
 * (marker.lastDispatch === 'suppressed-cooldown'). Previously,
 * opening-night-broadcast.yml's orphan-unscored gate emailed the operator on
 * EVERY blocked run — broadcast retries every ~2.8h via workflow_run, so a
 * cooldown-suppressed dispatch meant repeated emails until an operator
 * manually ran `gh workflow run llm-ensemble-score.yml` (2026-07-23,
 * trainspotting-the-musical-west-end-2026, run 30054954304 — nothing had
 * auto-retried).
 *
 * This script is the self-heal: the broadcast gate calls it once per pending
 * show. It re-dispatches the rescore itself once the per-show cooldown has
 * elapsed (scripts/lib/orphan-rescore-requeue.js decides), capped at 2
 * auto-attempts per show per rolling 24h window; only past that cap does it
 * notify the operator, and only via owner-alert-router (never a raw email —
 * CLAUDE.md §17 / card #352).
 *
 * CLI: node scripts/dispatch-orphan-rescore-requeue.js --show=<showId>
 * Prints one JSON line to stdout; never throws — internal errors surface as
 * {"action":"error"} so the calling workflow treats them as "still blocked,
 * don't spam an alert" rather than crashing the broadcast job.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { decideRequeueAction } = require('./lib/orphan-rescore-requeue');
const { dispatchRescore } = require('./lib/dispatch-rescore');
const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');

const REPO_ROOT = path.resolve(__dirname, '..');
const AUDIT_DIR = path.join(REPO_ROOT, 'data', 'audit');
const STATE_FILE = path.join(AUDIT_DIR, 'orphan-rescore-requeue-state.json');

function markerPath(showId) {
  return path.join(AUDIT_DIR, `orphan-unscored-${showId}.json`);
}

function loadJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Distinguishes "no marker" (genuinely resolved/never broken — safe to clear
// and unblock) from "marker exists but is corrupt" (must fail CLOSED — a
// parse failure is not evidence the orphan is fixed, and treating it as
// 'clear' would silently let a broken broadcast through).
function loadMarker(showId) {
  const file = markerPath(showId);
  if (!fs.existsSync(file)) return { status: 'missing' };
  try {
    return { status: 'ok', data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { status: 'corrupt', error: err.message };
  }
}

function loadState() {
  const state = loadJSON(STATE_FILE, { version: 1, shows: {} });
  if (!state.shows) state.shows = {};
  return state;
}

function saveState(state) {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  state.updatedAt = new Date().toISOString();
  const tmp = `${STATE_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, STATE_FILE);
}

function conditionKeyFor(showId) {
  return `orphan-unscored-requeue:${showId}`;
}

async function run(showId) {
  const markerResult = loadMarker(showId);
  const state = loadState();

  if (markerResult.status === 'corrupt') {
    // Fail closed: a malformed marker is not evidence the orphan is fixed.
    // Keep blocking broadcast (the caller treats any non-'clear' action as
    // blocking) without touching attempt/alert state — a corrupt marker
    // means verify-all-scored.js's next real run will rewrite it, at which
    // point this resolves itself.
    return { showId, action: 'error', message: `corrupt marker: ${markerResult.error}` };
  }

  const marker = markerResult.status === 'ok' ? markerResult.data : null;

  if (!marker || !(marker.orphanCount > 0)) {
    // Resolved (or never broken) — clear local state so a future incident
    // starts with a fresh 2-attempt budget instead of inheriting stale
    // attempts, and resolve the alert-router ledger so a NEW incident on
    // this show notifies immediately rather than waiting out the old
    // condition's cooldown.
    let changed = false;
    if (state.shows[showId]) {
      delete state.shows[showId];
      changed = true;
    }
    if (resolveCondition(conditionKeyFor(showId))) changed = true;
    if (changed) saveState(state);
    return { showId, action: 'clear', orphanCount: 0 };
  }

  if (marker.lastDispatch === 'ok') {
    // verify-all-scored.js itself dispatched successfully this cycle —
    // rescore is already in flight, nothing for us to do.
    return { showId, action: 'in-flight', orphanCount: marker.orphanCount };
  }

  const now = new Date();
  const showState = state.shows[showId] || { attempts: [] };
  const decision = decideRequeueAction(showState.attempts, now);

  if (decision.action === 'wait') {
    return {
      showId,
      action: 'wait',
      orphanCount: marker.orphanCount,
      waitMs: decision.waitMs,
    };
  }

  if (decision.action === 'dispatch') {
    // Reason MUST match scripts/verify-all-scored.js's own dispatch reason
    // ('verify-all-scored') — dispatch-rescore.js keys the llm-ensemble-score.yml
    // concurrency group on `${reason}-${showId}`. A distinct reason here would
    // put this self-heal path in a different concurrency lane than
    // verify-all-scored.js's own dispatch for the SAME show, so a
    // suppressed-cooldown marker (which by definition means verify-all-scored
    // is ALSO about to retry the same show) could fire two concurrent
    // llm-ensemble-score.yml runs against the same review files — duplicate
    // paid LLM calls and a write race. Sharing the reason collapses both
    // dispatchers onto one per-show lane. Caught in ship-check review
    // (Claude + Codex both flagged independently).
    const result = await dispatchRescore(showId, { reason: 'verify-all-scored' });
    const attempts = decision.recentAttempts.concat([
      { at: now.toISOString(), ok: !!result.ok },
    ]);
    state.shows[showId] = { attempts, lastAttemptAt: now.toISOString() };
    saveState(state);
    return {
      showId,
      action: 'dispatch',
      orphanCount: marker.orphanCount,
      dispatchOk: result.ok,
      error: result.ok ? null : result.error,
    };
  }

  // decision.action === 'alert' — 2 auto-attempts already made in the last
  // 24h and the orphan is still present (either the dispatch itself kept
  // failing, or it succeeded but the rescore never cleared the marker).
  // Escalate through owner-alert-router so the operator is told once, not
  // every ~2.8h broadcast retry.
  const attemptsSummary =
    decision.recentAttempts
      .map((a) => `${a.at}: ${a.ok ? 'dispatched ok' : 'dispatch failed'}`)
      .join('\n') || '(none recorded)';
  const routed = await routeAlert({
    conditionKey: conditionKeyFor(showId),
    title: `Orphan-unscored rescore self-heal exhausted — ${showId}`,
    description:
      `${marker.orphanCount} review(s) for ${showId} have includable text but no score. ` +
      `2 automatic rescore attempts in the last 24h did not clear the marker — manual ` +
      `investigation needed.`,
    hint:
      `Run: gh workflow run llm-ensemble-score.yml -f show_id=${showId} -f fast_rebuild=true\n` +
      `Check data/audit/orphan-unscored-${showId}.json for the specific orphaned reviews, ` +
      `and the llm-ensemble-score.yml run logs for why the rescore isn't landing.`,
    severity: 'error',
    disposition: 'human',
    cooldownHours: 24,
    fields: [{ name: 'Attempts (last 24h)', value: attemptsSummary }],
  });
  return {
    showId,
    action: 'alert',
    orphanCount: marker.orphanCount,
    // Informational only — may be 'silent'|'human'|'digest' (the page-worthy
    // allowlist gate, card #611, can downgrade the 'human' request above).
    // Nothing branches on this field; it's surfaced for CLI/log visibility.
    alertRouted: routed.action,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const showId = (args.find((a) => a.startsWith('--show=')) || '').replace('--show=', '');
  if (!showId) {
    console.log(JSON.stringify({ action: 'error', message: '--show=<id> required' }));
    process.exit(0);
  }
  try {
    const result = await run(showId);
    console.log(JSON.stringify(result));
  } catch (err) {
    console.error(
      `[dispatch-orphan-rescore-requeue] ${showId}: ${err && err.stack ? err.stack : err}`,
    );
    console.log(
      JSON.stringify({
        showId,
        action: 'error',
        message: err && err.message ? err.message : String(err),
      }),
    );
  }
  process.exit(0);
}

module.exports = { run };

if (require.main === module) {
  main();
}
