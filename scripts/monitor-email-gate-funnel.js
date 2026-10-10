#!/usr/bin/env node
/**
 * monitor-email-gate-funnel.js — weekly automated monitor for the OVERALL
 * email-gate conversion funnel (card #240 — previously only the dead
 * mobile-gate-timing A/B had a monitor; nothing watched the funnel itself).
 *
 * Runs analyze-email-gate-funnel.js --json (7d, real users, modal-only —
 * trigger != '' excludes inline header/footer email_captured events),
 * applies the pure decision rule (scripts/lib/email-gate-funnel-rules.js),
 * sends an actionable-only alert on absolute capture collapse, persists state.
 *
 * PRIMARY guardrail is ABSOLUTE captures/week, not conversion rate — the
 * cold-start gate (2+ pages/session, live 2026-07-20 16:37 UTC) cuts
 * impressions ~85-90% and lifts rate ~5-8x by selection; a rate-only
 * threshold would declare victory while list growth actually falls.
 * Full analysis: ~/Documents/claude-outputs/email-gate-analysis-2026-07-20.md
 *
 * This monitor never touches gate config, cooldowns, or flag rollout —
 * alerts only, decisions stay with the owner.
 *
 * State: data/audit/email-gate-funnel-monitor-state.json (committed by workflow).
 * Usage: node scripts/monitor-email-gate-funnel.js [--dry-run]
 * Env: POSTHOG_PERSONAL_API_KEY, RESEND_API_KEY + OWNER_EMAIL (email alerts).
 */

const fs = require('fs');
const path = require('path');
const { runWeeklyMonitor, runAnalyzerJson } = require('./lib/weekly-monitor-runner');
const { decideEmailGateFunnelAlerts } = require('./lib/email-gate-funnel-rules');

const DRY_RUN = process.argv.includes('--dry-run');
// Test seam: EMAIL_GATE_FUNNEL_FIXTURE (summary.json instead of live PostHog)
// and EMAIL_GATE_FUNNEL_STATE_FILE (state path override) for lifecycle tests.
const FIXTURE_FILE = process.env.EMAIL_GATE_FUNNEL_FIXTURE || null;
const STATE_PATH = process.env.EMAIL_GATE_FUNNEL_STATE_FILE
  || path.join(__dirname, '..', 'data', 'audit', 'email-gate-funnel-monitor-state.json');
const ANALYZER = path.join(__dirname, 'analyze-email-gate-funnel.js');

function loadData() {
  return FIXTURE_FILE
    ? JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8'))
    : runAnalyzerJson(ANALYZER, ['--days=7']);
}

runWeeklyMonitor({
  loadData,
  decideFn: decideEmailGateFunnelAlerts,
  statePath: STATE_PATH,
  dryRun: DRY_RUN,
  logData: (summary) => console.log(`Summary(7d): ${JSON.stringify(summary)}`),
}).catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
