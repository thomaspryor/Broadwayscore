#!/usr/bin/env node
/**
 * route-readiness-failure.js — file a dispatch-now Linear card when an
 * UNATTENDED opening-night readiness check fails (BRO-3038).
 *
 * check-opening-night-readiness.yml is dispatched two ways: by hand (someone
 * is watching the run) and by update-show-status.yml the morning before a
 * show opens (nobody is). Its notify-failure step is severity 'warning', so an
 * unattended failure only reached the next morning's digest, often after the
 * opening it was meant to protect. It does not page the owner either: under
 * BRO-4603 email is for things only the owner can act on, and a readiness
 * failure (cron, credits, slugs, zones) is fixable by a worker. So an
 * unattended failure files a P1 card through the alert router with
 * dispatchAtFiling, which the cloud board workers pick up within hours.
 * A hand-dispatched run files nothing: the person who started it sees it.
 * Any PASSING run resolves the condition, so the card closes itself once a
 * worker fixed the cause and re-ran the check (its VERIFY reads the ledger).
 *
 *   node scripts/route-readiness-failure.js --show=<id> --outcome=<success|failure> --triggered-by=<who> [--run-id=N --run-url=URL] [--dry-run]
 *
 * Exit 0 when nothing needed doing, the card was filed / already open, or the
 * condition was resolved; 1 when filing failed.
 */
'use strict';

const UNATTENDED_TRIGGERS = new Set(['update-show-status']);
const CONDITION_PREFIX = 'opening-readiness:failed:';
const VERIFY_LINE = 'VERIFY: node --test tests/live/opening-readiness-clear.test.mjs';

/** Pure: 'route' | 'resolve' | 'none' for one finished readiness run. */
function readinessRunAction({ showId, triggeredBy, outcome }) {
  if (!showId) return 'none';
  if (outcome === 'success') return 'resolve';
  if (outcome === 'failure' && UNATTENDED_TRIGGERS.has(String(triggeredBy || '').trim())) return 'route';
  return 'none';
}

/**
 * Pure: the routeAlert options for this failure, or null when the run was
 * attended (hand-dispatched, or any trigger not known to be unattended).
 */
function readinessFailureAlert({ showId, triggeredBy, runId = null, runUrl = null }) {
  if (readinessRunAction({ showId, triggeredBy, outcome: 'failure' }) !== 'route') return null;
  return {
    conditionKey: `${CONDITION_PREFIX}${showId}`,
    title: `Opening-night readiness check failed for ${showId}`,
    description: 'The automatic pre-opening readiness check failed for a show opening tomorrow, and nobody was watching the run. '
      + 'A board worker picks this card up on its next pass (a few hours); the owner does not need to act. If it is not fixed before the opening, '
      + `reviews for this show may be slow or missing on opening night.\n\nRun: ${runUrl || '(no run url)'}\n\n`
      + `Re-run locally: node scripts/check-opening-night-readiness.js --show=${showId}`,
    hint: `Open the run log, fix each failed check (orchestrator cron, ScrapingBee/Bright Data budget, DTLI slug, category/status), then re-dispatch check-opening-night-readiness.yml with show_id=${showId}. A passing run resolves this condition, which is what the VERIFY checks.`,
    // 'error' files the card at High (the router ignores `priority`).
    severity: 'error',
    disposition: 'auto',
    cardAction: 'Fix',
    verify: { line: VERIFY_LINE, note: 'passes once a later readiness run for the show succeeded and resolved the condition' },
    // A show opens once; a week-long cooldown keeps a re-run from filing twice.
    cooldownHours: 168,
    ...(runId ? { dispatchAtFiling: { runId: String(runId), runUrl: runUrl || null } } : {}),
  };
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log('Usage: node scripts/route-readiness-failure.js --show=<id> --outcome=<success|failure> --triggered-by=<who> [--run-id=N --run-url=URL] [--dry-run]');
    return 0;
  }
  const showId = args.show;
  const action = readinessRunAction({ showId, triggeredBy: args['triggered-by'], outcome: args.outcome });
  const router = require('./lib/owner-alert-router');
  if (action === 'resolve') {
    const key = `${CONDITION_PREFIX}${showId}`;
    const open = ((router.loadLedger().conditions || {})[key] || {}).status === 'open';
    if (!open) { console.log(`[readiness-failure] ${key}: nothing open`); return 0; }
    if (args['dry-run']) { console.log(`[readiness-failure] DRY RUN — would resolve ${key}`); return 0; }
    router.resolveCondition(key, { reason: `readiness check passed${args['run-url'] ? ` (${args['run-url']})` : ''}` });
    console.log(`[readiness-failure] ${key}: resolved`);
    return 0;
  }
  if (action === 'none') {
    console.log(`[readiness-failure] outcome=${args.outcome || '?'} triggered_by='${args['triggered-by'] || ''}' — nothing to file (attended run, or not a check failure).`);
    return 0;
  }
  const opts = readinessFailureAlert({
    showId, triggeredBy: args['triggered-by'], runId: args['run-id'] || null, runUrl: args['run-url'] || null,
  });
  if (args['dry-run']) {
    console.log(`[readiness-failure] DRY RUN — would route ${JSON.stringify(opts, null, 2)}`);
    return 0;
  }
  const result = await router.routeAlert(opts);
  console.log(`[readiness-failure] ${opts.conditionKey}: ${result.action}${result.linearIdentifier ? ` (${result.linearIdentifier})` : ''}`);
  const filed = result.linearIdentifier && result.dispatchOk !== false;
  return filed ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[readiness-failure] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { readinessFailureAlert, readinessRunAction, CONDITION_PREFIX, VERIFY_LINE, UNATTENDED_TRIGGERS, main };
