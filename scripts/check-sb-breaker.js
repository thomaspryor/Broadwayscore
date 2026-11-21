#!/usr/bin/env node
/**
 * BRO-3010: hourly ScrapingBee daily circuit-breaker check — the SB twin of
 * check-sd-breaker.js. Lands in SHADOW mode: it records what it WOULD do
 * (wouldTripAt + 'sb-circuit-breaker-shadow' transition rows) and never sets
 * trippedAt, so scrapingbee-caps.js consultScrapingbee() cannot block.
 * SB_BREAKER_SHADOW=0 (repo variable) switches to enforcement, loosen-only:
 * see scripts/lib/scrapingbee-caps.js's header.
 *
 * Usage:
 *   node scripts/check-sb-breaker.js              # check, write state, alert on an enforced change
 *   node scripts/check-sb-breaker.js --dry-run    # print verdict only; no writes, no alerts
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log(`check-sb-breaker.js — hourly ScrapingBee daily-spend circuit breaker (BRO-3010)

  node scripts/check-sb-breaker.js              check, write state, alert on an enforced change
  node scripts/check-sb-breaker.js --dry-run    print verdict only (no writes, no alerts)

Env:
  SCRAPINGBEE_API_KEY                        required; without it the check no-ops
  SB_BREAKER_SHADOW                          '0' = enforce; anything else (default) = shadow (record, never block)
  SB_BREAKER_CEILING                         daily credit ceiling pin. Unset = plan fair share:
                                             (pack credits left at day start / days to renewal) x 1.5
  SB_BREAKER_BURST_FACTOR                    multiplier on the plan fair share (default 1.5)
  SB_OPENING_WINDOW_RESERVE_PER_SHOW_CREDITS per-show reserve for opening-window shows (default 3000)
  SB_BREAKER_STATE_PATH                      override the state file location (tests)
  SB_BREAKER_SHOWS_PATH                      override the shows.json read for the opening-window reserve (tests)
  PROVIDER_SPEND_DAILY_PATH                  override the daily provider-spend ledger read for the 14-day median
`);
  process.exit(0);
}

const fs = require('fs');
const path = require('path');

const caps = require('./lib/scrapingbee-caps');
const { utcDay, breakerAlertSeverity, effectiveCeilingForOpeningWindow } = require('./lib/brightdata-caps');
const { fetchSbUsage } = require('./lib/provider-billing');
const { topCallers, LEDGER_PATH } = require('./lib/provider-telemetry');
const { countShowsInOpeningWindow } = require('./lib/opening-night-selection');
const { recordTransitionSafely } = require('./lib/breaker-transitions');

const DRY_RUN = process.argv.includes('--dry-run');
const STATE_PATH = process.env.SB_BREAKER_STATE_PATH || caps.DEFAULT_STATE_PATH;
// SB_BREAKER_SHOWS_PATH: test seam, so the opening-window reserve does not
// depend on whatever data/shows.json the runner happens to hold.
const SHOWS_PATH = process.env.SB_BREAKER_SHOWS_PATH || path.join(__dirname, '..', 'data', 'shows.json');

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch { /* absent/corrupt → fresh state */ }
  return null;
}

function topSpenders(day) {
  try {
    const records = fs.readFileSync(LEDGER_PATH, 'utf8').split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const top = topCallers(records, day, 'scrapingbee', 3);
    if (!top.length) return 'no attributed SB calls in the ledger today';
    return top.map((t) => `${t.script} (${t.count})`).join(', ');
  } catch {
    return 'ledger unreadable';
  }
}

