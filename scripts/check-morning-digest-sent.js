#!/usr/bin/env node
/**
 * check-morning-digest-sent.js — BRO-4373. CI-side dead-Mac detector.
 *
 * Two independent signals, both run live by check-morning-digest-sent.yml on
 * GitHub, so neither depends on the machine it watches (BRO-6764: the digest now
 * sends from the GitHub Action, so it arrives even when the Mac is dead):
 *   heartbeat (default): the Mac's checkout-sync commit status is fresh. Pages
 *     'mac:checkin-heartbeat-dead' when the Mac stopped checking in (off or at
 *     the FileVault login screen).
 *   digest: Resend send history shows today's (ET) morning digest. Pages
 *     'mac:morning-digest-missing' when the Action's digest never arrived.
 * Own alert keys, so one signal re-arming never resolves the other's incident.
 * Digest decision logic: scripts/lib/morning-digest-liveness.js.
 *
 * Usage:
 *   node scripts/check-morning-digest-sent.js                  heartbeat signal, live
 *   node scripts/check-morning-digest-sent.js --dry-run        report only, never routeAlert
 *   node scripts/check-morning-digest-sent.js --signal=digest [--date=YYYY-MM-DD]  the digest-arrived signal
 *
 * Exit: 0 digest found (or paged / would page), 2 could not tell (Resend error
 * or missing env: never pages, job goes red so a broken checker is not silent).
 * Env: RESEND_API_KEY (full access), OWNER_EMAIL; live mode also LINEAR_API_KEY.
 * Heartbeat signal: GH_TOKEN (read access) instead of the Resend pair.
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const { dayKeyET } = require('./lib/scheduled-email-count-rules.js');
const { fetchOwnerEmailsSince } = require('./lib/resend-owner-emails.js');
const { decideMorningDigest, CONDITION_KEY, ALERT_TITLE, ALERT_DESCRIPTION } = require('./lib/morning-digest-liveness.js');

const HEARTBEAT_CONDITION_KEY = 'mac:checkin-heartbeat-dead';
const HEARTBEAT_ALERT_TITLE = 'The Mac Studio has stopped checking in. It is probably off or logged out';
const HEARTBEAT_ALERT_DESCRIPTION = 'Log in to the Mac Studio. If it is on and logged in, its code sync is stuck. Until then the Mac\'s jobs are not running.';

// The heartbeat signal (BRO-6230). Same exits as the digest signal below, its own alert key.
async function checkHeartbeat({ dryRun }) {
  const { readMacAlive } = require('./lib/mac-applied-heartbeat.js');
  const r = await readMacAlive({ token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN });
  console.log(`[mac-heartbeat] ${r.state.toUpperCase()} — ${r.reason}`);
  if (r.state === 'unknown') {
    console.error('::warning::Cannot read the Mac heartbeat; NOT paging. Fix the checker.');
    process.exit(2);
  }
  if (dryRun) {
    if (r.state === 'dead') console.log('[mac-heartbeat] dry-run: would page the owner');
    return;
  }
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router.js');
  if (r.state === 'alive') {
    if (resolveCondition('mac:checkin-heartbeat-dead')) console.log(`[mac-heartbeat] ${HEARTBEAT_CONDITION_KEY} re-armed`);
    return;
  }
  const result = await routeAlert({
    conditionKey: 'mac:checkin-heartbeat-dead',
    title: HEARTBEAT_ALERT_TITLE,
    description: HEARTBEAT_ALERT_DESCRIPTION,
    severity: 'critical',
    disposition: 'human',
    cooldownHours: 20,
  });
  console.log(`[mac-heartbeat] routeAlert -> ${result.action} delivered=${result.delivered}`);
  if (result.delivered === false) {
    console.error('::error::The Mac heartbeat is dead and the owner page was NOT delivered');
    process.exit(2);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) {
    console.log('Usage: node scripts/check-morning-digest-sent.js [--dry-run] [--signal=heartbeat|digest] [--date=YYYY-MM-DD (digest only)]');
    return;
  }
  const dryRun = argv.includes('--dry-run');
  const signalArg = argv.find((a) => a.startsWith('--signal='));
  const signal = signalArg ? signalArg.split('=')[1] : 'heartbeat';
  if (signal === 'heartbeat') return checkHeartbeat({ dryRun });
  if (signal !== 'digest') {
    console.error(`Bad --signal "${signal}" (want digest or heartbeat)`);
    process.exit(2);
  }
  const dateArg = argv.find((a) => a.startsWith('--date='));
  const dateET = dateArg ? dateArg.split('=')[1] : dayKeyET(new Date().toISOString());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateET)) {
    console.error(`Bad --date "${dateET}" (want YYYY-MM-DD)`);
    process.exit(2);
  }

  // The Action sends ~07:50 ET (retries to ~08:50); a manual/early run before 09:00 ET would
  // page for a digest that simply has not been due yet.
  const etHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  if (!dateArg && etHour < 9) {
    console.log(`[morning-digest] ${dateET}: only ${etHour}:xx ET, digest not due until 07:50 + margin. Nothing to check.`);
    return;
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
      emails = await fetchOwnerEmailsSince({ apiKey, ownerEmail, sinceMs, strict: true });
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
  // A historical --date is report-only: routeAlert/resolveCondition would
  // mutate the SHARED 'mac:morning-digest-missing' incident for a day that
  // is not today (ship-check finding).
  const historical = !!dateArg && dateET !== dayKeyET(new Date().toISOString());
  if (dryRun || historical) {
    if (historical && !dryRun) console.log('[morning-digest] --date is not today: report-only, no alert state touched');
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
  console.log(`[morning-digest] routeAlert -> ${result.action} delivered=${result.delivered}`);
  // routeAlert returns delivered:false WITHOUT throwing when the email fails
  // (owner-alert-router.js). A missing digest whose page did not go out must
  // not end green. Cooldown suppression / already-open incidents are not
  // 'human' sends, so they carry no delivered:false.
  if (result.delivered === false) {
    console.error('::error::Digest is missing and the owner page was NOT delivered');
    process.exit(2);
  }
}

main().catch((err) => { console.error('Fatal:', err.message); process.exit(2); });
