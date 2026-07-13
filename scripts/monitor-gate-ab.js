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

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { sendAlert } = require('./lib/discord-notify');
const { decideGateAlerts } = require('./lib/gate-ab-monitor-rules');

const DRY_RUN = process.argv.includes('--dry-run');
// Test seams: GATE_AB_FIXTURE_DIR (recent.json + cumulative.json instead of live
// PostHog) and GATE_AB_STATE_FILE (state path override) — used by the lifecycle
// integration test so the REAL runner is exercised without network or real state.
const FIXTURE_DIR = process.env.GATE_AB_FIXTURE_DIR || null;
const STATE_PATH = process.env.GATE_AB_STATE_FILE
  || path.join(__dirname, '..', 'data', 'audit', 'gate-ab-monitor-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}

function runAnalyzer(days) {
  const raw = execFileSync('node', [path.join(__dirname, 'analyze-gate-ab.js'), '--json', `--days=${days}`], {
    encoding: 'utf8', timeout: 120000,
  }).trim();
  // --json prints exactly one JSON line last; tolerate stray warnings above it.
  const jsonLine = raw.split('\n').filter(l => l.trim().startsWith('{')).pop();
  if (!jsonLine) throw new Error(`analyze-gate-ab.js --json produced no JSON (got: ${raw.slice(0, 200)})`);
  return JSON.parse(jsonLine);
}

async function main() {
  // Two windows: RECENT (7d) for the bounce guardrail; CUMULATIVE (70d — covers
  // the 8-week horizon) for power/duration/skew arm counts. Comparing a 7-day
  // window against the cumulative 950 floor was a unit-mismatch bug that made
  // power-reached unfireable (caught 2026-07-13).
  const windows = FIXTURE_DIR
    ? {
        recent: JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'recent.json'), 'utf8')),
        cumulative: JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'cumulative.json'), 'utf8')),
      }
    : { recent: runAnalyzer(7), cumulative: runAnalyzer(70) };

  const state = loadState();
  const { alerts, state: nextState } = decideGateAlerts(windows, state, Date.now());
  nextState.lastRunAt = new Date().toISOString();
  nextState.lastSummary = { recent: windows.recent, cumulative: windows.cumulative };

  console.log(`Recent(7d): ${JSON.stringify(windows.recent)}`);
  console.log(`Cumulative(70d): ${JSON.stringify(windows.cumulative)}`);
  console.log(`Decisions: ${alerts.map(a => a.kind).join(', ') || 'none'}`);

  for (const a of alerts) {
    if (DRY_RUN) { console.log(`[dry-run] would send ${a.kind}: ${a.title}`); continue; }
    if (a.logOnly) { console.log(`[log-only] ${a.kind}: ${a.description}`); continue; }
    const delivered = await sendAlert({ title: a.title, description: a.description, severity: a.severity, email: a.email });
    if (a.email && !delivered && a.stampKey) {
      // Delivery failed (Resend down / env missing): revert the sent-stamp so
      // this alert RETRIES next week instead of being silently lost — a missed
      // power-reached email would otherwise never be re-sent.
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
