/**
 * SERP burst cascade-tripwire notification (BRO-2438 finding 2 extraction).
 *
 * Split out of opening-night-poller.js's inline if-block per CLAUDE.md rule
 * 15 (extract pure decision logic to scripts/lib/, require() the real thing
 * in tests instead of re-implementing it there) so the write-after-notify
 * fix is directly testable: tripwireAlerted must be persisted only AFTER
 * routeAlert() resolves with a real delivery, never before. Writing it
 * before the alert was the exact write-first/notify-second anti-pattern
 * BRO-1699 removed from opening-night-broadcast.yml (see that workflow's
 * NOTE at the overdue-alert step) — if sendAlert() fails (missing
 * RESEND_API_KEY, Resend 5xx), routeAlert() deliberately leaves the
 * condition un-notified so the NEXT call retries; persisting
 * tripwireAlerted anyway would have gated that retry until the UTC-day
 * ledger rollover with the owner never paged about a runaway SERP burst.
 */

const { isCascadeTripwireExceeded } = require('./serp-burst-caps');

/**
 * @param {object} params
 * @param {object} params.ledger - the SERP burst ledger object (mutated in place on success, matching writeSerpBurstLedger's expected shape)
 * @param {object} params.config - DEFAULT_SERP_BURST_CONFIG (or override)
 * @param {Function} params.routeAlert - owner-alert-router's routeAlert
 * @param {Function} params.writeSerpBurstLedger - persists the ledger
 * @param {Function} [params.log] - injectable for tests; defaults to console.log
 * @returns {Promise<{fired: boolean, delivered?: boolean, error?: string}>}
 */
async function maybeAlertSerpBurstTripwire({ ledger, config, routeAlert, writeSerpBurstLedger, log = console.log }) {
  if (!isCascadeTripwireExceeded(ledger.globalBursts, config) || ledger.tripwireAlerted) {
    return { fired: false };
  }
  const msg =
    `${ledger.globalBursts} WE opening-night SERP bursts today ` +
    `(tripwire ${config.cascadeTripwire}, hard daily cap ${config.dailyGlobalCap}). ` +
    `Bursts auto-stop at the cap; this is an early heads-up. ` +
    `Emergency off: gh variable set DISABLE_WE_SERP_BURST --body true`;
  log(`::warning::SERP burst cascade tripwire: ${msg}`);
  try {
    const alertResult = await routeAlert({
      conditionKey: 'serp-burst:tripwire',
      title: 'WE SERP burst tripwire',
      description: msg,
      // 'error': same-day actionable — the 60-100K credits/day runaway
      // class (feedback_sb_serp_invisible_burn); the daily digest is up
      // to 24h late. warning would be suppressed (actionable-only policy).
      severity: 'error',
      disposition: 'human',
      cooldownHours: 1,
    });
    if (alertResult.delivered !== false) {
      ledger.tripwireAlerted = true;
      writeSerpBurstLedger(ledger);
      return { fired: true, delivered: true };
    }
    return { fired: true, delivered: false };
  } catch (e) {
    log(`  [SERP burst] tripwire alert failed (non-fatal): ${e.message}`);
    return { fired: true, delivered: false, error: e.message };
  }
}

module.exports = { maybeAlertSerpBurstTripwire };
