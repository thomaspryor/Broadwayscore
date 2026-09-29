#!/usr/bin/env node
/**
 * email-traffic-report.js — send the traffic-source report to the owner.
 *
 * Usage:
 *   node scripts/email-traffic-report.js --report=traffic-analysis/traffic-sources-report.md \
 *     [--summary=traffic-analysis/traffic-sources-summary.md] [--run-url=https://github.com/...] \
 *     [--metrics=traffic-analysis/traffic-metrics.json] [--dashboard-url=https://…/admin/traffic] \
 *     [--to=someone@example.com] [--dry-run] [--html-out=preview.html]
 *   The summary (human-language body) and the metrics (tiles + charts) default
 *   to the files next to the report and are used when they exist; the full
 *   report is always attached. --html-out writes the rendered HTML (with the
 *   charts inlined as data: URIs) for a local look before a send.
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
  const metricsPath = typeof args.metrics === 'string' ? args.metrics : path.join(path.dirname(reportPath), 'traffic-metrics.json');
  const res = await sendTrafficReportEmail({
    reportPath,
    summaryPath: fs.existsSync(summaryPath) ? summaryPath : undefined,
    metricsPath: fs.existsSync(metricsPath) ? metricsPath : undefined,
    dashboardUrl: typeof args['dashboard-url'] === 'string' ? args['dashboard-url'] : undefined,
    runUrl: args['run-url'],
    to: typeof args.to === 'string' ? args.to : undefined,
    dryRun: Boolean(args['dry-run']),
  });
  if (res.sent) { console.log(`[email] sent "${res.subject}" to ${res.to}`); return; }
  if (res.reason === 'dry-run') {
    if (typeof args['html-out'] === 'string') {
      let html = res.html;
      for (const a of res.attachments || []) html = html.split(`cid:${a.content_id}`).join(`data:image/png;base64,${a.content}`);
      fs.writeFileSync(args['html-out'], `<!doctype html><meta charset="utf-8"><title>${res.subject}</title><body style="background:#fff;margin:24px;">${html}</body>`);
      console.log(`[email] preview written to ${args['html-out']}`);
    }
    return;
  }
  console.error(`[email] NOT sent: ${res.reason}`);
  process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
