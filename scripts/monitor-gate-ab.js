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
const STATE_PATH = path.join(__dirname, '..', 'data', 'audit', 'gate-ab-monitor-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}

async function main() {
  const raw = execFileSync('node', [path.join(__dirname, 'analyze-gate-ab.js'), '--json', '--days=7'], {
    encoding: 'utf8', timeout: 120000,
  }).trim();
  // --json prints exactly one JSON line last; tolerate stray warnings above it.
  const jsonLine = raw.split('\n').filter(l => l.trim().startsWith('{')).pop();
  if (!jsonLine) throw new Error(`analyze-gate-ab.js --json produced no JSON (got: ${raw.slice(0, 200)})`);
  const summary = JSON.parse(jsonLine);

  const state = loadState();
  const { alerts, state: nextState } = decideGateAlerts(summary, state, Date.now());
  nextState.lastRunAt = new Date().toISOString();
  nextState.lastSummary = summary;

  console.log(`Summary: ${JSON.stringify(summary)}`);
  console.log(`Decisions: ${alerts.map(a => a.kind).join(', ') || 'none'}`);

  for (const a of alerts) {
    if (DRY_RUN) { console.log(`[dry-run] would send ${a.kind}: ${a.title}`); continue; }
    await sendAlert({ title: a.title, description: a.description, severity: a.severity, email: a.email });
    console.log(`sent ${a.kind} (${a.severity}${a.email ? ', email' : ''})`);
  }

  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2) + '\n');
    console.log(`State saved: ${STATE_PATH}`);
  }
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(1); });
