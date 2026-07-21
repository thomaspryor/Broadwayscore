#!/usr/bin/env node
/**
 * monitor-gate-ab.js — weekly automated monitor for the mobile-gate-timing A/B.
 *
 * Runs analyze-gate-ab.js --json, applies the pure decision rules
 * (scripts/lib/gate-ab-monitor-rules.js), sends alerts, persists state.
 *
 * Proactive owner notifications (email, actionable-only policy):
 *   - experiment went live · power floor reached (time to judge) ·
 *     8-week checkpoint · guardrail breaches (bounce / dismissal skew)
 * Weekly guardrail summary goes to Discord only.
 *
 * This monitor NEVER judges the primary metric and NEVER touches flag
 * rollout — those are user decisions (A/B guardrails memory).
 *
 * State: data/audit/gate-ab-monitor-state.json (committed by the workflow).
 * Usage: node scripts/monitor-gate-ab.js [--dry-run]
 * Env: POSTHOG_PERSONAL_API_KEY (analyzer), DISCORD_WEBHOOK_ALERTS,
 *      RESEND_API_KEY + OWNER_EMAIL (email alerts).
 */

const path = require('path');
const { runWeeklyMonitor, loadWindows } = require('./lib/weekly-monitor-runner');
const { decideGateAlerts } = require('./lib/gate-ab-monitor-rules');

const DRY_RUN = process.argv.includes('--dry-run');
// Test seams: GATE_AB_FIXTURE_DIR (recent.json + cumulative.json instead of live
// PostHog) and GATE_AB_STATE_FILE (state path override) — used by the lifecycle
// integration test so the REAL runner is exercised without network or real state.
const FIXTURE_DIR = process.env.GATE_AB_FIXTURE_DIR || null;
const STATE_PATH = process.env.GATE_AB_STATE_FILE
  || path.join(__dirname, '..', 'data', 'audit', 'gate-ab-monitor-state.json');
const ANALYZER = path.join(__dirname, 'analyze-gate-ab.js');

// Two windows: RECENT (7d) for the bounce guardrail; CUMULATIVE (70d — covers
// the 8-week horizon) for power/duration/skew arm counts. Comparing a 7-day
// window against the cumulative 950 floor was a unit-mismatch bug that made
// power-reached unfireable (caught 2026-07-13).
function loadData() {
  return loadWindows({ fixtureDir: FIXTURE_DIR, analyzerPath: ANALYZER, recentDays: 7, cumulativeDays: 70 });
}

function logData({ recent, cumulative }) {
  console.log(`Recent(7d): ${JSON.stringify(recent)}`);
  console.log(`Cumulative(70d): ${JSON.stringify(cumulative)}`);
}

runWeeklyMonitor({
  loadData,
  decideFn: decideGateAlerts,
  statePath: STATE_PATH,
  dryRun: DRY_RUN,
  logData,
}).catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
