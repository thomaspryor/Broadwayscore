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
const { execFileSync } = require('child_process');
const { sendAlert } = require('./lib/discord-notify');
const { decideEmailGateFunnelAlerts } = require('./lib/email-gate-funnel-rules');

const DRY_RUN = process.argv.includes('--dry-run');
// Test seam: EMAIL_GATE_FUNNEL_FIXTURE (summary.json instead of live PostHog)
// and EMAIL_GATE_FUNNEL_STATE_FILE (state path override) for lifecycle tests.
const FIXTURE_FILE = process.env.EMAIL_GATE_FUNNEL_FIXTURE || null;
const STATE_PATH = process.env.EMAIL_GATE_FUNNEL_STATE_FILE
  || path.join(__dirname, '..', 'data', 'audit', 'email-gate-funnel-monitor-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { return {}; }
}

function runAnalyzer() {
  const raw = execFileSync('node', [path.join(__dirname, 'analyze-email-gate-funnel.js'), '--json', '--days=7'], {
    encoding: 'utf8', timeout: 120000,
  }).trim();
  // --json prints exactly one JSON line last; tolerate stray warnings above it.
  const jsonLine = raw.split('\n').filter(l => l.trim().startsWith('{')).pop();
  if (!jsonLine) throw new Error(`analyze-email-gate-funnel.js --json produced no JSON (got: ${raw.slice(0, 200)})`);
  return JSON.parse(jsonLine);
}

async function main() {
  const summary = FIXTURE_FILE ? JSON.parse(fs.readFileSync(FIXTURE_FILE, 'utf8')) : runAnalyzer();
  const state = loadState();
  const { alerts, state: nextState } = decideEmailGateFunnelAlerts(summary, state, Date.now());
  nextState.lastRunAt = new Date().toISOString();
  nextState.lastSummary = summary;

  console.log(`Summary(7d): ${JSON.stringify(summary)}`);
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
