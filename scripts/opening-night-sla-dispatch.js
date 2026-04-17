#!/usr/bin/env node
'use strict';

/**
 * Opening Night SLA Dispatch
 *
 * Glue script: reads checklist output + stage-latency log, evaluates SLA,
 * dispatches Discord/email alerts for breaches, and posts a checklist summary
 * if any show has errors.
 *
 * Usage:
 *   node scripts/opening-night-sla-dispatch.js <checklist.json> [latency-report.json]
 *
 * The second arg is optional (informational only).
 * Reads raw JSONL from STAGE_LATENCY_LOG env var or default path.
 * Exits 0 always (non-blocking CI step).
 */

const fs = require('fs');
const path = require('path');

const { evaluateSlaForReviews, dispatchSlaAlerts } = require('./lib/opening-night-sla');
const { sendAlert } = require('./lib/discord-notify');

const DEFAULT_LOG = path.join(__dirname, '../data/audit/stage-latency.jsonl');

function readJSONL(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => { try { return JSON.parse(l); } catch (_) { return null; } })
    .filter(Boolean);
}

async function main() {
  const checklistPath = process.argv[2];
  // process.argv[3] is latency report path — informational, not used for SLA eval

  if (!checklistPath) {
    process.stderr.write('[sla-dispatch] Usage: opening-night-sla-dispatch.js <checklist.json>\n');
    process.exit(0);
  }

  // --- Read checklist output ---
  let checklistData = null;
  try {
    checklistData = JSON.parse(fs.readFileSync(checklistPath, 'utf8'));
  } catch (e) {
    process.stderr.write(`[sla-dispatch] Could not read checklist JSON: ${e.message}\n`);
  }

  // --- Read raw stage-latency JSONL ---
  const logFile = process.env.STAGE_LATENCY_LOG || DEFAULT_LOG;
  const entries = readJSONL(logFile);

  // --- Evaluate SLA ---
  let slaResult = { warnings: [], pages: [] };
  try {
    slaResult = evaluateSlaForReviews(entries);
  } catch (e) {
    process.stderr.write(`[sla-dispatch] SLA evaluation error: ${e.message}\n`);
  }

  // --- Dispatch SLA alerts ---
  const dryRun = process.env.SLA_DRY_RUN === 'true';
  try {
    await dispatchSlaAlerts(slaResult, { dryRun });
  } catch (e) {
    process.stderr.write(`[sla-dispatch] dispatchSlaAlerts error: ${e.message}\n`);
  }

  // --- Post checklist error summary ---
  if (checklistData && checklistData.shows && !dryRun) {
    const errorShows = (checklistData.shows || []).filter(s => s.summary && (s.summary.errors || 0) > 0);
    if (errorShows.length > 0) {
      const list = errorShows.map(s => {
        const title = s.show ? s.show.title || s.show.id : '?';
        const { errors, warnings } = s.summary;
        const failedChecks = (s.results || [])
          .filter(r => r.severity === 'error')
          .map(r => r.name)
          .join(', ');
        return `• **${title}** — ${errors} error(s), ${warnings} warning(s)${failedChecks ? `\n  Failed: ${failedChecks}` : ''}`;
      }).join('\n');

      try {
        await sendAlert({
          title: `Opening Night Checklist — ${errorShows.length} show(s) with errors`,
          description: `Checklist ran at ${checklistData.generatedAt || new Date().toISOString()}\n\n${list}`,
          severity: 'warning',
        });
      } catch (e) {
        process.stderr.write(`[sla-dispatch] checklist alert dispatch error: ${e.message}\n`);
      }
    }
  } else if (checklistData && dryRun) {
    const errorShows = (checklistData.shows || []).filter(s => s.summary && (s.summary.errors || 0) > 0);
    if (errorShows.length > 0) {
      console.log(`[sla-dispatch dry-run] ${errorShows.length} show(s) with checklist errors`);
    } else {
      console.log('[sla-dispatch dry-run] All shows pass checklist');
    }
  }

  // Summary log
  console.log(`[sla-dispatch] SLA: ${slaResult.warnings.length} warning(s), ${slaResult.pages.length} page(s). Entries: ${entries.length}`);
}

main().catch(e => {
  process.stderr.write(`[sla-dispatch] fatal: ${e.message}\n`);
  // Exit 0 — non-blocking
  process.exit(0);
});
