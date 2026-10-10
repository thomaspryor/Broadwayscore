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
  // Scope to the shows in tonight's checklist — the shows we're actively
  // shepherding. This is the guard against the 2026-07-24 false-page storm:
  // without a scope, the SLA counted CI test fixtures + historical backfills
  // (which never emit a per-review deploy stamp) as "stuck", growing 15→29.
  //
  // FAIL CLOSED on any scoping failure. The old fallback (null → lib excludes
  // only test-fixture prefixes) meant "checklist unparseable" silently became
  // "page on the entire corpus": a stray stderr line merged into checklist.json
  // made JSON.parse throw on EVERY real CI run from the day the scope shipped,
  // so the 2026-08-02 P0 paged the owner about shows opening in March/May/
  // September. For paging purposes an unreadable checklist is the same as an
  // empty night — a missed page on a genuinely live opening night is recovered
  // by the next hourly run once the checklist heals, whereas an unscoped page
  // is guaranteed false noise. Warnings still go to the run log.
  let activeShowIds = [];
  if (checklistData && Array.isArray(checklistData.shows)) {
    const ids = checklistData.shows
      .map(s => (s.show && (s.show.id || s.show.showId)) || s.showId || s.id)
      .filter(Boolean);
    if (checklistData.shows.length > 0 && ids.length === 0) {
      process.stderr.write(`[sla-dispatch] WARNING: checklist has ${checklistData.shows.length} show(s) but 0 extractable IDs — schema drift; failing CLOSED (no SLA scope tonight)\n`);
    } else {
      activeShowIds = ids;
    }
  } else {
    process.stderr.write('[sla-dispatch] WARNING: checklist JSON missing/unparseable — failing CLOSED (no SLA scope tonight). Fix the checklist output before expecting SLA pages.\n');
  }

  let slaResult = { warnings: [], pages: [] };
  try {
    slaResult = evaluateSlaForReviews(entries, { activeShowIds });
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
