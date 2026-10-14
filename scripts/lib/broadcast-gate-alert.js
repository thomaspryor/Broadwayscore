'use strict';

/**
 * Owner alert for a blocked opening-night broadcast gate (checklist_gate and
 * drift_gate in .github/workflows/opening-night-broadcast.yml).
 *
 * BRO-2816: both gates used to process.exit(1) after alerting, which failed the
 * step and silently skipped every later step lacking always() (the BRO-2815
 * overdue pager was one casualty). They now follow orphan_gate's pattern: once
 * the owner is informed, write `blocked=true` as a step output and exit 0; the
 * "Create broadcast draft" step checks that output instead.
 *
 * Exit 1 is kept for ONE case: the alert could not be confirmed delivered
 * (routeAlert threw, or a 'human' page was not delivered). The failed step is
 * what lets the job's generic "Notify on failure" fallback email the owner, so
 * a real block never goes unreported (codex adversarial review 2026-07-23).
 *
 * CLI (from the workflow):
 *   BREACHED_LIST=a,b node scripts/lib/broadcast-gate-alert.js <checklist|drift>
 */

const fs = require('fs');

const GATES = {
  checklist: {
    title: 'Opening Night Broadcast Blocked — Checklist Errors',
    description: 'Automated broadcast halted: opening night checklist found errors for pending shows.\nCheck /tmp/checklist-*.json or re-run with force_broadcast=true to override.',
  },
  drift: {
    title: 'Opening Night Broadcast Blocked — Review-Count Drift',
    description: 'Automated broadcast halted: scored in-window reviews are missing from data/reviews.json for one or more pending shows (or reviews.json is stale).\nCheck data/audit/review-count-drift-{show}.json or re-run with force_broadcast=true to override.',
  },
};

/**
 * 'silent' (already alerted within the 24h cooldown) and 'digest' (the
 * page-worthy gate, card #611, downgraded it; the owner sees it next morning)
 * both count as informed, as does a delivered 'human' page.
 */
function isOwnerInformed(result) {
  if (!result) return false;
  return result.action === 'silent' || result.action === 'digest'
    || (result.action === 'human' && !!result.delivered);
}

/**
 * Routes the blocked-gate alert and returns { informed, action }.
 * The conditionKey uses the caller's breached list as given; the workflow
 * sorts it so the same set always collapses to one key.
 */
async function alertGateBlocked(gate, breachedList, { routeAlertFn } = {}) {
  const cfg = GATES[gate];
  if (!cfg) throw new Error(`unknown broadcast gate "${gate}" (expected ${Object.keys(GATES).join('|')})`);
  const routeAlert = routeAlertFn || require('./owner-alert-router').routeAlert;
  const list = breachedList || 'unknown';
  const result = await routeAlert({
    conditionKey: `broadcast-gate:${gate}:${list}`,
    title: cfg.title,
    description: cfg.description,
    severity: 'error',
    disposition: 'human',
    cooldownHours: 24,
    fields: [{ name: 'Shows', value: breachedList || '(unknown)' }],
  });
  // A page-worthy downgrade to 'digest' counts as informed (see isOwnerInformed).
  return { informed: isOwnerInformed(result), action: result && result.action };
}

/**
 * Full CLI behavior, injectable for tests: writes the step output and returns
 * the exit code (0 = informed and blocked, 1 = delivery unconfirmed).
 */
async function runGateAlert(gate, breachedList, { routeAlertFn, outputFile, log = console } = {}) {
  let informed = false;
  try {
    ({ informed } = await alertGateBlocked(gate, breachedList, { routeAlertFn }));
  } catch (e) {
    log.error(`::warning::${gate} gate alert threw: ${e && e.message}`);
  }
  if (informed) {
    if (outputFile) fs.appendFileSync(outputFile, 'blocked=true\n');
    return 0;
  }
  log.error('::warning::Alert delivery unconfirmed — failing the step so the generic fallback notifier emails the owner');
  if (outputFile) fs.appendFileSync(outputFile, 'blocked=false\n');
  return 1;
}

module.exports = { GATES, isOwnerInformed, alertGateBlocked, runGateAlert };

if (require.main === module) {
  runGateAlert(process.argv[2], process.env.BREACHED_LIST, { outputFile: process.env.GITHUB_OUTPUT })
    .then((code) => { process.exitCode = code; });
}
