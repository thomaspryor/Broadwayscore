/**
 * In-browser walled probes (BRO-7705), shared by renew-cookies.js and
 * verify-cookie-login.js. For outlets whose wall is client-side (New
 * Yorker) or whose bot wall answers every plain fetch (The Times, FT,
 * Telegraph), the login can only be measured inside a real Chrome. Each
 * probe pairs the persistent profile with an anonymous control in a
 * throwaway profile, so a probe url that stops being walled reads 'vacuous'
 * instead of a silent "logged in".
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { classifyWalledProbe, isBotChallenge } = require('./cookie-probes');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function probeBody(probe, html) {
  if (probe.extractBody) return probe.extractBody(html) || '';
  return require('./article-extractor').extractArticleTextFromUrl(html, probe.url) || '';
}

/** Load the probe url in an open context; returns {html, body}. */
async function loadProbe(context, probe, { waitMs = 3000 } = {}) {
  const page = context.pages()[0] || (await context.newPage());
  const resp = await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(waitMs);
  const html = await page.content();
  return { html, body: probeBody(probe, html), httpStatus: resp ? resp.status() : null };
}

/** Same probe in a throwaway, cookie-less profile (the control). */
async function anonymousProbe(probe, { launch, waitMs } = {}) {
  const launchFn = launch || require('./otp-login-helpers').launchOtpBrowser;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-probe-anon-'));
  const ctx = await launchFn(dir, { headless: true, userAgent: UA });
  try {
    return await loadProbe(ctx, probe, { waitMs });
  } finally {
    await ctx.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Positive evidence that an in-browser "logged-out" reading is real, required
 * before saved cookies are adopted or a login is submitted. A short body
 * alone is not enough: a slow render, a 404, a consent overlay or a redesign
 * also read short (BRO-7705 ship-check). Accepted evidence, on an HTTP 200:
 *   - the outlet's rendered wall marker (loginWallMarker || gateMarker), or
 *   - no auth cookie at all in the profile: there is no session to lose.
 *     (Measured 2026-11-17: every outlet's auth cookies exist only for a
 *     subscriber; NYT/WaPo/Times walls are metered and do not always render
 *     for a first visit.)
 * @param {{status:string, page:{html:string, httpStatus:number|null}, hasAuthCookie?:boolean}} r
 * @param {object} probe  COOKIE_PROBES entry
 * @returns {{ok:boolean, reason:string}}
 */
function confirmWall(r, probe) {
  const marker = probe.loginWallMarker || probe.gateMarker;
  if (!r || r.status !== 'logged-out') return { ok: false, reason: `probe reads ${r ? r.status : 'nothing'}, not logged-out` };
  const http = r.page && r.page.httpStatus;
  if (http != null && http !== 200) return { ok: false, reason: `HTTP ${http} on the probe url` };
  if (marker && marker.test((r.page && r.page.html) || '')) return { ok: true, reason: 'wall marker present' };
  if (r.hasAuthCookie === false) return { ok: true, reason: 'no auth cookie in the profile (no session to lose)' };
  return { ok: false, reason: 'an auth cookie is present but the wall marker is not on the page (slow render, overlay or redesign?)' };
}

function classify(probe, withCookies, withoutCookies) {
  return classifyWalledProbe({
    withCookies, withoutCookies,
    minBody: probe.minBody, wallMarker: probe.wallMarker, gateMarker: probe.gateMarker,
  });
}

/**
 * Classify an in-profile result against an anonymous control. Client-side
 * paywalls render late and are metered, so one control that reads the full
 * article is not proof the url went free (Telegraph 2026-11-17: 1 of 4 fresh
 * anonymous loads read 2,556 chars, the other 3 hit the 168-char wall). A
 * 'vacuous' verdict therefore needs a second, slower control to agree.
 * @param {object} probe
 * @param {{html:string, body:string}} withCookies
 * @param {{anon?: Function}} [deps]  anon(probe, {waitMs}) for tests
 * @returns {Promise<{status:string, control:{html:string, body:string}}>}
 */
async function classifyWithControl(probe, withCookies, { anon = anonymousProbe } = {}) {
  const blockedOnly = (c) => !!c && isBotChallenge(c.html) && !(withCookies && isBotChallenge(withCookies.html));
  let control = await anon(probe, {});
  // A cookie-less profile that DataDome/Cloudflare answers with a bot
  // challenge (NYT: HTTP 403, every run, BRO-7765) says nothing about whether
  // the url is free. Name it so callers can tell it from an unrecognised page.
  if (blockedOnly(control)) return { status: 'control-blocked', control };
  let status = classify(probe, withCookies, control);
  if (status === 'vacuous') {
    control = await anon(probe, { waitMs: 8000 });
    if (blockedOnly(control)) return { status: 'control-blocked', control };
    status = classify(probe, withCookies, control);
  }
  return { status, control };
}

function describe(probe, r) {
  return `body ${r.body.length} chars, floor ${probe.minBody}${probe.wallMarker ? `, wall marker ${probe.wallMarker.test(r.html) ? 'present' : 'absent'}` : ''}`;
}

module.exports = { UA, probeBody, loadProbe, anonymousProbe, classify, classifyWithControl, confirmWall, describe };
