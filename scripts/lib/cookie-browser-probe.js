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
    subscriberMarker: probe.subscriberMarker,
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
async function classifyWithControl(probe, withCookies, { anon = anonymousProbe, profileControl = null, loadWithCookies = null } = {}) {
  const r = await classifyOneUrl(probe, withCookies, { anon, profileControl });
  // BRO-7922: a probe url that has aged into the free archive (New Yorker 2023
  // review, 2026-11-21) reads 'vacuous'. Rotate through probe.altUrls instead of
  // failing the outlet: each alternate is loaded in the logged-in profile
  // (loadWithCookies) and against its own anonymous control. The first one that
  // is walled for the control wins; the result names the url used.
  if (r.status !== 'vacuous' || !loadWithCookies || !(probe.altUrls || []).length) return r;
  for (const url of probe.altUrls) {
    const alt = { ...probe, url };
    let sub;
    // Slow read (8s): an alternate whose anonymous page is long tells logged-in from logged-out only by a
    // late-rendered paywall marker, so a 3s read of a logged-out profile could miss it (false OK, review 2026-11-21).
    try { sub = await loadWithCookies(alt, { waitMs: 8000 }); } catch { continue; }
    const ar = await classifyOneUrl(alt, sub, { anon, profileControl });
    if (ar.status === 'logged-in') return { ...ar, usedUrl: url, rotatedFrom: probe.url };
  }
  return r;
}

async function classifyOneUrl(probe, withCookies, { anon, profileControl }) {
  const blockedOnly = (c) => !!c && isBotChallenge(c.html) && !(withCookies && isBotChallenge(withCookies.html));
  // A cookie-less profile that DataDome/Cloudflare answers with a bot
  // challenge (NYT: HTTP 403, every run, BRO-7765) says nothing about whether
  // the url is free. BRO-7922: for probes that opt in (profileControl: true)
  // and callers that supply one, fall back to the persistent profile itself
  // with only the session cookies removed (same trusted fingerprint, no
  // login): DataDome answers every throwaway profile and plain fetch with
  // HTTP 403 but serves this one (NYT, measured 2026-11-21). If that is also
  // blocked, name it so callers can tell it from an unrecognised page.
  const getControl = async (opts) => {
    let c = await anon(probe, opts);
    if (blockedOnly(c) && probe.profileControl && profileControl) {
      const pc = await profileControl(probe, opts).catch(() => null);
      if (pc && pc.html && pc.httpStatus === 200 && !isBotChallenge(pc.html)) c = pc;
    }
    return c;
  };
  let control = await getControl({});
  if (blockedOnly(control)) return { status: 'control-blocked', control };
  let status = classify(probe, withCookies, control);
  if (status === 'vacuous') {
    control = await getControl({ waitMs: 8000 });
    if (blockedOnly(control)) return { status: 'control-blocked', control };
    status = classify(probe, withCookies, control);
  }
  return { status, control };
}

/**
 * Control for bot-walled outlets: load the probe url in the SAME persistent
 * context with the session (auth) cookies removed, then put them back (always,
 * in finally). Only the named auth cookies go, so the bot-trust cookies stay.
 * Nothing is sent to the outlet to log out; this is local state only.
 * @param {import('playwright').BrowserContext} context
 * @param {object} probe
 * @param {string[]} authCookies  cookie names that carry the session
 */
async function profileControlProbe(context, probe, authCookies, { waitMs } = {}) {
  const names = new Set(authCookies || []);
  if (!names.size) throw new Error('profileControlProbe needs the outlet auth cookie names');
  const saved = (await context.cookies()).filter((c) => names.has(c.name));
  try {
    for (const c of saved) await context.clearCookies({ name: c.name, domain: c.domain });
    return await loadProbe(context, probe, { waitMs });
  } finally {
    if (saved.length) {
      // A failed restore leaves the profile logged out and the caller swallows control errors, so say it loudly.
      try { await context.addCookies(saved); } catch (e) {
        console.error(`cookie-browser-probe: RESTORE FAILED for ${saved.length} auth cookie(s) after the profile control: ${e.message}`);
        throw e;
      }
    }
  }
}

