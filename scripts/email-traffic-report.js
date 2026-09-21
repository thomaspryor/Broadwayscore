#!/usr/bin/env node
/**
 * email-traffic-report.js — send the traffic-source report to the owner.
 *
 * Usage:
 *   node scripts/email-traffic-report.js --report=traffic-analysis/traffic-sources-report.md \
 *     [--summary=traffic-analysis/traffic-sources-summary.md] [--run-url=https://github.com/...] \
 *     [--to=someone@example.com] [--dry-run]
 *   The summary (human-language body) defaults to the file next to the report
 *   and is used when it exists; the full report is always attached.
 *
 * Exits 1 if the send fails so the workflow step goes red (the report is the
 * whole point of the run — a silent non-delivery would defeat it).
 */
const fs = require('fs');
const path = require('path');
require('./lib/load-env').loadEnv();
const { sendTrafficReportEmail } = require('./lib/traffic-report-email');

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.slice(2).split('='); return [k, v ?? true];
  }));
  const reportPath = args.report || 'traffic-analysis/traffic-sources-report.md';
  const summaryPath = typeof args.summary === 'string' ? args.summary : path.join(path.dirname(reportPath), 'traffic-sources-summary.md');
  const res = await sendTrafficReportEmail({
    reportPath,
    summaryPath: fs.existsSync(summaryPath) ? summaryPath : undefined,
    runUrl: args['run-url'],
    to: typeof args.to === 'string' ? args.to : undefined,
    dryRun: Boolean(args['dry-run']),
  });
  if (res.sent) { console.log(`[email] sent "${res.subject}" to ${res.to}`); return; }
  if (res.reason === 'dry-run') return;
  console.error(`[email] NOT sent: ${res.reason}`);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
