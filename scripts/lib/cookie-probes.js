/**
 * Walled-article probes: one definition per outlet of "a URL whose full body
 * only renders for a logged-in subscriber", shared by check-cookie-health.js
 * (Layer 3), verify-cookie-login.js and renew-cookies.js so the three can't
 * drift apart (BRO-4183).
 *
 * Why a probe needs a zero-cookie control: The Stage's old probe (a 2023
 * A Doll's House review) serves its full 2,962-char body to anonymous
 * visitors (re-verified 2026-09-27), so the health check reported "logged
 * in" while every recent walled review returned 0 chars. A probe is only
 * meaningful if the SAME URL fails without cookies. classifyWalledProbe()
 * reports 'vacuous' when it doesn't, so a probe URL that ages out of the
 * wall surfaces as a warning instead of a silent pass.
 */

'use strict';

const COOKIE_PROBES = {
  thestage: {
    // Recent (2026) review behind the free-registration wall. Anonymous
    // fetch: 0 body chars; subscriber: 1500+.
    url: 'https://www.thestage.co.uk/reviews/now-you-see-me-live-review-london-coliseum-tim-lawson-simon-painter',
    minBody: 1200,
    wallMarker: /THIS IS NOT A PAYWALL/i,
  },
};

/**
 * @param {object} p
 * @param {{body: string, html: string}|null} p.withCookies
 * @param {{body: string, html: string}|null} [p.withoutCookies] - control
 *   fetch; omit to skip the vacuous check
 * @param {number} p.minBody
 * @param {RegExp} [p.wallMarker]
 * @returns {'logged-in'|'logged-out'|'vacuous'|'error'}
 */
function classifyWalledProbe({ withCookies, withoutCookies, minBody, wallMarker }) {
  const passes = (r) => !!r
    && (r.body || '').length >= minBody
    && !(wallMarker && wallMarker.test(r.html || ''));

  if (withoutCookies && passes(withoutCookies)) return 'vacuous';
  if (!withCookies || typeof withCookies.html !== 'string' || withCookies.html.length === 0) return 'error';
  return passes(withCookies) ? 'logged-in' : 'logged-out';
}

module.exports = { COOKIE_PROBES, classifyWalledProbe };