/**
 * In-profile probe for renew-cookies. Returns { status, cookies, detail,
 * page, hasAuthCookie }: cookies only when logged in. A metered wall can show
 * a visitor the whole article (Telegraph, 1 in 4 fresh loads), so no auth
 * cookie means no session, whatever the body says (BRO-7705).
 * @param {import('playwright').BrowserContext} context
 * @param {{cookieDomains:string[], authCookies:string[]}} cfg  RENEW_OUTLETS entry
 */
async function profileSession(context, cfg, probe, { waitMs } = {}) {
  const renew = require('./cookie-renew');
  const r = await loadProbe(context, probe, { waitMs });
  const all = (await context.cookies()).filter((c) => renew.cookieInDomains(c, cfg.cookieDomains));
  const hasAuthCookie = renew.hasAuthCookie(all, cfg.authCookies);
  let status = classify(probe, r);
  let detail = describe(probe, r);
  if (status === 'logged-in' && !hasAuthCookie) { status = 'logged-out'; detail += ', but no auth cookie (metered free view)'; }
  if (status !== 'logged-in') return { status, cookies: null, detail, page: r, hasAuthCookie };
  return { status, detail, page: r, hasAuthCookie, cookies: all };
}

/**
 * The in-profile deps classifyWithControl needs from an open persistent
 * context (renew-cookies). One place so the caller cannot drop an option:
 * BRO-7922 wired loadWithCookies as (alt) => loadProbe(context, alt), which
 * silently turned the 8s alternate read back into the default 3s (a late
 * paywall bar on a logged-out profile = false OK). BRO-8092.
 * @param {import('playwright').BrowserContext} context
 * @param {string[]} authCookies
 */
function profileDeps(context, authCookies) {
  return {
    loadWithCookies: (alt, o) => loadProbe(context, alt, o),
    profileControl: (pr, o) => profileControlProbe(context, pr, authCookies, o),
  };
}

/**
 * verify-cookie-login.js's browser-only probe (BRO-8099): the SAVED cookie jar
 * loaded into a throwaway profile, classified exactly as renew-cookies.js
 * classifies the persistent profile, i.e. with profileDeps. Without them a
 * vacuous primary url never rotated through probe.altUrls (BRO-7922) and a
 * bot-walled anonymous control never fell back to the same jar minus its auth
 * cookies, so verify said VACUOUS / BOT-CHECK where renew rotated and passed.
 * @param {object} probe  COOKIE_PROBES entry
 * @param {object[]} cookies  saved cookie file rows
 * @param {string[]} authCookies  RENEW_OUTLETS[outlet].authCookies (profile control)
 * @param {{launch?: Function, anon?: Function}} [deps]  for tests
 * @returns {Promise<{status:string, withCookies:{html:string, body:string}, control:object, usedUrl?:string, rotatedFrom?:string}>}
 */
async function classifySavedCookies(probe, cookies, authCookies, { launch, anon = anonymousProbe } = {}) {
  const launchFn = launch || require('./otp-login-helpers').launchOtpBrowser;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-cookie-login-'));
  const ctx = await launchFn(dir, { headless: true, userAgent: UA });
  try {
    await ctx.addCookies(cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain, path: c.path || '/',
      expires: Number(c.expires) > 0 ? Number(c.expires) : undefined,
      httpOnly: !!c.httpOnly, secure: !!c.secure,
      sameSite: ['Strict', 'Lax', 'None'].includes(c.sameSite) ? c.sameSite : 'Lax',
    })));
    const withCookies = await loadProbe(ctx, probe);
    const r = await classifyWithControl(probe, withCookies, { anon, ...profileDeps(ctx, authCookies) });
    // Same rule as profileSession: a metered wall shows a fresh browser the whole
    // article (New Yorker, measured 2026-11-25: 8509 chars to a jar with no
    // CN_access), so a jar with no auth cookie has no session, whatever the body says.
    if (r.status === 'logged-in' && !require('./cookie-renew').hasAuthCookie(cookies, authCookies)) {
      return { ...r, status: 'logged-out', noAuthCookie: true, withCookies };
    }
    return { ...r, withCookies };
  } finally {
    await ctx.close().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function describe(probe, r) {
  return `body ${r.body.length} chars, floor ${probe.minBody}${probe.wallMarker ? `, wall marker ${probe.wallMarker.test(r.html) ? 'present' : 'absent'}` : ''}`;
}

module.exports = { UA, probeBody, loadProbe, anonymousProbe, classify, classifyWithControl, classifySavedCookies, profileControlProbe, profileDeps, profileSession, confirmWall, describe };
