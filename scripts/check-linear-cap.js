#!/usr/bin/env node
/**
 * check-linear-cap.js — warns before the workspace hits Linear's free-tier
 * 250-unarchived-issue hard cap (BRO-285). Exits 1 (with the count) once
 * unarchived issues reach WARN_THRESHOLD, so an alert/cron can fire
 * scripts/linear-archive-done.js before new-issue creation starts throwing
 * USAGE_LIMIT_EXCEEDED (scripts/lib/linear-issue-create.js).
 *
 * All Linear API access goes through scripts/lib/linear-client.js — a raw
 * GraphQL mutation call or a direct reference to Linear's API host anywhere
 * outside that file's small allowlist fails the CI gate at
 * scripts/audit-linear-issuecreate-chokepoint.js.
 *
 * Usage: node scripts/check-linear-cap.js [--alert]
 *
 * --alert (the scheduled data-health-check.yml path): on breach, queue a
 * DIGEST row via owner-alert-router routeAlert() (disposition 'digest' — the
 * sanctioned funnel, never its own email; time-to-publish-sla.js --alert is
 * the pattern) in addition to the exit-1. The workflow step is
 * continue-on-error, so the digest row is the owner-facing channel and the
 * exit code serves ad-hoc CLI use.
 */

'use strict';

const linear = require('./lib/linear-client');
const { WARN_THRESHOLD, isOverCapThreshold, isCapEnforced } = require('./lib/linear-cap-policy');

async function main() {
  const alertMode = process.argv.includes('--alert');
  const team = await linear.getTeam();
  const issues = await linear.listIssues(team.id);
  const count = issues.length;

  // Paid plan => no 250 ceiling => this check has nothing to warn about. Read
  // the live subscription rather than a hardcoded flag so a downgrade re-arms
  // the alarm on its own. Fail-open on a query error (treat as free tier) so a
  // transient Linear failure can never silently disable the cap guard.
  let subscription = null;
  try {
    const org = await linear.graphql('query{ organization{ subscription{ type } } }', {});
    subscription = org && org.organization ? org.organization.subscription : null;
  } catch (err) {
    console.error(`check-linear-cap: subscription lookup failed (${err.message}) — assuming free tier`);
  }
  if (!isCapEnforced(subscription)) {
    if (alertMode) {
      const { resolveCondition } = require('./lib/owner-alert-router');
      resolveCondition('linear:issue-cap');
    }
    console.log(`check-linear-cap: OK — paid plan (${subscription.type}), no issue cap; ${count} unarchived issues.`);
    return;
  }

  if (isOverCapThreshold(count, WARN_THRESHOLD)) {
    console.error(
      `check-linear-cap: ${count} unarchived issues >= ${WARN_THRESHOLD} warn threshold ` +
      `(Linear's free-tier hard cap is 250). Run scripts/linear-archive-done.js to archive ` +
      `stale Done/Canceled issues.`
    );
    if (alertMode) {
      const { routeAlert } = require('./lib/owner-alert-router');
      await routeAlert({
        conditionKey: 'linear:issue-cap',
        // Stable title (counts live in description/prompt): the digest clips
        // decisionPrompt to 200 chars and requires the TITLE verbatim in that
        // head (headStandsAlone), so a dynamic count in the title would make
        // every prompt fail the clip check.
        title: 'Linear board near its free-plan issue cap',
        description: `The Linear workspace holds ${count} unarchived issues against the free-tier hard cap of 250; at the cap, new-issue creation fails with USAGE_LIMIT_EXCEEDED and the alert/dispatch intake front door jams. linear-archive-done.js already archives Done/Canceled issues older than 48h on each scheduled run, so a sustained breach means the OPEN backlog itself is the driver.`,
        hint: 'Close or archive open issues, or decide on the Linear paid tier. node scripts/linear-archive-done.js --dry-run shows what auto-archive can still reclaim.',
        disposition: 'digest',
        severity: 'warning',
        // Genuine judgment call (the router's documented decision-class): a
        // sustained breach means the OPEN backlog is too big — the fix is
        // closing issues or paying for Linear, not something a dispatched
        // worker can do. decision:true keeps digest-autofix from spawning a
        // doomed auto-fix job against it.
        decision: true,
        decisionPrompt: `Linear board near its free-plan issue cap (${count} of 250 slots used). Should I aggressively close and archive old open items, or do you want to upgrade Linear to the paid plan?`,
      });
    }
    process.exit(1);
  }

  // Green path resolves the condition (time-to-publish-sla.js --alert
  // pattern): without this the ledger row stays open forever and a
  // recover-then-re-breach inside the 7d cooldown would queue nothing.
  if (alertMode) {
    const { resolveCondition } = require('./lib/owner-alert-router');
    resolveCondition('linear:issue-cap');
  }
  console.log(`check-linear-cap: OK — ${count} unarchived issues (< ${WARN_THRESHOLD} threshold).`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`check-linear-cap: ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main };
