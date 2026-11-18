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
    // Positive "this is the logged-out registration gate" signal, present in
    // the server HTML of the anonymous page ("create a free account to read
    // 5 free articles", linked with utm_source=Reggate; verified 2026-09-27).
    // A short page WITHOUT it is not a wall we recognise (Cloudflare
    // challenge, maintenance page, redesign), so the probe is 'error' and
    // renew-cookies.js will not log in on it.
    gateMarker: /utm_source=Reggate/i,
  },
  // BRO-7171: browser-only. Akamai answers a plain fetch (and headless
  // Chrome) with its "Access Issue Help" block page (HTTP 402, TollBit), so
  // renew-cookies.js probes this one inside the persistent profile (headless
  // for --probe-only: Akamai serves the article to headless Chrome)
  // (browserOnly), with the gap adapter's body extractor (extractBody) and
  // the same walled url as the adapter's auth probe. Logged out: 168-char
  // teaser under martech-paywall__blur (2026-11-10).
  telegraph: {
    url: 'https://www.telegraph.co.uk/theatre/what-to-see/romeo-and-juliet-review-sadie-sink-noah-jupe/',
    minBody: 1500,
    // In a class attribute only, never a script/CSS bundle mention.
    wallMarker: /class="[^"]*martech-paywall__blur/i,
    gateMarker: /martech-paywall__blur|data-js="martech-paywall"|martech-regwall/i,
    browserOnly: true,
    extractBody: (html) => require('./browser-outlet-adapters').extractTelegraphBody(html),
  },
  // BRO-7705 probes. Every number below was measured live on 2026-11-17 on
  // the SAME url with the subscriber session and with none (the control), so
  // none of them is vacuous the way the old ones were:
  //   nytimes   fetch 6170 vs anon 2904 (the old 1500 floor passed anon!)
  //   wapo      fetch 6589 vs anon 309; browser 8067 vs 1314
  //   newyorker fetch serves the full 8474 chars to anyone (paywall is
  //             client-side), browser 8474 vs anon 645 -> browser probe
  //   ft        plain fetch = 403 "Security Verification"; browser 3035 vs
  //             a 2312-char "Subscribe to read" page (the old 1200 floor
  //             passed it) -> browser probe + title wall marker
  //   thetimes  plain fetch = "Verifying Device"; browser 2775 vs 0
  //
  // loginWallMarker: the wall as a real browser renders it for a visitor with
  // no session (in the anonymous page, absent from the subscriber page;
  // measured 2026-11-17). renew-cookies.js adopts cookies or logs in only
  // when a slower re-load shows this marker, so a blank render, 404,
  // consent overlay or redesign never starts a login (BRO-7705 ship-check).
  nytimes: {
    url: 'https://www.nytimes.com/2026/04/22/theater/beaches-review-broadway.html',
    minBody: 4500,
    loginWallMarker: /gateway-content|regiwall|lready a subscriber/i,
    // The cookie-less control gets a DataDome HTTP 403 on every run
    // (BRO-7765, measured 2026-11-18), so vacuity can never be measured
    // in-browser. The block is itself evidence the article is not served free
    // to an anonymous visitor; the in-profile body must still pass minBody.
    controlBlockedIsWalled: true,
  },
  wapo: {
    url: 'https://www.washingtonpost.com/entertainment/theater/2025/09/29/masquerade-phantom-review/',
    minBody: 4000,
    loginWallMarker: /paywall-overlay|subs-turnstile-hook-wall|lready a subscriber/i,
  },
  newyorker: {
    url: 'https://www.newyorker.com/magazine/2023/03/20/dolls-house-review-broadway-jessica-chastain',
    minBody: 4000,
    browserOnly: true,
    loginWallMarker: /InContentBarrier|JOURNEY_PAYWALL/,
  },
  ft: {
    url: 'https://www.ft.com/content/681beb68-5155-11df-bed9-00144feab49a',
    minBody: 2000,
    wallMarker: /<title>[^<]*Subscribe to (?:read|unlock)/i,
    browserOnly: true,
    loginWallMarker: /<title>[^<]*Subscribe to (?:read|unlock)/i,
  },
  thetimes: {
    url: 'https://www.thetimes.com/culture/theatre-dance/article/1536-review-theatre-henry-viii-anne-boleyn-v6hg7frjb',
    minBody: 1500,
    browserOnly: true,
    loginWallMarker: /zephr-paywall/,
  },
};

/**
 * @param {object} p
 * @param {{body: string, html: string}|null} p.withCookies
 * @param {{body: string, html: string}|null} [p.withoutCookies] - control
 *   fetch; omit to skip the vacuous check
 * @param {number} p.minBody
 * @param {RegExp} [p.wallMarker] - present => logged out
 * @param {RegExp} [p.gateMarker] - when given, a failing page must show it
 *   to count as 'logged-out'; otherwise the page is unrecognised => 'error'
 * @returns {'logged-in'|'logged-out'|'vacuous'|'error'}
 */
function classifyWalledProbe({ withCookies, withoutCookies, minBody, wallMarker, gateMarker }) {
  const passes = (r) => !!r
    && (r.body || '').length >= minBody
    && !(wallMarker && wallMarker.test(r.html || ''));
  const recognisedGate = (r) => !gateMarker || gateMarker.test(r.html || '');

  // A bot interstitial says nothing about the login on either side: never
  // 'logged-out' (that would start a login), never 'vacuous' (BRO-7705).
  if ((withCookies && isBotChallenge(withCookies.html)) || (withoutCookies && isBotChallenge(withoutCookies.html))) return 'error';
  if (withoutCookies && passes(withoutCookies)) return 'vacuous';
  if (withoutCookies && !recognisedGate(withoutCookies)) return 'error';
  if (!withCookies || typeof withCookies.html !== 'string' || withCookies.html.length === 0) return 'error';
  if (passes(withCookies)) return 'logged-in';
  return recognisedGate(withCookies) ? 'logged-out' : 'error';
}

// Anti-bot interstitials (DataDome, Cloudflare, The Times' "Verifying
// Device"). A page like this says nothing about the login: re-logging in
// cannot clear it, so callers must not report it as logged-out (2026-10-18:
// The Times and WSJ challenges were sending the owner to re-login in Safari).
const BOT_CHALLENGE_RE = /captcha-delivery\.com|<title>\s*(?:Verifying Device|Just a moment\.\.\.|Security Verification)\s*<\/title>|Access is temporarily restricted|slide right to secure/i;

function isBotChallenge(html) {
  return BOT_CHALLENGE_RE.test(String(html || ''));
}

module.exports = { COOKIE_PROBES, classifyWalledProbe, isBotChallenge };
