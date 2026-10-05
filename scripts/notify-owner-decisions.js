#!/usr/bin/env node
/**
 * notify-owner-decisions.js — emails the owner when a Linear card newly needs
 * their decision (BRO-4719). Runs daily in CI (data-health-check.yml) so it
 * works while the Mac is off. See scripts/lib/owner-decision-notify.js for
 * what counts as a decision and why.
 *
 *   node scripts/notify-owner-decisions.js --dry-run   list what would be sent, write nothing
 *   node scripts/notify-owner-decisions.js             send (when anything is new) and record
 *
 * The "already told" set lives on the router ledger condition
 * 'owner-decisions:new' (data/audit/alert-ledger.json in CI, committed by the
 * workflow's ledger-commit step). It is read before routeAlert (which rewrites
 * the condition record) and patched back only after the email was delivered,
 * so a failed or cooled-down send leaves the cards to be announced next run.
 *
 * Exit codes: 0 = ran (sent or nothing new), 3 = could not read Linear.
 */

'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const linear = require('./lib/linear-client');
const { TERMINAL_STATE_TYPES } = require('./lib/linear-state-types.js');
const { findOwnerDecisions, planNotification, formatEmail } = require('./lib/owner-decision-notify.js');

const USAGE = 'Usage: node scripts/notify-owner-decisions.js [--dry-run] [--local-ok]';
const CONDITION_KEY = 'owner-decisions:new';
// When this job itself is broken the owner silently stops hearing about
// decisions, so its own failures go to the morning digest (which escalates
// a repeat, BRO-3030). Resolved on the next good run.
const BROKEN_KEY = 'owner-decisions:job-broken';
const MAX_PAGES = 40;

const OPEN_ISSUES_QUERY = `query($teamKey: String!, $after: String) {
  issues(first: 100, after: $after, filter: {
    team: { key: { eq: $teamKey } },
    state: { type: { nin: ${JSON.stringify(TERMINAL_STATE_TYPES)} } }
  }) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier title description priority url createdAt labels { nodes { name } } }
  }
}`;

async function fetchOpenIssues() {
  const out = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await linear.graphql(OPEN_ISSUES_QUERY, { teamKey: linear.TEAM_KEY, after });
    out.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage) return out;
    after = data.issues.pageInfo.endCursor;
  }
  throw new Error(`more than ${MAX_PAGES * 100} open issues; refusing to treat a partial list as complete`);
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const dryRun = argv.includes('--dry-run');
  // The told-set lives in the CI ledger. A send from a laptop would record it
  // in the local ledger only, and CI would email the same cards again.
  if (!dryRun && !process.env.CI && !argv.includes('--local-ok')) {
    console.error('[owner-decisions] refusing to send outside CI (the told-set is the CI ledger). Use --dry-run, or --local-ok if you mean it.');
    return 2;
  }
  const router = require('./lib/owner-alert-router.js');
  const reportBroken = async (why) => {
    console.error(`[owner-decisions] ${why}`);
    if (dryRun) return;
    await router.routeAlert({
      conditionKey: BROKEN_KEY,
      title: 'Decision email job is broken',
      description: `${why}. Until this is fixed the owner is not told about new decisions.`,
      severity: 'warning',
      disposition: 'digest',
    });
  };

  let issues;
  try {
    issues = await fetchOpenIssues();
  } catch (err) {
    await reportBroken(`could not read Linear: ${err.message}`);
    return 3;
  }

  const existing = router.loadLedger().conditions[CONDITION_KEY];
  const notified = existing && Array.isArray(existing.notifiedIds) ? existing.notifiedIds : [];
  const decisions = findOwnerDecisions(issues);
  const plan = planNotification(decisions, notified);
  console.log(`[owner-decisions] ${decisions.length} open decision(s) on ${issues.length} open card(s); ${plan.fresh.length} new, ${notified.length} already told`);

  if (plan.fresh.length === 0) {
    if (!dryRun) router.resolveCondition(BROKEN_KEY, { reason: 'ran clean, nothing new' });
    // Nothing new, but drop answered cards from the told-set so a card that
    // is later re-marked gets announced again.
    if (!dryRun && plan.nextNotified.length !== notified.length) {
      router.patchCondition(CONDITION_KEY, { notifiedIds: plan.nextNotified });
    }
    return 0;
  }
  const email = formatEmail(plan);
  if (dryRun) {
    console.log(`\n--- would email (dry run) ---\nSubject: ${email.title}\n\n${email.description}`);
    return 0;
  }

  const result = await router.routeAlert({
    conditionKey: CONDITION_KEY,
    title: email.title,
    description: email.description,
    severity: 'error',
    disposition: 'human',
    subjectLabel: '',
    cooldownHours: 20,
  });
  if (result && result.action === 'human' && result.delivered) {
    if (!router.patchCondition(CONDITION_KEY, { notifiedIds: plan.nextNotified })) {
      await reportBroken('email sent but the told-set could not be saved; the same cards will be emailed again tomorrow');
      return 4;
    }
    router.resolveCondition(BROKEN_KEY, { reason: 'decision email delivered' });
    console.log(`[owner-decisions] emailed ${plan.listed.length} decision(s)`);
  } else if (result && result.action === 'human') {
    await reportBroken('the decision email was not delivered (check RESEND_API_KEY / OWNER_EMAIL); will retry next run');
  } else {
    console.log(`[owner-decisions] not sent (${result ? result.action : 'no result'}); will retry next run`);
  }
  return 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[owner-decisions] ${err.stack || err.message}`);
    process.exitCode = 3;
  });
}

module.exports = { main, fetchOpenIssues, OPEN_ISSUES_QUERY, CONDITION_KEY, BROKEN_KEY };
