#!/usr/bin/env node
/**
 * Card #1252: hourly ScrapingDog daily circuit-breaker check.
 *
 * Reads SD's own /account API (fetchSdAccount, already exists), derives
 * today's credit usage (computeTodayCredits — SD only exposes a
 * cycle-cumulative total, not a day figure, so this diffs against a
 * carried-forward baseline; see scripts/lib/scrapingdog-caps.js for why),
 * and writes data/audit/sd-circuit-breaker.json when today crosses the
 * ceiling. scripts/lib/scrapingdog-caps.js consults that file inside the
 * two SD chokepoints (scraper.js fetchWithScrapingdog, url-discovery.js
 * _serpViaScrapingdog), so a runaway sweep stops billing within the hour —
 * structurally a near-copy of scripts/check-bd-breaker.js.
 *
 * Usage:
 *   node scripts/check-sd-breaker.js              # check, write state, alert on change
 *   node scripts/check-sd-breaker.js --dry-run    # print verdict only; no writes, no alerts
 *   SD_BREAKER_CEILING=1 node scripts/check-sd-breaker.js   # forced-low test
 */
'use strict';

const fs = require('fs');
const path = require('path');

const {
  resolveDailyCreditCeiling,
  resolveOpeningWindowReservePerShowCredits,
  shouldTripBreaker,
  computeTodayCredits,
  isBreakerActive,
} = require('./lib/scrapingdog-caps');
const { utcDay, breakerAlertSeverity, effectiveCeilingForOpeningWindow } = require('./lib/brightdata-caps');
const { fetchSdAccount } = require('./lib/provider-billing');
const { topCallers, LEDGER_PATH } = require('./lib/provider-telemetry');
const { countShowsInOpeningWindow } = require('./lib/opening-night-selection');

const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(`check-sd-breaker.js — hourly ScrapingDog daily-spend circuit breaker

  node scripts/check-sd-breaker.js              check, write state, alert on change
  node scripts/check-sd-breaker.js --dry-run    print verdict only (no writes, no alerts)

Env:
  SCRAPINGDOG_API_KEY                        required; without it the check no-ops
  SD_BREAKER_CEILING                         daily credit ceiling (default 45000)
  SD_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS per-show ceiling reserve for opening-window shows (default 3000)
  SD_BREAKER_STATE_PATH                      override the state file location (tests)
`);
  process.exit(0);
}

const DRY_RUN = process.argv.includes('--dry-run');
const STATE_PATH = process.env.SD_BREAKER_STATE_PATH
  || path.join(__dirname, '..', 'data', 'audit', 'sd-circuit-breaker.json');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* absent/corrupt → fresh state */ }
  return null;
}

function topSpenders(day) {
  try {
    const lines = fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean);
    const records = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const top = topCallers(records, day, 'scrapingdog', 3);
    if (!top.length) return 'no attributed SD calls in the ledger today';
    return top.map((t) => `${t.script} (${t.count})`).join(', ');
  } catch {
    return 'ledger unreadable';
  }
}

