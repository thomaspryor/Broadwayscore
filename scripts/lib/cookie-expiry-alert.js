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

// Legacy prefix name kept so incidents already open under it still resolve;
// since BRO-7079 it covers every critical outlet, not only T1.
const CONDITION_PREFIX = 'cookie-health:t1-auth-expired:';
const LIVE_CONDITION_PREFIX = 'cookie-health:live-access-failed:';
// Expiry and live-access failures keep separate keys, so a run without the
// live check (healthy expiry only) never closes a live-failure card.
const conditionKeyFor = (outlet, live = false) => `${live ? LIVE_CONDITION_PREFIX : CONDITION_PREFIX}${outlet}`;

// BRO-5628 (via BRO-7079): The Stage's login cookie died before the De
// Profundis opening and the only trace was a stub at ingest; a WSJ cookie had
// the same gap. Every CRITICAL_OUTLETS entry in check-cookie-health.js (it
// marks those results isCritical) now files a card, T1 or not, and a Layer-3
// live-access failure (logged out, paywalled, body too short) counts too.
const isWatched = r => r && (T1_COOKIE_OUTLETS.includes(r.name) || r.isCritical === true);
const isAuthExpiry = (r, authErrorDays) => r.layer === 2 && r.status === 'fail'
  && typeof r.authDays === 'number' && r.authDays <= authErrorDays;
// An outlet that needs no cookies (nypost, THR) failing live is an extractor
// or block problem, not a cookie one, so it files no cookie card.
const isLiveFailure = r => r.layer === 3 && r.status === 'fail' && !r.noCookiesRequired;

/**
 * PURE. One failing result per watched outlet: an auth expiry inside the fail
 * window (`authDays` -1 when expired, else days left) or a live-access failure.
 * An outlet failing both ways reports the auth expiry, the more specific cause.
 */
function findCookieFailures(results, authErrorDays) {
  const byName = new Map();
  for (const r of results || []) {
    if (!isWatched(r)) continue;
    const auth = isAuthExpiry(r, authErrorDays);
    if (!auth && !isLiveFailure(r)) continue;
    if (!byName.has(r.name) || auth) byName.set(r.name, r);
  }
  return [...byName.values()];
}

/**
 * PURE. Watched outlets with positive evidence of health this run and no
 * failure: an auth expiry actually read (missing cookies, authDays null, prove
 * nothing) or a passing live check.
 */
function findCookieHealthy(results, authErrorDays) {
  const failing = new Set(findCookieFailures(results, authErrorDays).map(r => `${r.name}|${r.layer === 3}`));
  const healthy = new Map();
  for (const r of results || []) {
    if (!isWatched(r)) continue;
    const live = r.layer === 3;
    if (failing.has(`${r.name}|${live}`)) continue;
    if ((r.layer === 2 && typeof r.authDays === 'number') || (live && r.status === 'pass' && !r.noCookiesRequired)) {
      healthy.set(`${r.name}|${live}`, { name: r.name, live });
    }
  }
  return [...healthy.values()];
}

/** PURE. The routeAlert() options for one failing outlet. */
function buildAlert(result) {
  const t1 = T1_COOKIE_OUTLETS.includes(result.name);
  const live = result.layer === 3;
  const expired = !live && result.authDays < 0;
  const when = live ? 'fail the live access check' : expired ? 'are EXPIRED' : `expire in ${result.authDays}d`;
  const what = live ? 'login cookies' : 'auth cookies';
  return {
    conditionKey: conditionKeyFor(result.name, live),
    title: `${result.name} ${what} ${when}: ${t1 ? 'T1 ' : ''}reviews will score on paywall-truncated text`,
    description:
      `check-cookie-health.js found the ${result.name} ${what} ${when}. ` +
      `Until they are refreshed its reviews are fetched behind the paywall and saved as stubs or ` +
      `truncated text (A Few Good Men press night, BRO-6585; The Stage on De Profundis, BRO-5628).\n\n` +
      `Check detail: ${result.message}\n\n` +
      `Cookie renewal is Mac-only (BRO-6590); do not try to renew it from CI or a cloud session. ` +
      `After the owner refreshes it, re-score any ${result.name} review collected since the cookie died.`,
    hint: 'Refresh on the Mac: python3 scripts/extract-safari-cookies.py --push (needs a fresh Safari login).',
    // A live check can fail on a site hiccup, so only a T1 cookie actually
    // read as expired pages at error level.
    severity: t1 && !live ? 'error' : 'warn',
    disposition: 'auto',
    cooldownHours: 72,
  };
}

/**
 * Route one card per failing watched outlet and resolve the conditions of healthy ones.
 * `deps` is injectable so tests exercise this real function without Linear.
 * Never throws: a routing failure must not mask the check's own exit code.
 */
async function routeCookieAlerts(results, authErrorDays, deps = {}) {
  const router = deps.routeAlert && deps.resolveCondition ? deps : require('./owner-alert-router');
  const { routeAlert, resolveCondition } = router;
  const log = deps.log || console;
  const out = { routed: [], resolved: [], errors: [] };

  for (const r of findCookieFailures(results, authErrorDays)) {
    try {
      const res = await routeAlert(buildAlert(r));
      if (res && res.ok === false) throw new Error(res.error || res.reason || 'routeAlert returned ok:false');
      out.routed.push(r.name);
    } catch (e) {
      out.errors.push(`${r.name}: ${e.message}`);
      log.error(`[cookie-expiry-alert] could not route ${r.name}: ${e.message}`);
    }
  }
  for (const { name, live } of findCookieHealthy(results, authErrorDays)) {
    try {
      if (resolveCondition(conditionKeyFor(name, live), { reason: 'cookies healthy again' })) out.resolved.push(name);
    } catch (e) {
      out.errors.push(`${name}: ${e.message}`);
    }
  }
  return out;
}

module.exports = {
  T1_COOKIE_OUTLETS, CONDITION_PREFIX, LIVE_CONDITION_PREFIX, conditionKeyFor,
  findCookieFailures, findCookieHealthy, buildAlert, routeCookieAlerts,
};
