#!/usr/bin/env node
/**
 * Weekly cumulative related-shows-position result monitor. Alerts only.
 * Usage: node scripts/monitor-related-shows-ab.js [--dry-run]
 * Env: POSTHOG_PERSONAL_API_KEY, RESEND_API_KEY, OWNER_EMAIL
 * State: data/audit/related-shows-ab-monitor-state.json
 * RELATED_SHOWS_AB_FIXTURE / RELATED_SHOWS_AB_STATE_FILE override input / state
 * for offline dry runs. Dry runs never send alerts or save state.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { runWeeklyMonitor, runAnalyzerJson } = require('./lib/weekly-monitor-runner');
const { decideRelatedShowsAlerts } = require('./lib/related-shows-ab-monitor-rules');

runWeeklyMonitor({
  loadData: () => process.env.RELATED_SHOWS_AB_FIXTURE
    ? JSON.parse(fs.readFileSync(process.env.RELATED_SHOWS_AB_FIXTURE, 'utf8'))
    : runAnalyzerJson(path.join(__dirname, 'analyze-related-shows-ab.js'), []),
  decideFn: decideRelatedShowsAlerts,
  statePath: process.env.RELATED_SHOWS_AB_STATE_FILE
    || path.join(__dirname, '..', 'data', 'audit', 'related-shows-ab-monitor-state.json'),
  dryRun: process.argv.includes('--dry-run'),
  logData: summary => console.log(`Summary(cumulative): ${JSON.stringify(summary)}`),
}).catch(err => { console.error('Fatal:', err.message); process.exitCode = 1; });
