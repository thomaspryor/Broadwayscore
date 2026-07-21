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

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { sendAlert } = require('./lib/discord-notify');
const { decideGateColdStartAlerts } = require('./lib/gate-cold-start-rules');

const DRY_RUN = process.argv.includes('--dry-run');
// Test seam: GATE_COLD_START_FIXTURE_DIR (recent.json + cumulative.json instead
// of live PostHog) and GATE_COLD_START_STATE_FILE (state path override).
const FIXTURE_DIR = process.env.GATE_COLD_START_FIXTURE_DIR || null;
const STATE_PATH = process.env.GATE_COLD_START_STATE_FILE
  || path.join(__dirname, '..', 'data', 'audit', 'gate-cold-start-monitor-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}

function runAnalyzer(days) {
  const raw = execFileSync('node', [path.join(__dirname, 'analyze-gate-cold-start.js'), '--json', `--days=${days}`], {
    encoding: 'utf8', timeout: 120000,
  }).trim();
  // --json prints exactly one JSON line last; tolerate stray warnings above it.
  const jsonLine = raw.split('\n').filter(l => l.trim().startsWith('{')).pop();
  if (!jsonLine) throw new Error(`analyze-gate-cold-start.js --json produced no JSON (got: ${raw.slice(0, 200)})`);
  return JSON.parse(jsonLine);
}

async function main() {
  // Two windows, same pattern as monitor-gate-ab.js: RECENT (7d) for the
  // captures/week + impression-split guardrails; CUMULATIVE (180d — plenty
  // above the 28-day primary-readiness floor, clipped to EXPERIMENT_START by
  // the analyzer's own greatest(now()-DAYS, start) window) for the ITT
  // readout and elapsed-runtime check.
  const windows = FIXTURE_DIR
    ? {
        recent: JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'recent.json'), 'utf8')),
        cumulative: JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'cumulative.json'), 'utf8')),
      }
    : { recent: runAnalyzer(7), cumulative: runAnalyzer(180) };

  const state = loadState();
  const { alerts, state: nextState } = decideGateColdStartAlerts(windows, state, Date.now());
  nextState.lastRunAt = new Date().toISOString();
  nextState.lastSummary = { recent: windows.recent, cumulative: windows.cumulative };

  console.log(`Recent(7d): ${JSON.stringify(windows.recent)}`);
  console.log(`Cumulative(180d): ${JSON.stringify(windows.cumulative)}`);
  console.log(`Decisions: ${alerts.map(a => a.kind).join(', ') || 'none'}`);

  for (const a of alerts) {
    if (DRY_RUN) { console.log(`[dry-run] would send ${a.kind}: ${a.title}`); continue; }
    if (a.logOnly) { console.log(`[log-only] ${a.kind}: ${a.description}`); continue; }
    const delivered = await sendAlert({ title: a.title, description: a.description, severity: a.severity, email: a.email });
    if (a.email && !delivered && a.stampKey) {
      // Delivery failed (Resend down / env missing): revert the sent-stamp so
      // this alert RETRIES next week instead of being silently lost.
      delete nextState[a.stampKey];
      console.log(`delivery FAILED for ${a.kind} — stamp ${a.stampKey} reverted, will retry next run`);
    } else {
      console.log(`sent ${a.kind} (${a.severity}${a.email ? ', email' : ''})`);
    }
  }

  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2) + '\n');
    console.log(`State saved: ${STATE_PATH}`);
  }
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
