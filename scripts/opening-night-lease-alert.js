#!/usr/bin/env node
'use strict';
/**
 * Raise or clear the "lease store unreachable" alert from the local lease file `sync` just wrote (BRO-6648).
 * Run by .github/actions/opening-night-lease-sync with page: 'true' (the poller only: its job commits the alert
 * ledger). Kept out of opening-night-lease.js so the CLI's other callers do not reach routeAlert.
 *
 * Unknown with a show tonight: a worker card (the owner cannot fix a git outage; page-worthy-alerts allows owner
 * email only with an owner action). Unknown with nothing tonight: a ::warning:: only. Known: resolve the card.
 * Always exits 0.
 */
const guard = require('./lib/opening-night-lane/lease-guard');

const CONDITION_KEY = 'opening-night-lease-store-unknown-tonight';

/** The alert for the current lease view, or null. Pure. */
function leaseStoreAlert({ unknown, shows }) {
  if (!unknown || !shows.length) return null;
  const list = shows.join(', ');
  return {
    conditionKey: CONDITION_KEY,
    title: `Opening-night lease store unreachable on ${list}'s press night`,
    description: `scripts/opening-night-lease.js sync could not read the opening-night-leases branch. Old-path writers hold ` +
      `${list} until a sync succeeds; every other show writes. Check git access to the branch and re-run the poller; if the ` +
      `lane is not running tonight, nothing collects ${list} while this lasts.`,
  };
}

async function main() {
  const view = guard.writeBlockedShowIds();
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');
  const alert = leaseStoreAlert(view);
  if (!view.unknown) { require('./lib/guard-escalation').clearGuard(resolveCondition, CONDITION_KEY); return; }
  if (!alert) { console.log('::warning::opening-night lease store unreachable; no press night now, so every writer proceeds'); return; }
  console.log(`::error::${alert.title}`);
  await require('./lib/guard-escalation').escalateGuard(routeAlert, alert);
}

module.exports = { leaseStoreAlert, CONDITION_KEY };

if (require.main === module) {
  const deadline = setTimeout(() => { console.log('::warning::opening-night-lease-alert: timed out after 60s'); process.exit(0); }, 60000);
  main().catch((e) => console.log(`::warning::opening-night-lease-alert failed (${String(e.message).slice(0, 160)})`))
    .finally(() => { clearTimeout(deadline); process.exit(0); });
}
