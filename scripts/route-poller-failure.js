#!/usr/bin/env node
/**
 * route-poller-failure.js: decide who hears about an Opening Night Poller
 * failure (BRO-5479, owner decision 2026-10-16).
 *
 * The owner wants an email only when a Broadway show is in the poll. Every
 * other failure (Off-Broadway, West End, Off-West End) is something only a
 * worker can fix, so it files a dispatch-now Linear card through the alert
 * router instead: the Mac-side red-first pass starts a headless worker on it
 * within minutes while the Mac is on, otherwise the cloud board worker takes
 * it once it has sat idle (same path as route-readiness-failure.js).
 *
 * Fail-open: a show id missing from shows.json, an unreadable shows.json, or
 * an empty show list all count as Broadway, so a broken lookup still emails.
 * The workflow reads `broadway` the same way: only an explicit 'false' stops
 * the email.
 *
 * Conditions are keyed per market (opening-night-poller:failure:<market>) and
 * a passing run resolves only the markets it actually polled, so a green
 * Broadway run never clears a West End failure.
 *
 *   node scripts/route-poller-failure.js --audience --shows=a,b
 *   node scripts/route-poller-failure.js --outcome=failure --shows=a,b [--run-id=N --run-url=URL] [--dry-run]
 *   node scripts/route-poller-failure.js --outcome=success --shows=a,b [--dry-run]
 *
 * --audience writes broadway=true|false to $GITHUB_OUTPUT. --outcome=success
 * writes resolved=true|false. Exit 1 only when a card should have been filed
 * and was not.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { alertAbsentCheckCmd } = require('./lib/health-row-check-cmd.js');

const CONDITION_PREFIX = 'opening-night-poller:failure:';
const NON_BROADWAY_MARKETS = ['off-broadway', 'off-west-end', 'west-end'];
// The find step's widest lookback (West End market runs use 4 days).
const WIDEST_LOOKBACK_DAYS = 4;
// Page-worthy key (scripts/lib/page-worthy-alerts.js): emails the owner when
// the auto-fix card itself could not be filed, so a Linear outage is not silent.
const CARD_NOT_FILED_KEY = 'opening-night-poller:card-not-filed';
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

function parseShowIds(raw) {
  return String(raw || '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Pure: the market of each polled show. Unknown ids map to 'broadway'
 * (fail-open), matching the find step's `s.category || 'broadway'`.
 */
function pollMarkets(showIds, shows) {
  const byId = new Map((shows || []).filter((s) => s && s.id).map((s) => [s.id, s]));
  return showIds.map((id) => (byId.get(id) && byId.get(id).category) || 'broadway');
}

/** Pure: true when the owner should be emailed for a failure of this poll. */
function isBroadwayPoll(showIds, shows) {
  if (!showIds.length) return true;
  return pollMarkets(showIds, shows).includes('broadway');
}

/** Pure: the distinct markets in this poll, sorted. */
function marketsInPoll(showIds, shows) {
  return [...new Set(pollMarkets(showIds, shows))].sort();
}

function conditionKeyFor(market) {
  return `${CONDITION_PREFIX}${market}`;
}

/**
 * Pure: which markets a passing run resolves. Always the markets it polled;
 * a full auto-discovery run (no show_id, no market filter) also resolves the
 * non-Broadway markets it found nothing to poll in, since their shows have
 * left the opening window and no later run would ever clear them.
 */
function marketsToResolve(showIds, shows, autoRun, now = new Date()) {
  const polled = marketsInPoll(showIds, shows);
  if (!autoRun) return polled;
  // The auto run looks back 2 days but market-filtered West End runs look
  // back 4, so only clear a market with no opening in the widest window.
  const idle = NON_BROADWAY_MARKETS.filter((m) => !marketHasRecentOpening(m, shows, now));
  return [...new Set([...polled, ...idle])].sort();
}

/** Pure: does this market have a show that opened within the widest poll window? */
function marketHasRecentOpening(market, shows, now = new Date(), days = WIDEST_LOOKBACK_DAYS) {
  const cutoff = now.getTime() - (days + 1) * 86400000;
  return (shows || []).some((s) => {
    if (!s || (s.category || 'broadway') !== market) return false;
    if (!s.openingDate) return s.status === 'previews';
    const t = Date.parse(s.openingDate);
    return Number.isFinite(t) && t >= cutoff && t <= now.getTime() + 86400000;
  });
}

/** Pure: the routeAlert options for one non-Broadway market's failure. */
function pollerFailureAlert({ market, showIds, runId = null, runUrl = null }) {
  const key = conditionKeyFor(market);
  return {
    conditionKey: key,
    title: `Opening Night Poller failing for ${market} shows`,
    description: `The opening-night review poller failed twice in a row while polling ${market} shows (${showIds.join(', ')}). `
      + 'By owner decision this does not email the owner (only Broadway openings do); a headless worker is started on this card within minutes while the Mac is on, otherwise a cloud board worker takes it once it has sat idle. '
      + `Until it is fixed, new reviews for these shows may be slow to appear.\n\nRun: ${runUrl || '(no run url)'}`,
    hint: 'Open the run log, find the failed step, fix the cause, then let the next poller run pass for this market. A passing run that polls this market resolves the condition, which is what the VERIFY checks.',
    severity: 'error',
    disposition: 'auto',
    cardAction: 'Fix',
    verify: { line: `VERIFY: ${alertAbsentCheckCmd(key)}`, note: `passes once a later poller run that polled ${market} shows succeeded` },
    cooldownHours: 24,
    ...(runId ? { dispatchAtFiling: { runId: String(runId), runUrl: runUrl || null } } : {}),
  };
}

