#!/usr/bin/env node
/**
 * check-morning-digest-sent.js — BRO-4373. CI-side dead-Mac detector.
 *
 * Reads Resend send history and pages the owner if today's (ET) morning digest
 * never arrived, i.e. the Mac Studio is off or sitting at the FileVault login
 * screen. Runs from GitHub Actions (check-morning-digest-sent.yml), so it does
 * not depend on the machine it is watching. Decision logic:
 * scripts/lib/morning-digest-liveness.js.
 *
 * Usage:
 *   node scripts/check-morning-digest-sent.js                  live: page if missing, re-arm if found
 *   node scripts/check-morning-digest-sent.js --dry-run        report only, never routeAlert
 *   node scripts/check-morning-digest-sent.js --date=YYYY-MM-DD  check a specific ET day
 *
 * Exit: 0 digest found (or paged / would page), 2 could not tell (Resend error
 * or missing env: never pages, job goes red so a broken checker is not silent).
 * Env: RESEND_API_KEY (full access), OWNER_EMAIL; live mode also LINEAR_API_KEY.
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const { dayKeyET } = require('./lib/scheduled-email-count-rules.js');
const { fetchOwnerEmailsSince } = require('./lib/resend-owner-emails.js');
const { decideMorningDigest, CONDITION_KEY, ALERT_TITLE, ALERT_DESCRIPTION } = require('./lib/morning-digest-liveness.js');

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/check-morning-digest-sent.js [--dry-run] [--date=YYYY-MM-DD]');
    return;
  }
  const dryRun = argv.includes('--dry-run');
  const dateArg = argv.find((a) => a.startsWith('--date='));
  const dateET = dateArg ? dateArg.split('=')[1] : dayKeyET(new Date().toISOString());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateET)) {
    console.error(`Bad --date "${dateET}" (want YYYY-MM-DD)`);
    process.exit(2);
  }

  const apiKey = process.env.RESEND_API_KEY;
  const ownerEmail = process.env.OWNER_EMAIL;
  let emails = null;
  let apiError = null;
  if (!apiKey || !ownerEmail) {
    apiError = 'RESEND_API_KEY and OWNER_EMAIL must both be set';
  } else {
    // Look back to 1 day before the checked day (covers the ET/UTC offset);
    // pagination stops once rows are older than that.
    const sinceMs = new Date(`${dateET}T00:00:00Z`).getTime() - 24 * 3600 * 1000;
    try {
      emails = await fetchOwnerEmailsSince({ apiKey, ownerEmail, sinceMs });
    } catch (err) {
      apiError = err.message;
    }
  }

  const decision = decideMorningDigest({ emails, ownerEmail, dateET, apiError });
  console.log(`[morning-digest] ${dateET}: ${decision.action.toUpperCase()} — ${decision.reason}`);

  if (decision.action === 'skip') {
    console.error('::warning::Cannot verify the morning digest; NOT paging. Fix the checker.');
    process.exit(2);
  }
  if (dryRun) {
    if (decision.action === 'page') console.log('[morning-digest] dry-run: would page the owner');
    return;
  }

  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router.js');
  if (decision.action === 'ok') {
    if (resolveCondition(CONDITION_KEY)) console.log(`[morning-digest] ${CONDITION_KEY} re-armed`);
    return;
  }
  const result = await routeAlert({
    conditionKey: CONDITION_KEY,
    title: ALERT_TITLE,
    description: ALERT_DESCRIPTION,
    severity: 'critical',
    disposition: 'human',
    cooldownHours: 20,
  });
  console.log(`[morning-digest] routeAlert -> ${result.action}`);
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(2); });
