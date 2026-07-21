#!/usr/bin/env node
/**
 * monitor-gate-cold-start.js — weekly automated monitor for the gate-cold-start
 * A/B (card #247 — analyze-gate-cold-start.js landed 2026-07-21 with full ITT
 * analysis + flag-health checks but no cron/alert wiring, same gap #240 closed
 * for the overall funnel).
 *
 * Runs analyze-gate-cold-start.js --json twice (RECENT 7d for guardrails,
 * CUMULATIVE 180d — clipped to the experiment start by the analyzer's own
 * window logic — for the 4-week primary-readiness milestone), applies the
 * pure decision rules (scripts/lib/gate-cold-start-rules.js), sends
 * actionable-only alerts, persists state.
 *
 * This monitor NEVER judges the primary metric and NEVER touches flag
 * rollout — those stay owner decisions, same as monitor-gate-ab.js and
 * monitor-email-gate-funnel.js.
 *
 * State: data/audit/gate-cold-start-monitor-state.json (committed by workflow).
 * Usage: node scripts/monitor-gate-cold-start.js [--dry-run]
 * Env: POSTHOG_PERSONAL_API_KEY (analyzer), RESEND_API_KEY + OWNER_EMAIL (email alerts).
 */

const path = require('path');
const { runWeeklyMonitor, loadWindows } = require('./lib/weekly-monitor-runner');
const { decideGateColdStartAlerts } = require('./lib/gate-cold-start-rules');

const DRY_RUN = process.argv.includes('--dry-run');
// Test seam: GATE_COLD_START_FIXTURE_DIR (recent.json + cumulative.json instead
// of live PostHog) and GATE_COLD_START_STATE_FILE (state path override).
const FIXTURE_DIR = process.env.GATE_COLD_START_FIXTURE_DIR || null;
const STATE_PATH = process.env.GATE_COLD_START_STATE_FILE
  || path.join(__dirname, '..', 'data', 'audit', 'gate-cold-start-monitor-state.json');
const ANALYZER = path.join(__dirname, 'analyze-gate-cold-start.js');

// Two windows, same pattern as monitor-gate-ab.js: RECENT (7d) for the
// captures/week + impression-split guardrails; CUMULATIVE (180d — plenty
// above the 28-day primary-readiness floor, clipped to EXPERIMENT_START by
// the analyzer's own greatest(now()-DAYS, start) window) for the ITT
// readout and elapsed-runtime check.
function loadData() {
  return loadWindows({ fixtureDir: FIXTURE_DIR, analyzerPath: ANALYZER, recentDays: 7, cumulativeDays: 180 });
}

function logData({ recent, cumulative }) {
  console.log(`Recent(7d): ${JSON.stringify(recent)}`);
  console.log(`Cumulative(180d): ${JSON.stringify(cumulative)}`);
}

runWeeklyMonitor({
  loadData,
  decideFn: decideGateColdStartAlerts,
  statePath: STATE_PATH,
  dryRun: DRY_RUN,
  logData,
}).catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
