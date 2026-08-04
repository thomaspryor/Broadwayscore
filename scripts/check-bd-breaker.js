#!/usr/bin/env node
/**
 * S2-T2 (Scraping cost v3, card 3b1637c5): hourly Bright Data circuit-breaker
 * check.
 *
 * Asks Bright Data's OWN billing API how many requests each zone has billed
 * today and writes data/audit/bd-circuit-breaker.json when a zone is over its
 * daily ceiling. scripts/lib/brightdata-caps.js consults that file inside the
 * two BD chokepoints, so a runaway sweep stops billing within the hour.
 *
 * Why billing and not our ledger: the plan review was unanimous (5 of 6) that a
 * ledger-counted cap is a P0 — data/audit/scraper-spend-ledger.jsonl is written
 * by many concurrent CI writers (read-modify-write race, task #788) and only
 * ~1% of BD SERP calls carry attribution at all, so a ledger-based counter
 * would undercount so badly it would never trip. The ledger is used HERE only
 * for the human-readable "which scripts are spending" line in the alert.
 *
 * Usage:
 *   node scripts/check-bd-breaker.js              # check, write state, alert on change
 *   node scripts/check-bd-breaker.js --dry-run    # print verdicts only; no writes, no alerts
 *   BD_BREAKER_CEILING=1 node scripts/check-bd-breaker.js   # forced-low test (S2-T8)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const {
  resolveDailyCeiling,
  shouldTripBreaker,
  isBreakerActiveForZone,
  breakerAlertSeverity,
  utcDay,
} = require('./lib/brightdata-caps');
const { fetchBdZoneCostDay } = require('./lib/provider-billing');
const { topCallers, LEDGER_PATH } = require('./lib/provider-telemetry');
const { selectOpeningNightShows } = require('./lib/opening-night-selection');

const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(`check-bd-breaker.js — hourly Bright Data daily-spend circuit breaker

  node scripts/check-bd-breaker.js              check both zones, write state, alert on change
  node scripts/check-bd-breaker.js --dry-run    print verdicts only (no writes, no alerts)

Env:
  BRIGHTDATA_TOKEN         required; without it the check no-ops
  BD_BREAKER_CEILING       per-zone daily request ceiling (default 3500)
  BD_BREAKER_STATE_PATH    override the state file location (tests)
`);
  process.exit(0);
}

const DRY_RUN = process.argv.includes('--dry-run');
const STATE_PATH = process.env.BD_BREAKER_STATE_PATH
  || path.join(__dirname, '..', 'data', 'audit', 'bd-circuit-breaker.json');
const SHOWS_PATH = path.join(__dirname, '..', 'data', 'shows.json');

/**
 * Shows whose opening-night discovery is live right now. Used ONLY for alert
 * severity — the carve-out itself is enforced in brightdata-caps.js, not here.
 * lookbackDays 3 (not the selection default 21) because the question is "is the
 * poller hammering BD for a show tonight", not "did a show open this month".
 */
function countShowsInOpeningWindow() {
  try {
    const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8'));
    const list = Array.isArray(shows) ? shows : shows.shows || [];
    return selectOpeningNightShows(list, { lookbackDays: 3 }).length;
  } catch {
    // Unknown → treated as "no active window" for severity only. A missing
    // shows.json must never change whether the breaker trips.
    return 0;
  }
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.zones) return parsed;
  } catch { /* absent/corrupt → fresh state */ }
  return { zones: {} };
}

function topSpenders(day) {
  try {
    const lines = fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean);
    const records = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const top = topCallers(records, day, 'brightdata', 3);
    if (!top.length) return 'no attributed BD calls in the ledger today';
    return top.map((t) => `${t.script} (${t.count})`).join(', ');
  } catch {
    return 'ledger unreadable';
  }
}

