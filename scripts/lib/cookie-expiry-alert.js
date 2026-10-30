/**
 * T1 auth-cookie expiry -> Linear card (BRO-6628 item 2, from the BRO-6585 postmortem).
 *
 * The NYT subscriber cookies (NYT-S, nyt-a) were already expired on 2026-10-27.
 * check-cookie-health.js recorded it (run 40566004783 went red) but nothing reached
 * the owner or the board: the script's own Discord alert sets email:false, and the
 * workflow's "Notify on failure" only pages workflows on page-worthy-alerts.js
 * (cookie health is not one), so the NYT review was scored on paywall-truncated text.
 *
 * An expired (or about-to-expire) auth cookie for a T1 outlet now opens a Linear
 * card through routeAlert(disposition:'auto'), keyed per outlet so the router's
 * ledger files ONE card per incident, and resolves the condition when the cookie
 * is healthy again. Renewal itself is Mac-only (BRO-6590); this only files the card.
 */

'use strict';

// T1 outlets per CLAUDE.md scoring (NYT, Vulture, Variety). Only ones that have
// auth cookies can trip the expiry check; the rest are listed so a future config
// that adds authCookies to them is covered without touching this file.
const T1_COOKIE_OUTLETS = ['nytimes', 'vulture', 'variety'];

const CONDITION_PREFIX = 'cookie-health:t1-auth-expired:';
const conditionKeyFor = (outlet) => `${CONDITION_PREFIX}${outlet}`;

/**
 * PURE. Layer-2 results for T1 outlets whose auth cookies are expired or inside the
 * fail window (`authDays` is -1 when expired, else days left; null when unknown).
 */
function findT1AuthFailures(results, authErrorDays) {
  return (results || []).filter(r =>
    r && T1_COOKIE_OUTLETS.includes(r.name) &&
    r.layer === 2 && r.status === 'fail' &&
    typeof r.authDays === 'number' && r.authDays <= authErrorDays);
}

/** PURE. T1 outlets that were checked this run and are not failing on auth. */
function findT1AuthHealthy(results, authErrorDays) {
  const failing = new Set(findT1AuthFailures(results, authErrorDays).map(r => r.name));
  return (results || [])
    .filter(r => r && T1_COOKIE_OUTLETS.includes(r.name) && r.layer === 2 && !failing.has(r.name))
    .map(r => r.name);
}

/** PURE. The routeAlert() options for one failing outlet. */
function buildAlert(result) {
  const expired = result.authDays < 0;
  const when = expired ? 'are EXPIRED' : `expire in ${result.authDays}d`;
  return {
    conditionKey: conditionKeyFor(result.name),
    title: `${result.name} auth cookies ${when}: T1 reviews will score on paywall-truncated text`,
    description:
      `check-cookie-health.js found the ${result.name} subscriber auth cookies ${when}. ` +
      `${result.name} is a Tier 1 outlet, so until the cookies are refreshed its reviews are fetched ` +
      `behind the paywall and scored on truncated text (A Few Good Men press night, BRO-6585).\n\n` +
      `Check detail: ${result.message}\n\n` +
      `Cookie renewal is Mac-only (BRO-6590); do not try to renew it from CI or a cloud session. ` +
      `After the owner refreshes it, re-score any ${result.name} review collected since the cookie died.`,
    hint: 'Refresh on the Mac: python3 scripts/extract-safari-cookies.py --push (needs a fresh Safari login).',
    severity: 'error',
    disposition: 'auto',
    cooldownHours: 72,
  };
}

/**
 * Route one card per failing T1 outlet and resolve the conditions of healthy ones.
 * `deps` is injectable so tests exercise this real function without Linear.
 * Never throws: a routing failure must not mask the check's own exit code.
 */
async function routeT1CookieAlerts(results, authErrorDays, deps = {}) {
  const router = deps.routeAlert && deps.resolveCondition ? deps : require('./owner-alert-router');
  const { routeAlert, resolveCondition } = router;
  const log = deps.log || console;
  const out = { routed: [], resolved: [], errors: [] };

  for (const r of findT1AuthFailures(results, authErrorDays)) {
    try {
      await routeAlert(buildAlert(r));
      out.routed.push(r.name);
    } catch (e) {
      out.errors.push(`${r.name}: ${e.message}`);
      log.error(`[cookie-expiry-alert] could not route ${r.name}: ${e.message}`);
    }
  }
  for (const name of findT1AuthHealthy(results, authErrorDays)) {
    try {
      if (resolveCondition(conditionKeyFor(name), { reason: 'auth cookies healthy again' })) out.resolved.push(name);
    } catch (e) {
      out.errors.push(`${name}: ${e.message}`);
    }
  }
  return out;
}

module.exports = {
  T1_COOKIE_OUTLETS, CONDITION_PREFIX, conditionKeyFor,
  findT1AuthFailures, findT1AuthHealthy, buildAlert, routeT1CookieAlerts,
};
