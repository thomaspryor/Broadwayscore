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
const { classifyWalledProbe } = require('./cookie-probes');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function probeBody(probe, html) {
  if (probe.extractBody) return probe.extractBody(html) || '';
  return require('./article-extractor').extractArticleTextFromUrl(html, probe.url) || '';
}

/** Load the probe url in an open context; returns {html, body}. */
async function loadProbe(context, probe, { waitMs = 3000 } = {}) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(waitMs);
  const html = await page.content();
  return { html, body: probeBody(probe, html) };
}

/** The same url in a fresh, cookie-less profile (the control). */
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
  let control = await anon(probe, {});
  let status = classify(probe, withCookies, control);
  if (status === 'vacuous') {
    control = await anon(probe, { waitMs: 8000 });
    status = classify(probe, withCookies, control);
  }
  return { status, control };
}

function describe(probe, r) {
  return `body ${r.body.length} chars, floor ${probe.minBody}${probe.wallMarker ? `, wall marker ${probe.wallMarker.test(r.html) ? 'present' : 'absent'}` : ''}`;
}

module.exports = { UA, probeBody, loadProbe, anonymousProbe, classify, classifyWithControl, describe };
