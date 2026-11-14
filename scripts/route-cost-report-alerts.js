#!/usr/bin/env node
/**
 * route-cost-report-alerts.js — files the weekly Scraper Cost Report's red
 * "Action needed" lines as worker cards and writes the email's Action-needed
 * list (BRO-6391).
 *
 * The owner used to get "check logs" / "investigate spike" and had to start a
 * session by hand. Each red line (scripts/lib/cost-report-alerts.js) is now a
 * routeAlert() 'auto' condition filed dispatch-at-filing: Todo at High with no
 * PARKED line, so the Mac red-first pass or the cloud board worker
 * (cloud-worker-pick.js) takes it without the owner. Clear conditions are
 * resolved, which is what the card's default VERIFY
 * (check-alert-condition-absent.js) reads.
 *
 * Input: env vars set by scraper-cost-report.yml's report step
 *   COST_TOTAL_FAILED COST_TOTAL_CANCELLED COST_FAILED_BY_WF ("file:N,...")
 *   COST_BB_COST COST_BB_SESSIONS COST_SB_PROJECTED COST_SB_CAP COST_SB_STATUS
 *   COST_SB_CREDITS_TOTAL COST_API_DEGRADED COST_RUNS_QUERY_FAILED COST_RUN_URL
 *
 * Usage: node scripts/route-cost-report-alerts.js --html-out=FILE [--dry-run]
 *   --dry-run  evaluate and write the HTML, file and resolve nothing
 *
 * Exit: 0 ok · 2 usage · 3 a red line has no card (dispatch failed). The HTML
 * is written before exiting 3, so the email still goes out and says so.
 */
'use strict';

const fs = require('fs');
const { hasHelpFlag } = require('./lib/cli-help');
const { evaluateCostReport, parseFailedByWorkflow } = require('./lib/cost-report-alerts.js');

const LINEAR_ISSUE_URL = 'https://linear.app/broadway-scorecard/issue/';
const COLORS = { red: '#dc2626', amber: '#f59e0b' };

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/** PURE. One <li> per line; a red line names its card or says filing failed. */
function renderActionHtml(lines, cards, { dryRun = false } = {}) {
  return lines.map((l) => {
    let tail = '';
    if (l.level === 'red') {
      const id = cards[l.conditionKey];
      if (id) tail = `. A worker session is on it: <a href="${LINEAR_ISSUE_URL}${escapeHtml(id)}">${escapeHtml(id)}</a>`;
      else if (dryRun) tail = ' (dry run: no card filed)';
      else tail = '. Could not file a worker card this run (see the workflow log)';
    }
    return `<li style='color:${COLORS[l.level]}'>${escapeHtml(l.text)}${tail}</li>`;
  }).join('');
}

function metricsFromEnv(env) {
  return {
    totalFailed: env.COST_TOTAL_FAILED,
    totalCancelled: env.COST_TOTAL_CANCELLED,
    failedByWorkflow: parseFailedByWorkflow(env.COST_FAILED_BY_WF),
    bbCost: env.COST_BB_COST,
    bbSessions: env.COST_BB_SESSIONS,
    sbProjected: env.COST_SB_PROJECTED,
    sbCap: env.COST_SB_CAP,
    sbStatus: env.COST_SB_STATUS,
    sbCreditsTotal: env.COST_SB_CREDITS_TOTAL,
    apiDegraded: env.COST_API_DEGRADED,
    runsQueryFailed: env.COST_RUNS_QUERY_FAILED,
    runUrl: env.COST_RUN_URL,
  };
}

/**
 * Route the red lines. Injectable `router` ({ routeAlert, resolveCondition })
 * so the unit test drives the real result contract (audit-dependencies.js
 * runAlerts pattern): routeAlert resolves { action, dispatchOk,
 * linearIdentifier } and does not throw on a dispatch failure.
 *
 * cooldownHours 24: the report runs every 168h, the router's default
 * cooldown. Inside the cooldown a re-fire is 'silent' with the ledger's old
 * card and never checks Linear, so a card a worker already closed would be
 * named again and never refiled. 24h lets every weekly run reach the router's
 * open-duplicate check instead.
 *
 * @returns {Promise<{ cards: Record<string,string>, failed: boolean }>}
 */
async function routeLines({ lines, resolvableKeys, router, runContext = {}, log = console.log }) {
  const { routeAlert, resolveCondition } = router;
  const cards = {};
  let failed = false;
  const dispatchAtFiling = runContext.runId ? { runId: runContext.runId, runUrl: runContext.runUrl || null } : true;
  for (const l of lines) {
    if (!l.card) continue;
    try {
      const r = await routeAlert({
        conditionKey: l.conditionKey,
        ...l.card,
        severity: 'error',
        disposition: 'auto',
        cardAction: 'Investigate',
        cooldownHours: 24,
        dispatchAtFiling,
      });
      if (r && r.linearIdentifier && r.dispatchOk !== false) cards[l.conditionKey] = r.linearIdentifier;
      else failed = true;
      log(`[cost-alerts] ${l.conditionKey}: ${r && r.action} ${(r && r.linearIdentifier) || '(no card)'}`);
    } catch (err) {
      failed = true;
      log(`[cost-alerts] routeAlert threw for ${l.conditionKey}: ${err.message}`);
    }
  }
  for (const key of resolvableKeys) {
    try {
      if (resolveCondition(key, { reason: 'clear in this week\'s cost report' })) log(`[cost-alerts] resolved ${key}`);
    } catch (err) {
      log(`[cost-alerts] resolveCondition threw for ${key}: ${err.message}`);
    }
  }
  return { cards, failed };
}

const USAGE = 'usage: node scripts/route-cost-report-alerts.js --html-out=FILE [--dry-run]';

async function main(argv = process.argv.slice(2), env = process.env) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const htmlArg = argv.find((a) => a.startsWith('--html-out='));
  if (!htmlArg) {
    console.error(USAGE);
    return 2;
  }
  const htmlOut = htmlArg.slice('--html-out='.length);
  const dryRun = argv.includes('--dry-run');

  const { lines, resolvableKeys } = evaluateCostReport(metricsFromEnv(env));
  let cards = {};
  let failed = false;
  try {
    if (dryRun) {
      for (const l of lines) if (l.card) console.log(`[cost-alerts] dry-run: would file ${l.conditionKey}: ${l.card.title}`);
      console.log(`[cost-alerts] dry-run: would resolve ${resolvableKeys.join(', ') || 'nothing'}`);
    } else {
      ({ cards, failed } = await routeLines({
        lines,
        resolvableKeys,
        router: require('./lib/owner-alert-router.js'),
        runContext: { runId: env.GITHUB_RUN_ID, runUrl: env.COST_RUN_URL },
      }));
    }
  } catch (err) {
    failed = true;
    console.error(`[cost-alerts] routing crashed: ${err.stack || err.message}`);
  } finally {
    // Always written: the email step reads it, and a lost report is worse
    // than one that says its cards could not be filed.
    fs.writeFileSync(htmlOut, renderActionHtml(lines, cards, { dryRun }));
  }
  if (failed) {
    console.error('::error::a red cost-report line has no worker card (check LINEAR_API_KEY); the email says so');
    return 3;
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(3); });
}

module.exports = { renderActionHtml, metricsFromEnv, routeLines, main };
