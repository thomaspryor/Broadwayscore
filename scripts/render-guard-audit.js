#!/usr/bin/env node
/**
 * BRO-3011: print the spend-guard audit as the HTML section of the weekly
 * scraper cost report. Read-only: writes nothing and never routes alerts (no
 * owner-alert-router in its require graph) — the daily data-health-check run
 * of scripts/guard-audit.js owns the snapshot and the alerts.
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(`render-guard-audit.js — print the spend-guard audit as HTML for the weekly cost report (BRO-3011)

  node scripts/render-guard-audit.js     HTML section on stdout; no writes, no alerts`);
  process.exit(0);
}

const { runGuardAuditFromFiles } = require('./lib/guard-audit-io');
const { renderGuardAuditHtml } = require('./lib/guard-audit-core');

console.log(renderGuardAuditHtml(runGuardAuditFromFiles()));
