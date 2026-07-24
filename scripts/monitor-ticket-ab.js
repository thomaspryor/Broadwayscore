#!/usr/bin/env node
/**
 * monitor-ticket-ab.js — weekly automated monitor for the revenue-bearing
 * ticket-single-button A/B (card #392). The two gate experiments
 * (monitor-gate-cold-start.js, monitor-email-gate-funnel.js) already had
 * weekly monitors; this one did not, and the analyzer's own zTest() printed
 * "p-value: NaN" on every run for a week before a manual audit caught it
 * (2026-07-24, fixed in scripts/lib/significance.js).
 *
 * Runs analyze-ab-test.js --json --days 14 (single window — Impact's
 * Actions API caps StartDate/EndDate at 45 days apart, and the pure decision
 * function only needs the latest primary read, not a cumulative one), applies
 * the pure decision rules (scripts/lib/ticket-ab-monitor-rules.js), sends
 * actionable-only alerts, persists state.
 *
 * This monitor NEVER judges the primary metric's winner and NEVER touches
 * flag rollout — those stay owner decisions
 * (memory/feedback_ab_test_guardrails.md rule 1), same as the other two
 * weekly gate monitors.
 *
 * State: data/audit/ticket-ab-monitor-state.json (committed by workflow).
 * Usage: node scripts/monitor-ticket-ab.js [--dry-run]
 * Env: POSTHOG_PERSONAL_API_KEY, POSTHOG_PROJECT_ID, IMPACT_ACCOUNT_SID,
 *      IMPACT_AUTH_TOKEN (analyzer), RESEND_API_KEY + OWNER_EMAIL (email alerts).
 */

const fs = require('fs');
const path = require('path');
const { runWeeklyMonitor, runAnalyzerJson } = require('./lib/weekly-monitor-runner');
const { decideTicketAbAlerts } = require('./lib/ticket-ab-monitor-rules');

const DRY_RUN = process.argv.includes('--dry-run');
// Test seam: TICKET_AB_FIXTURE (summary.json instead of live PostHog/Impact)
// and TICKET_AB_STATE_FILE (state path override) for lifecycle tests.
const FIXTURE_FILE = process.env.TICKET_AB_FIXTURE || null;
const STATE_PATH = process.env.TICKET_AB_STATE_FILE
  || path.join(__dirname, '..', 'data', 'audit', 'ticket-ab-monitor-state.json');
const ANALYZER = path.join(__dirname, 'analyze-ab-test.js');

function loadData() {
  return FIXTURE_FILE
    ? JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'))
    : runAnalyzerJson(ANALYZER, ['--days', '14']);
}

runWeeklyMonitor({
  loadData,
  decideFn: decideTicketAbAlerts,
  statePath: STATE_PATH,
  dryRun: DRY_RUN,
  logData: (summary) => console.log(`Summary(14d): ${JSON.stringify(summary)}`),
}).catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