async function main() {
  const token = process.env.BRIGHTDATA_TOKEN;
  if (!token) {
    console.log('BRIGHTDATA_TOKEN not set — skipping breaker check (state left untouched)');
    return;
  }

  const day = utcDay(new Date());
  const ceiling = resolveDailyCeiling();
  const zones = [
    process.env.BRIGHTDATA_ZONE || 'web_unlocker2',
    process.env.BRIGHTDATA_SERP_ZONE || 'serp_api1',
  ];

  const state = loadState();
  const changes = [];

  for (const zone of zones) {
    const prev = state.zones[zone];
    const wasActive = isBreakerActiveForZone(state, { zone, day });
    const billing = await fetchBdZoneCostDay(zone, day, token);
    const billedReqs = billing ? billing.reqs : null;
    const verdict = shouldTripBreaker({ billedReqs, ceiling });

    console.log(`${zone}: ${billedReqs == null ? 'billing unknown' : `${billedReqs} reqs`}`
      + `${billing ? ` / $${billing.cost.toFixed(2)}` : ''} — ${verdict.reason}`
      + `${verdict.tripped ? ' → TRIPPED' : ''}`);

    if (billedReqs == null) {
      // Unknown is not "under". Leave any existing trip in place rather than
      // clearing the cap because the billing API blipped (fail-closed on the
      // CLEAR side, fail-open on the TRIP side — provider-billing.js's rule).
      continue;
    }

    // Preserve the ORIGINAL trip timestamp across hourly re-checks of the same
    // day; a fresh stamp every hour would make "how long has this been capped"
    // unanswerable in the audit trail.
    const trippedAt = verdict.tripped
      ? (wasActive && prev.trippedAt) || new Date().toISOString()
      : null;
    state.zones[zone] = { day, trippedAt, billedReqs, ceiling, cost: billing.cost };
    if (verdict.tripped !== wasActive) {
      changes.push({ zone, tripped: verdict.tripped, billedReqs, ceiling });
    }
  }

  state.updatedAt = new Date().toISOString();

  if (DRY_RUN) {
    console.log('--dry-run: state not written, alerts not routed');
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  console.log(`Wrote ${STATE_PATH}`);

  if (!changes.length) {
    console.log('No breaker state change — no alert.');
    return;
  }

  const openingWindowShows = countShowsInOpeningWindow();
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');
  for (const change of changes) {
    const conditionKey = `bd-circuit-breaker-${change.zone}`;

    // Recovery is not news. Resolving the condition (rather than routing a
    // second "all clear" line) clears the cooldown so the NEXT trip notifies
    // immediately, without spending a digest line on a non-event.
    if (!change.tripped) {
      const resolved = resolveCondition(conditionKey);
      console.log(`Breaker cleared for ${change.zone} (${change.billedReqs}/${change.ceiling})${resolved ? ' — open incident resolved' : ''}`);
      continue;
    }

    const severity = breakerAlertSeverity({ tripped: change.tripped, openingWindowShows });
    const title = change.tripped
      ? `Bright Data daily breaker TRIPPED: ${change.zone} (${change.billedReqs}/${change.ceiling} reqs)`
      : `Bright Data daily breaker cleared: ${change.zone}`;
    const description = change.tripped
      ? [
        `Zone ${change.zone} billed ${change.billedReqs} requests today against a ceiling of ${change.ceiling}.`,
        `Bulk Bright Data calls are now skipped for the rest of the UTC day; opening-night flows keep their own allowance.`,
        openingWindowShows > 0
          ? `${openingWindowShows} show(s) are in an active opening window — bulk review collection for them is capped.`
          : 'No show is in an active opening window.',
        `Top attributed BD callers today: ${topSpenders(day)}.`,
      ].join('\n')
      : `Zone ${change.zone} is back under its ${change.ceiling}-request daily ceiling (${change.billedReqs} today).`;

    await routeAlert({
      conditionKey,
      title,
      description,
      severity,
      // A trip during a live opening window is the one case worth interrupting
      // the owner for; everything else rides the digest (owner rule: no email
      // unless it is urgent AND actionable). Note this key is NOT on
      // page-worthy-alerts.js, so 'human' is currently downgraded to a digest
      // line by the card #611 gate — deliberately: promoting it to a real page
      // is the owner's call, and the router logs the downgrade either way.
      disposition: severity === 'critical' ? 'human' : 'digest',
      cooldownHours: 6,
    });
    console.log(`Alert routed: ${severity} — ${title}`);
  }
}

main().catch((err) => {
  console.error('check-bd-breaker.js failed:', err.message);
  process.exit(1);
});