async function main() {
  const apiKey = process.env.SCRAPINGDOG_API_KEY;
  if (!apiKey) {
    console.log('SCRAPINGDOG_API_KEY not set — skipping breaker check (state left untouched)');
    return;
  }

  const day = utcDay(new Date());
  const ceiling = resolveDailyCreditCeiling();
  const prevState = loadState();
  const wasActive = isBreakerActive(prevState, day);

  // #1330 (mirrors #1315's BD fix): shows within [today-1, today+3] get an
  // absolute credit reserve carved out of the bulk (non-exempt) ceiling — a
  // DIFFERENT, wider window than the severity check below (which asks "is a
  // poller hammering this provider tonight"). Exempt opening-night callers
  // never consult the breaker at all (scrapingdog-caps.js consultScrapingdog),
  // so this only throttles the routine sweeps that were starving them.
  const reserveShows = countShowsInOpeningWindow(SHOWS_PATH, { lookbackDays: 1, lookAheadHours: 72 });
  const effectiveCeiling = effectiveCeilingForOpeningWindow({
    ceiling,
    openingWindowShows: reserveShows,
    reservePerShow: resolveOpeningWindowReservePerShowCredits(),
  });

  const account = await fetchSdAccount(apiKey);
  const cycleUsed = account ? account.cycleUsed : null;

  const { dayCredits, status, newState } = computeTodayCredits({
    cycleUsed,
    day,
    prevState: prevState && prevState.day ? prevState : null,
  });

  console.log(`scrapingdog: ${dayCredits == null ? `${status} (cycle ${cycleUsed ?? 'unknown'})` : `${dayCredits} credits today`} — ceiling ${ceiling}`
    + `${effectiveCeiling !== ceiling ? ` (ceiling ${ceiling}→${effectiveCeiling}: ${reserveShows} show(s) in the budget-reservation window)` : ''}`);

  if (status === 'unknown') {
    // Billing unreachable — leave any existing trip in place rather than
    // clearing the cap because the API blipped (fail-closed on the CLEAR
    // side, fail-open on the TRIP side — brightdata-caps.js's rule).
    console.log('  billing unknown — state left untouched');
    return;
  }

  const verdict = shouldTripBreaker({ dayCredits, ceiling: effectiveCeiling });
  console.log(`  ${verdict.reason}${verdict.tripped ? ' → TRIPPED' : ''}`);

  // Preserve the ORIGINAL trip timestamp across hourly re-checks of the same
  // day; a fresh stamp every hour would make "how long has this been capped"
  // unanswerable in the audit trail.
  const trippedAt = verdict.tripped
    ? (wasActive && prevState.trippedAt) || new Date().toISOString()
    : null;

  const state = {
    ...newState,
    trippedAt,
    ceiling: effectiveCeiling,
    dayCredits,
    status,
    updatedAt: new Date().toISOString(),
  };

  if (DRY_RUN) {
    console.log('--dry-run: state not written, alerts not routed');
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  console.log(`Wrote ${STATE_PATH}`);

  if (verdict.tripped === wasActive) {
    console.log('No breaker state change — no alert.');
    return;
  }

  const openingWindowShows = countShowsInOpeningWindow(SHOWS_PATH);
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');
  const conditionKey = 'sd-circuit-breaker';

  if (!verdict.tripped) {
    const resolved = resolveCondition(conditionKey);
    console.log(`Breaker cleared (${dayCredits}/${effectiveCeiling})${resolved ? ' — open incident resolved' : ''}`);
    return;
  }

  const severity = breakerAlertSeverity({ tripped: true, openingWindowShows });
  const title = `Scrapingdog daily breaker TRIPPED: ${dayCredits}/${effectiveCeiling} credits`;
  const description = [
    `Scrapingdog billed ${dayCredits} credits today against a ceiling of ${effectiveCeiling}.`,
    'Bulk Scrapingdog calls are now skipped for the rest of the UTC day (falling through to Bright Data/ScrapingBee); opening-night flows keep their own exemption.',
    openingWindowShows > 0
      ? `${openingWindowShows} show(s) are in an active opening window — bulk review collection for them is capped.`
      : 'No show is in an active opening window.',
    `Top attributed SD callers today: ${topSpenders(day)}.`,
  ].join('\n');

  await routeAlert({
    conditionKey,
    title,
    description,
    severity,
    // A trip during a live opening window is the one case worth interrupting
    // the owner for; everything else rides the digest — mirrors
    // check-bd-breaker.js's disposition rule exactly.
    disposition: severity === 'critical' ? 'human' : 'digest',
    cooldownHours: 6,
  });
  console.log(`Alert routed: ${severity} — ${title}`);
}

main().catch((err) => {
  console.error('check-sd-breaker.js failed:', err.message);
  process.exit(1);
});