async function main() {
  const apiKey = process.env.SCRAPINGBEE_API_KEY;
  if (!apiKey) {
    console.log('SCRAPINGBEE_API_KEY not set — skipping breaker check (state left untouched)');
    return;
  }

  const day = utcDay(new Date());
  const prevState = loadState();
  const shadow = caps.resolveShadow();

  const usage = await fetchSbUsage(apiKey);
  const cycleUsed = usage ? usage.cycleUsed : null;
  const { dayCredits, status, reason, newState } = caps.computeTodayCredits({
    cycleUsed, day, prevState: prevState && prevState.day ? prevState : null,
  });

  const { ceiling, source: ceilingSource } = caps.resolveCeilingForDay({
    usage, day,
    dayBaseline: newState && Number.isFinite(newState.dayBaseline) ? newState.dayBaseline : null,
  });
  const reserveShows = countShowsInOpeningWindow(SHOWS_PATH, { lookbackDays: 1, lookAheadHours: 72 });
  const reservedCeiling = effectiveCeilingForOpeningWindow({
    ceiling, openingWindowShows: reserveShows,
    reservePerShow: caps.resolveOpeningWindowReservePerShowCredits(),
  });
  const median = caps.trailingMedianDayCredits(caps.loadDailySpendRows(), day);
  const decision = caps.enforcementDecision({
    shadow, ceiling: reservedCeiling,
    ceilingSource: reservedCeiling !== ceiling ? `${ceilingSource}+opening-window-reserve` : ceilingSource,
    median,
  });

  if (reason) console.warn(`  ⚠️  ${reason} — today is a baseline day (no trip)`);
  const planNote = usage && usage.cap != null ? `; pack ${usage.cap} credits, renews ${usage.renewalDate || 'unknown'}` : '';
  console.log(`scrapingbee: ${dayCredits == null ? `${status} (cycle ${cycleUsed ?? 'unknown'})` : `${dayCredits} credits today`} — `
    + `ceiling ${decision.effectiveCeiling} (${decision.ceilingSource}${planNote}); 14d median ${median ?? 'n/a'}; `
    + `${shadow ? 'SHADOW' : 'ENFORCED'} (${decision.reason})`);

  if (status === 'unknown') {
    console.log('  billing unknown — state left untouched');
    return;
  }

  const exhausted = caps.isPackExhausted(usage);
  const verdict = caps.shouldTripBreaker({ dayCredits, ceiling: decision.effectiveCeiling });
  // A pack already at its cap is not a runaway (SB lets a few credits past it).
  const wouldTrip = verdict.tripped && !exhausted;
  console.log(`  ${verdict.reason}${wouldTrip ? (decision.enforce ? ' → TRIPPED' : ' → would trip (shadow)') : ''}${verdict.tripped && exhausted ? ' (pack exhausted — not counted)' : ''}`);

  const wasEnforced = caps.isBreakerActive(prevState, day);
  const wasShadow = caps.isShadowActive(prevState, day);
  // A trip already recorded today stays tripped if the pack then runs out:
  // exhaustion suppresses NEW trips (not a runaway), it must not clear one.
  const enforcedTrip = decision.enforce && (wouldTrip || (exhausted && wasEnforced));
  const shadowTrip = wouldTrip || (exhausted && wasShadow);
  const nowIso = new Date().toISOString();

  const state = {
    ...newState,
    trippedAt: enforcedTrip ? ((wasEnforced && prevState.trippedAt) || nowIso) : null,
    wouldTripAt: shadowTrip ? ((wasShadow && prevState.wouldTripAt) || nowIso) : null,
    ceiling: decision.effectiveCeiling,
    ceilingSource: decision.ceilingSource,
    planCeiling: ceiling,
    median14d: median,
    shadow,
    enforce: decision.enforce,
    enforceReason: decision.reason,
    packExhausted: exhausted,
    dayCredits,
    status,
    updatedAt: nowIso,
  };

  if (DRY_RUN) {
    console.log('--dry-run: state not written, alerts not routed');
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + '\n');
  console.log(`Wrote ${STATE_PATH}`);

  // Per-day transition rows (BRO-3022 ledger; Sprint 3's audit and the 7-day
  // shadow review read them). Shadow rows use their own key so a shadow
  // would-trip is never counted as a real trip. Same placement rationale as
  // check-sd-breaker.js: above the no-change early return, idempotent per day.
  const conditionKey = decision.enforce ? 'sb-circuit-breaker' : 'sb-circuit-breaker-shadow';
  recordTransitionSafely({
    conditionKey,
    tripped: decision.enforce ? enforcedTrip : shadowTrip,
    wasActive: decision.enforce ? wasEnforced : wasShadow,
    day,
    units: dayCredits,
    ceiling: decision.effectiveCeiling,
    ceilingSource: decision.ceilingSource,
  });

  // Shadow never alerts, and no enforced trip can be open while in shadow:
  // resolve any sb-circuit-breaker incident (a no-op when none is open). Not
  // keyed on wasEnforced, which is day-scoped and misses a trip from an
  // earlier UTC day (BRO-5261).
  if (!decision.enforce) {
    const { resolveCondition } = require('./lib/owner-alert-router');
    if (resolveCondition('sb-circuit-breaker')) console.log('Enforcement off (shadow) — open sb-circuit-breaker incident resolved.');
    return;
  }
  if (enforcedTrip === wasEnforced) {
    // Same rollover gap: an earlier day's trip never reaches the cleared branch.
    if (!enforcedTrip) {
      const { resolveCondition } = require('./lib/owner-alert-router');
      if (resolveCondition('sb-circuit-breaker')) console.log('Not tripped — stale open incident from an earlier day resolved.');
    }
    console.log('No breaker state change — no alert.');
    return;
  }
  const openingWindowShows = countShowsInOpeningWindow(SHOWS_PATH);
  const { routeAlert, resolveCondition } = require('./lib/owner-alert-router');
  if (!enforcedTrip) {
    const resolved = resolveCondition('sb-circuit-breaker');
    console.log(`Breaker cleared (${dayCredits}/${decision.effectiveCeiling})${resolved ? ' — open incident resolved' : ''}`);
    return;
  }
  const severity = breakerAlertSeverity({ tripped: true, openingWindowShows });
  const title = `ScrapingBee daily breaker TRIPPED: ${dayCredits}/${decision.effectiveCeiling} credits`;
  await routeAlert({
    conditionKey: 'sb-circuit-breaker',
    title,
    description: [
      `ScrapingBee billed ${dayCredits} credits today against a ceiling of ${decision.effectiveCeiling} (${decision.ceilingSource}).`,
      'Bulk ScrapingBee page/SERP calls are now skipped for the rest of the UTC day (SB is the last paid tier: Playwright/Browserbase or nothing); opening-night flows keep their exemption.',
      `Top attributed SB callers today: ${topSpenders(day)}.`,
    ].join('\n'),
    severity,
    disposition: severity === 'critical' ? 'human' : 'digest',
    cooldownHours: 6,
  });
  console.log(`Alert routed: ${severity} — ${title}`);
}

main().catch((err) => {
  console.error('check-sb-breaker.js failed:', err.message);
  process.exit(1);
});
