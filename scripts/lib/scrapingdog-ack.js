/**
 * Expiring acknowledgment for the known ScrapingDog burn-rate spike (task
 * #418). Root cause: ScrapingBee exhausted its 1M monthly credits ~2026-07-22
 * (card #224, acknowledged in scripts/lib/scrapingbee-ack.js), so the SB
 * tier's entire load falls through to ScrapingDog per the fetchPage/fetchJSON
 * chain — inflating SD's projected "exhausts BEFORE renewal" math. SB resets
 * 2026-08-05 and reabsorbs its share before SD's projected ~08-07 exhaustion.
 *
 * Mirrors scripts/lib/scrapingbee-ack.js (npm-audit-allowlist posture): the
 * daily health check keeps REPORTING the burn (status 'warn', message carries
 * the ack reason) but stops erroring/emailing for a condition that is known,
 * tracked, and needs no action until the expiry forces re-triage.
 *
 * Scope guard — this acknowledges ONLY the burn-rate PROJECTION, and only
 * while it still looks like the acknowledged fallthrough rather than a live
 * incident (ship-check 2026-07-26): an actually exhausted balance
 * (remaining <= 0), a nearly-dry balance (<= 5% left), or an exhaustion
 * projected within 3 days all stay 'error' regardless of the ack — a runaway
 * job or compromised key accelerates the projection into that window and
 * un-hides itself.
 */

'use strict';

const SCRAPINGDOG_ACKNOWLEDGED_BURN = {
  reason: 'Burn spike is ScrapingBee-exhaustion fallthrough (card #224) — SB resets 2026-08-05 and reabsorbs its load. Re-triage if burn stays >30k/day after reset.',
  expires: '2026-08-06',
};

function isScrapingdogBurnAcknowledged(today) {
  const todayDate = today || new Date().toISOString().slice(0, 10);
  return SCRAPINGDOG_ACKNOWLEDGED_BURN.expires > todayDate;
}

/**
 * Pure credit-status decision for the health check (extracted per CLAUDE.md
 * §15 so the ack downgrade is testable without running health-check.js, which
 * sends real alerts). Mirrors the ScrapingBee block's shape in health-check.js.
 *
 * @param {{requestLimit:number, requestUsed:number, validity?:number}} acct
 * @param {string} [today] YYYY-MM-DD override for tests
 * @returns {{status:'pass'|'warn'|'error', message:string}}
 */
function evaluateScrapingdogCredits(acct, today) {
  // Contract guard (ship-check 2026-07-26): a malformed account response
  // (missing/non-numeric fields) previously produced NaN math that fell
  // through as a quiet 'pass'. Surface it as the same 'warn' the caller uses
  // for an unexpected response instead.
  if (!acct || !Number.isFinite(acct.requestLimit) || acct.requestLimit <= 0
      || !Number.isFinite(acct.requestUsed) || acct.requestUsed < 0) {
    return { status: 'warn', message: `Unexpected account response: ${JSON.stringify(acct ?? null).slice(0, 80)}` };
  }
  const remaining = acct.requestLimit - acct.requestUsed;
  const pctRemaining = Math.round((remaining / acct.requestLimit) * 100);
  // Sanitize validity too (codex re-review): a negative or non-finite value
  // (API glitch) must take the no-validity pct-threshold path, not feed the
  // projection math with a nonsense renewal horizon.
  const daysToRenewal = (typeof acct.validity === 'number' && Number.isFinite(acct.validity) && acct.validity >= 0)
    ? acct.validity : null;
  let msg = `${Math.round(remaining / 1000)}k credits left (${pctRemaining}%)`;
  let status = 'pass';
  if (daysToRenewal !== null) {
    const daysIntoCycle = Math.max(1, 30 - daysToRenewal);
    const dailyBurn = acct.requestUsed / daysIntoCycle;
    const daysUntilExhaustion = dailyBurn > 0 ? remaining / dailyBurn : Infinity;
    msg += ` · ${Math.round(dailyBurn / 1000)}k/day burn · renews in ${daysToRenewal}d`;
    if (remaining <= 0) { status = 'error'; msg += ' · EXHAUSTED'; }
    else if (daysUntilExhaustion < daysToRenewal) {
      // Acknowledged burn spike (SB-exhaustion fallthrough, task #418):
      // downgrade ONLY a non-imminent projection to 'warn'. Near-dry (<=5%)
      // or exhausting within 3 days stays 'error' even while acknowledged —
      // that is a live incident shape, not the acknowledged fallthrough
      // (ship-check 2026-07-26, both reviewers).
      if (isScrapingdogBurnAcknowledged(today) && pctRemaining > 5 && daysUntilExhaustion >= 3) {
        status = 'warn';
        msg += ` · exhausts in ~${Math.round(daysUntilExhaustion)}d (BEFORE renewal) — acknowledged: ${SCRAPINGDOG_ACKNOWLEDGED_BURN.reason} [expires ${SCRAPINGDOG_ACKNOWLEDGED_BURN.expires}]`;
      } else {
        status = 'error'; msg += ` · exhausts in ~${Math.round(daysUntilExhaustion)}d (BEFORE renewal)`;
      }
    }
    else if (pctRemaining <= 15) { status = 'warn'; }
  } else if (pctRemaining <= 5) { status = 'error'; }
  else if (pctRemaining <= 15) { status = 'warn'; }
  return { status, message: msg };
}

