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
async function loadProbe(context, probe) {
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(3000);
  const html = await page.content();
  return { html, body: probeBody(probe, html) };
}

/** The same url in a fresh, cookie-less profile (the control). */
async function anonymousProbe(probe, { launch } = {}) {
  const launchFn = launch || require('./otp-login-helpers').launchOtpBrowser;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-probe-anon-'));
  const ctx = await launchFn(dir, { headless: true, userAgent: UA });
  try {
    return await loadProbe(ctx, probe);
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

function describe(probe, r) {
  return `body ${r.body.length} chars, floor ${probe.minBody}${probe.wallMarker ? `, wall marker ${probe.wallMarker.test(r.html) ? 'present' : 'absent'}` : ''}`;
}

module.exports = { UA, probeBody, loadProbe, anonymousProbe, classify, describe };