/** Pure: the owner email sent when the auto-fix card could not be filed. */
function cardNotFiledAlert({ showIds, runUrl = null }) {
  return {
    conditionKey: CARD_NOT_FILED_KEY,
    title: 'Opening Night Poller failing, and the automatic fix task could not be created',
    description: `The review poller failed twice in a row for ${showIds.join(', ') || 'its shows'}. These are not Broadway shows, so this would normally go to the automatic fixer, but the task could not be created. Start a Claude session to look at it.\n\nRun: ${runUrl || '(no run url)'}`,
    severity: 'critical',
    disposition: 'human',
    cooldownHours: 12,
    url: runUrl || undefined,
  };
}

function loadShows() {
  try {
    return JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows || [];
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
    if (m) out[m[1]] = m[2] === undefined ? true : m[2];
  }
  return out;
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

// GitHub workflow-command data escaping: % first, then CR and LF.
function escapeAnnotation(s) {
  return String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const showIds = parseShowIds(args.shows);
  const shows = loadShows();

  if (args.audience) {
    const broadway = shows === null ? true : isBroadwayPoll(showIds, shows);
    console.log(`[poller-failure] shows=${showIds.join(',') || '(none)'} broadway=${broadway}`);
    setOutput('broadway', broadway ? 'true' : 'false');
    return 0;
  }

  const markets = shows === null ? [] : marketsInPoll(showIds, shows);
  const router = require('./lib/owner-alert-router');

  if (args.outcome === 'success') {
    let resolved = false;
    const toResolve = shows === null ? [] : marketsToResolve(showIds, shows, args['auto-run'] === 'true');
    for (const market of toResolve) {
      const key = conditionKeyFor(market);
      if (args['dry-run']) {
        const open = ((router.loadLedger().conditions || {})[key] || {}).status === 'open';
        console.log(`[poller-failure] DRY RUN: ${open ? `would resolve ${key}` : `${key}: nothing open`}`);
        continue;
      }
      const did = router.resolveCondition(key, { reason: `poller run passed${args['run-url'] ? ` (${args['run-url']})` : ''}` });
      console.log(`[poller-failure] ${key}: ${did ? 'resolved' : 'nothing open'}`);
      resolved = resolved || !!did;
    }
    setOutput('resolved', resolved ? 'true' : 'false');
    return 0;
  }

  if (args.outcome !== 'failure') {
    console.log(`[poller-failure] outcome=${args.outcome || '?'}: nothing to do`);
    return 0;
  }

  let failed = false;
  for (const market of markets.filter((m) => m !== 'broadway')) {
    const opts = pollerFailureAlert({
      market, showIds: showIds.filter((id) => pollMarkets([id], shows)[0] === market),
      runId: args['run-id'] || null, runUrl: args['run-url'] || null,
    });
    if (args['dry-run']) {
      console.log(`[poller-failure] DRY RUN: would route ${JSON.stringify(opts, null, 2)}`);
      continue;
    }
    let result;
    try {
      result = await router.routeAlert(opts);
    } catch (err) {
      result = { action: 'error', dispatchError: err.message };
    }
    console.log(`[poller-failure] ${opts.conditionKey}: ${result.action}${result.linearIdentifier ? ` (${result.linearIdentifier})` : ''}`);
    const ok = result.action === 'silent' || (result.linearIdentifier && result.dispatchOk !== false);
    if (!ok) {
      failed = true;
      const msg = `the auto-fix card for ${opts.conditionKey} was NOT filed (${String(result.dispatchError || result.action).slice(0, 300)}), so no worker is on this poller failure.`;
      if (process.env.GITHUB_ACTIONS) console.error(`::error title=Poller fix card not filed::${escapeAnnotation(msg)}`);
      console.error(`[poller-failure] ${msg}`);
    }
  }
  if (failed && !args['dry-run']) {
    // Nobody would hear otherwise: email the owner through a page-worthy key.
    try {
      const page = await router.routeAlert(cardNotFiledAlert({ showIds, runUrl: args['run-url'] || null }));
      console.log(`[poller-failure] ${CARD_NOT_FILED_KEY}: ${page.action}`);
    } catch (err) {
      console.error(`[poller-failure] fallback email failed too: ${err.message}`);
    }
  }
  return failed ? 1 : 0;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => {
    console.error(`[poller-failure] ${err.stack || err.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseShowIds, pollMarkets, isBroadwayPoll, marketsInPoll, marketsToResolve, conditionKeyFor,
  pollerFailureAlert, cardNotFiledAlert, marketHasRecentOpening, CONDITION_PREFIX, CARD_NOT_FILED_KEY, NON_BROADWAY_MARKETS, main,
};