/**
 * Runtime routing decision for scraper.js's SD pre-check: should fetchPage
 * skip ScrapingDog for the rest of this run?
 *
 * Trips ONLY on actual exhaustion (remaining <= 0), where skipping saves a
 * doomed HTTP round-trip per call. It must NOT trip on the pace projection:
 * SD credits are PREPAID and expire at renewal, so "pacing" the pool by
 * rerouting to Bright Data (~$1.50/1k) while 87% of the paid-for credits
 * (~$0.09-0.45/1k) sit unused is strictly more expensive — that projection
 * math routed every request to BD for days and triggered the 2026-07-26
 * $50 auto-recharge incident. Pace projections belong to health-check.js
 * (evaluateScrapingdogCredits above), which alerts; routing never pre-pays.
 *
 * @param {{requestLimit:number, requestUsed:number, validity?:number}} acct
 * @returns {{skip: boolean, logLine: string|null}}
 */
function shouldSkipScrapingdogAtRuntime(acct) {
  // Fail open on malformed responses — the pre-check must never block scraping.
  if (!acct || !Number.isFinite(acct.requestLimit) || acct.requestLimit <= 0
      || !Number.isFinite(acct.requestUsed) || acct.requestUsed < 0) {
    return { skip: false, logLine: null };
  }
  const remaining = acct.requestLimit - acct.requestUsed;
  if (remaining <= 0) {
    return {
      skip: true,
      logLine: `Scrapingdog account exhausted (${acct.requestUsed}/${acct.requestLimit}) — routing to BD/SB for the rest of this run`,
    };
  }
  const daysToRenewal = (typeof acct.validity === 'number' && Number.isFinite(acct.validity) && acct.validity >= 0)
    ? acct.validity : null;
  if (daysToRenewal !== null) {
    const daysIntoCycle = Math.max(1, 30 - daysToRenewal);
    const dailyBurn = acct.requestUsed / daysIntoCycle;
    const daysUntilExhaustion = dailyBurn > 0 ? remaining / dailyBurn : Infinity;
    if (daysUntilExhaustion < daysToRenewal) {
      return {
        skip: false,
        logLine: `Scrapingdog pace (~${Math.round(dailyBurn)}/day) projects exhaustion in ~${Math.round(daysUntilExhaustion)}d, before the ${daysToRenewal}d-out renewal — still using SD (prepaid credits beat BD's ~17x cost); health-check tracks the burn`,
      };
    }
  }
  return { skip: false, logLine: null };
}

/**
 * Is this HTTP status from the SD /scrape endpoint the out-of-credits/auth
 * shape? Mirrors fetchWithScrapingBee's 401/403/429 reactive latch: the
 * once-per-process /account pre-check can't see credits hitting 0 mid-run
 * (ship-check 2026-07-26, both reviewers), so the scrape response itself must
 * trip the breaker. 400 is deliberately excluded — Scrapingdog uses it for
 * "host needs premium/stealth", which fetchJSON escalates on (task #203).
 */
function isSdQuotaHttpStatus(status) {
  return [401, 403, 429].includes(Number(status));
}

module.exports = { SCRAPINGDOG_ACKNOWLEDGED_BURN, isScrapingdogBurnAcknowledged, evaluateScrapingdogCredits, shouldSkipScrapingdogAtRuntime, isSdQuotaHttpStatus };
