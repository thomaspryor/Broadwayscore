#!/usr/bin/env node
/**
 * route-readiness-failure.js: file a dispatch-now Linear card when an
 * UNATTENDED opening-night readiness check fails (BRO-3038).
 *
 * check-opening-night-readiness.yml is dispatched two ways: by hand (someone
 * is watching the run) and by update-show-status.yml the morning before a
 * show opens (nobody is). Its notify-failure step is severity 'warning', so an
 * unattended failure only reached the next morning's digest, often after the
 * opening it was meant to protect. It does not page the owner either: under
 * BRO-4603 email is for things only the owner can act on, and a readiness
 * failure (cron, credits, slugs, zones) is fixable by a worker. So an
 * unattended failure files a High (P1) card through the alert router with
 * dispatchAtFiling: the Mac-side red-first pass (red-first-dispatch.js) starts
 * a headless worker on it within minutes while the Mac is on; otherwise the
 * cloud board worker takes it once it has sat idle for its IDLE_MS (6h).
 * A hand-dispatched run files nothing: the person who started it sees it.
 *
 * A passing run resolves the condition when it covered the same market checks
 * as the show's own (a --market override that flips Broadway/West End skips
 * the failing checks, so it proves nothing). The card's VERIFY is the router's
 * per-condition ledger check (check-alert-condition-absent.js) for THIS show's
 * key only, so another show's leftover condition never blocks it, and a key
 * missing from the ledger (its commit failed) is "cannot tell", never a pass.
 * Once resolved, red-first-dispatch.js's follow-up (Mac-side, so only while
 * the Mac runs) cancels a never-dispatched card or comments on a dispatched
 * one, honoring a live job; otherwise the card closes through its VERIFY.
 *
 *   node scripts/route-readiness-failure.js --show=<id> --outcome=<success|failure> --triggered-by=<who> [--market=<m>] [--run-id=N --run-url=URL] [--dry-run]
 *
 * Exit 0 when nothing needed doing, the card was filed / already open, or the
 * condition was resolved; 1 when filing failed (also an ::error:: annotation
 * and a step-summary line, so the continue-on-error step still shows it).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { alertAbsentCheckCmd } = require('./lib/health-row-check-cmd.js');
const { marketCoversShow } = require('./lib/readiness-market.js');

const UNATTENDED_TRIGGERS = new Set(['update-show-status']);
const CONDITION_PREFIX = 'opening-readiness:failed:';
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

/** Pure: the card's VERIFY line, scoped to this show's condition key. */
function verifyLineFor(showId) {
  return `VERIFY: ${alertAbsentCheckCmd(`${CONDITION_PREFIX}${showId}`)}`;
}

/** Pure: 'route' | 'resolve' | 'none' for one finished readiness run. */
function readinessRunAction({ showId, triggeredBy, outcome }) {
  if (!showId) return 'none';
  if (outcome === 'success') return 'resolve';
  if (outcome === 'failure' && UNATTENDED_TRIGGERS.has(String(triggeredBy || '').trim())) return 'route';
  return 'none';
}

function showCategory(showId) {
  try {
    const { shows } = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const s = (shows || []).find((x) => x && x.id === showId);
    return s ? (s.category || 'broadway') : null;
  } catch {
    return null;
  }
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
      + 'A headless worker is started on this card within minutes while the Mac is on, otherwise a cloud board worker takes it after about six hours; the owner does not need to act. '
      + `If it is not fixed before the opening, reviews for this show may be slow or missing on opening night.\n\nRun: ${runUrl || '(no run url)'}\n\n`
      + `Re-run locally: node scripts/check-opening-night-readiness.js --show=${showId}`,
    hint: `Open the run log, fix each failed check (orchestrator cron, ScrapingBee/Bright Data budget, DTLI slug, category/status), then re-dispatch check-opening-night-readiness.yml with show_id=${showId} and market=auto. A passing run resolves this condition, which is what the VERIFY checks.`,
    // 'error' files the card at Linear High, this repo's P1 (the router ignores `priority`).
    severity: 'error',
    disposition: 'auto',
    cardAction: 'Fix',
    verify: { line: verifyLineFor(showId), note: `passes once a later readiness run for ${showId} succeeded and resolved its condition in the alert ledger` },
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

// GitHub workflow-command data escaping: % first, then CR and LF.
function escapeAnnotation(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function reportFilingFailure(key, why) {
  const msg = `the readiness card for ${key} was NOT filed (${String(why).slice(0, 300)}), so no worker is on this show's readiness failure. Re-run this workflow, or file the card by hand.`;
  if (process.env.GITHUB_ACTIONS) console.error(`::error title=Readiness card not filed::${escapeAnnotation(msg)}`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n**Readiness card not filed:** ${msg}\n`); } catch { /* best effort */ }
  }
  console.error(`[readiness-failure] ${msg}`);
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help || args.h) {
    console.log('Usage: node scripts/route-readiness-failure.js --show=<id> --outcome=<success|failure> --triggered-by=<who> [--market=<m>] [--run-id=N --run-url=URL] [--dry-run]');
    return 0;
  }
  const showId = args.show;
  const action = readinessRunAction({ showId, triggeredBy: args['triggered-by'], outcome: args.outcome });
  if (action === 'none') {
    console.log(`[readiness-failure] outcome=${args.outcome || '?'} triggered_by='${args['triggered-by'] || ''}': nothing to file (attended run, or not a check failure).`);
    return 0;
  }
  const key = `${CONDITION_PREFIX}${showId}`;
  const router = require('./lib/owner-alert-router');
  if (action === 'resolve') {
    const market = typeof args.market === 'string' ? args.market : '';
    if (!marketCoversShow({ market, category: showCategory(showId) })) {
      console.log(`[readiness-failure] ${key}: not resolved, --market=${market} does not cover the show's own market checks`);
      return 0;
    }
    if (args['dry-run']) {
      const open = ((router.loadLedger().conditions || {})[key] || {}).status === 'open';
      console.log(`[readiness-failure] DRY RUN: ${open ? `would resolve ${key}` : `${key}: nothing open`}`);
      return 0;
    }
    const resolved = router.resolveCondition(key, { reason: `readiness check passed${args['run-url'] ? ` (${args['run-url']})` : ''}` });
    console.log(`[readiness-failure] ${key}: ${resolved ? 'resolved' : 'nothing open'}`);
    return 0;
  }
  const opts = readinessFailureAlert({
    showId, triggeredBy: args['triggered-by'], runId: args['run-id'] || null, runUrl: args['run-url'] || null,
  });
  if (args['dry-run']) {
    console.log(`[readiness-failure] DRY RUN: would route ${JSON.stringify(opts, null, 2)}`);
    return 0;
  }
  let result;
  try {
    result = await router.routeAlert(opts);
  } catch (err) {
    reportFilingFailure(key, err.message);
    return 1;
  }
  console.log(`[readiness-failure] ${opts.conditionKey}: ${result.action}${result.linearIdentifier ? ` (${result.linearIdentifier})` : ''}`);
  const filed = result.linearIdentifier && result.dispatchOk !== false;
  if (!filed) reportFilingFailure(key, result.dispatchError || `router action ${result.action}`);
  return filed ? 0 : 1;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[readiness-failure] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { readinessFailureAlert, readinessRunAction, marketCoversShow, verifyLineFor, escapeAnnotation, CONDITION_PREFIX, UNATTENDED_TRIGGERS, main };
