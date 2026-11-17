/**
 * Browser steps for each login adapter kind in lib/cookie-renew.js
 * LOGIN_ADAPTERS (BRO-7705). One copy, used by renew-cookies.js (Keychain
 * credentials, persistent profile, one attempt) and by the standalone
 * nyt-otp-login.js / newyorker-otp-login.js / wapo-login.js /
 * thetimes-login.js scripts (env credentials), so the flows can't drift.
 *
 * Every function: async (page, cfg, creds, { pollOtp, log }) ->
 *   { url, html, formMissing?: boolean, why?: string }
 * It submits ONCE and returns the page it ended on. It never decides
 * success: the caller re-runs the walled probe in the same profile. It never
 * logs credentials, OTP codes or cookie values.
 *
 * Flows were probed live: The Stage (BRO-4183), NYT + New Yorker
 * (2026-08-02, task #831), WaPo (2026-08-02), The Times (2026-08-03), FT +
 * Telegraph sign-in pages (2026-11-17: email step first, password after).
 */

'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pageState(page, extra = {}) {
  return { url: page.url(), html: await page.content().catch(() => ''), ...extra };
}

async function clickOrEnter(page, nameRe, field) {
  const btn = page.getByRole('button', { name: nameRe });
  if (await btn.count()) await btn.first().click();
  else await field.press('Enter');
}

async function settle(page, ms = 4000) {
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(ms);
}

// Visible fields only: The Stage renders a hidden duplicate form, FT a hidden
// decoy password input ("_notUsed").
const VISIBLE_EMAIL = 'input[type="email"]:visible, input[name="email"]:visible';
const VISIBLE_PASSWORD = 'input[type="password"]:visible';

async function dismissConsent(page, re) {
  const b = page.getByRole('button', { name: re });
  if (await b.count()) { await b.first().click().catch(() => {}); await page.waitForTimeout(500); }
}

const FLOWS = {
  // The Stage: one form, explicit selectors from the outlet config.
  async 'stage-form'(page, cfg, creds) {
    await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    await dismissConsent(page, cfg.selectors.consentReject);
    const email = page.locator(cfg.selectors.email).first();
    const password = page.locator(cfg.selectors.password).first();
    if (!(await email.count()) || !(await password.count())) return pageState(page, { formMissing: true });
    await email.fill(creds.email);
    await password.fill(creds.password);
    await clickOrEnter(page, cfg.selectors.submit, password);
    await settle(page);
    return pageState(page);
  },

  // The Times (Auth0): email + password on one page.
  async 'one-step-password'(page, cfg, creds) {
    await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector(VISIBLE_EMAIL, { timeout: 15000 }).catch(() => {});
    const email = page.locator(VISIBLE_EMAIL).first();
    const password = page.locator(VISIBLE_PASSWORD).first();
    if (!(await email.count()) || !(await password.count())) return pageState(page, { formMissing: true });
    await email.fill(creds.email);
    await password.fill(creds.password);
    await clickOrEnter(page, /^(log in|sign in|continue)$/i, password);
    await page.waitForFunction(() => !/\/login/i.test(window.location.pathname), { timeout: 20000 }).catch(() => {});
    await settle(page, 3000);
    return pageState(page);
  },

  // WaPo, FT, Telegraph: email -> Next/Continue -> password -> Sign in.
  async 'two-step-password'(page, cfg, creds) {
    await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector(VISIBLE_EMAIL, { timeout: 15000 }).catch(() => {});
    const email = page.locator(VISIBLE_EMAIL).first();
    if (!(await email.count())) return pageState(page, { formMissing: true });
    await email.fill(creds.email);
    await clickOrEnter(page, /^(next|continue)$/i, email);
    const password = page.locator(VISIBLE_PASSWORD).first();
    await password.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {});
    if (!(await password.count())) return pageState(page, { formMissing: true, why: 'no password step after the email step (code, captcha or SSO?)' });
    await password.fill(creds.password);
    await clickOrEnter(page, /^(sign in|log in|continue|submit)$/i, password);
    await settle(page);
    return pageState(page);
  },

  // NYT: email -> "Email me a one-time code" -> code from Gmail -> Log in.
  async 'nyt-otp'(page, cfg, creds, { pollOtp, otp }) {
    await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    const email = page.locator('input[type="email"]').first();
    if (!(await email.count())) return pageState(page, { formMissing: true });
    await email.fill(creds.email);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(2500);
    const otpButton = page.getByRole('button', { name: /email me a one-time code/i });
    if (!(await otpButton.count())) return pageState(page, { formMissing: true, why: '"Email me a one-time code" not offered' });
    const since = Math.floor(Date.now() / 1000) - 30; // clock skew
    await otpButton.click();
    const code = await pollOtp({ ...otp, sinceEpochSeconds: since });
    if (!code) return pageState(page, { why: 'no one-time code arrived in Gmail within 90s' });
    const field = page.locator('input[name="verificationCode"]').first();
    if (!(await field.count())) return pageState(page, { formMissing: true, why: 'code field missing' });
    await field.fill(code);
    await clickOrEnter(page, /^log in$/i, field);
    await page.waitForFunction(() => !window.location.pathname.includes('/auth/'), { timeout: 20000 }).catch(() => {});
    await settle(page, 2000);
    return pageState(page);
  },

  // New Yorker (Condé Nast ID): email -> "Sign in with one-time code" ->
  // 6 single-digit boxes -> optional passkey upsell.
  async 'newyorker-otp'(page, cfg, creds, { pollOtp, otp }) {
    await page.goto(cfg.loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
    const email = page.locator('input[type="email"]').first();
    if (!(await email.count())) return pageState(page, { formMissing: true });
    await email.fill(creds.email);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForTimeout(2500);
    const otpButton = page.getByRole('button', { name: /sign in with one-time code/i });
    if (!(await otpButton.count())) return pageState(page, { formMissing: true, why: '"Sign in with one-time code" not offered' });
    const since = Math.floor(Date.now() / 1000) - 30;
    await otpButton.click();
    const code = await pollOtp({ ...otp, sinceEpochSeconds: since });
    if (!code) return pageState(page, { why: 'no one-time code arrived in Gmail within 90s' });
    await dismissConsent(page, /^ok$/i); // the banner can overlay the boxes
    await page.waitForTimeout(1000);
    const digits = code.split('');
    for (let i = 0; i < digits.length; i++) {
      const box = page.locator(`input[name="otp_code_part_${i + 1}"]`).first();
      if (!(await box.count())) return pageState(page, { formMissing: true, why: `code box ${i + 1} missing` });
      await box.fill(digits[i]);
    }
    const submit = page.getByRole('button', { name: /submit code/i });
    if (await submit.count()) await submit.first().click();
    else await page.keyboard.press('Enter');
    await page.waitForTimeout(3000);
    if (page.url().includes('/setup-passkey')) {
      const skip = page.getByText(/continue without a passkey|not now|skip|maybe later|no thanks/i).first();
      if (await skip.count()) { await skip.click(); await page.waitForTimeout(2000); }
    }
    await page.waitForFunction(() => window.location.hostname.includes('newyorker.com'), { timeout: 20000 }).catch(() => {});
    await settle(page, 2000);
    return pageState(page);
  },
};

/**
 * Run the outlet's login flow once on `page`.
 * @param {object} adapter  lib/cookie-renew.js loginAdapterFor(outlet)
 * @param {object} cfg      RENEW_OUTLETS[outlet]
 * @param {{email:string, password?:string}} creds
 * @param {{pollOtp?: Function}} [deps]  defaults to otp-login-helpers' Gmail poller
 */
async function runLoginFlow(page, adapter, cfg, creds, deps = {}) {
  const flow = adapter && FLOWS[adapter.kind];
  if (!flow) throw new Error(`no login flow for ${adapter && adapter.kind}`);
  const pollOtp = deps.pollOtp || require('./otp-login-helpers').pollGmailForOtpCode;
  return flow(page, cfg, creds, { pollOtp, otp: adapter.otp });
}

/**
 * Where a scripted login may run: the Mac Studio only, never CI or a cloud
 * session (per-runner logins tripped The Stage's device limit, 2026-03-30).
 * @returns {string|null} refusal reason, or null when allowed
 */
function loginRefusal(env = process.env, platform = process.platform) {
  if (env.CI || env.GITHUB_ACTIONS || env.CLAUDE_CODE_REMOTE === 'true') return 'refusing to log in from CI or a cloud session (device limits, IP blocks); Mac Studio only';
  if (platform !== 'darwin') return 'scripted logins run on the Mac Studio (darwin) only';
  return null;
}

/**
 * Count a standalone login in renew-cookies.js's per-outlet login ledger
 * (state.logins), before submitting, so its 2-logins-per-7-days device
 * limit sees every session this Mac creates. Called under the renew lock.
 */
function recordStandaloneLogin(outlet, statePath) {
  const path = require('path');
  const renew = require('./cookie-renew');
  const p = statePath || process.env.COOKIE_RENEW_STATE_PATH || path.join(require('./otp-login-helpers').COOKIE_DIR, '_renew-state.json');
  const all = renew.loadState(p);
  const s = { ...renew.emptyOutletState(), ...(all[outlet] || {}) };
  s.logins = [...(s.logins || []), new Date().toISOString()].slice(-10);
  all[outlet] = s;
  renew.saveState(p, all);
  return s;
}

/**
 * The standalone login scripts: open the outlet's shared profile, run the
 * flow with env credentials, then prove it with the outlet's walled probe in
 * the same profile. Cookies are written only when the probe reads logged in;
 * anything else throws and leaves data/cookies/<outlet>.json untouched.
 */
async function standaloneLogin(outlet, creds, { legacy = [], method = 'scripted-login' } = {}) {
  const refusal = loginRefusal();
  if (refusal) throw new Error(refusal);
  const renew = require('./cookie-renew');
  const { COOKIE_PROBES } = require('./cookie-probes');
  const bprobe = require('./cookie-browser-probe');
  const { launchOtpBrowser, writeOtpCookies } = require('./otp-login-helpers');
  const cfg = renew.RENEW_OUTLETS[outlet];
  const adapter = renew.loginAdapterFor(outlet);
  const missing = renew.missingCredentials(adapter, creds);
  if (missing.length) throw new Error(`missing ${missing.join(' + ')} for ${outlet}`);
  const { dir } = renew.claimOutletProfile(renew.profileNameFor(outlet), { legacy }); // takes the renew lock
  recordStandaloneLogin(outlet);
  const context = await launchOtpBrowser(dir);
  try {
    const page = context.pages()[0] || (await context.newPage());
    const r = await runLoginFlow(page, adapter, cfg, creds);
    if (r.formMissing || r.why) throw new Error(`login did not complete: ${r.why || 'login form not found'} (on ${r.url})`);
    const probe = COOKIE_PROBES[outlet];
    const check = await bprobe.loadProbe(context, probe, { waitMs: 5000 });
    const status = bprobe.classify(probe, check);
    if (status !== 'logged-in') throw new Error(`login flow ended on ${r.url} but the walled probe reads ${status} (${bprobe.describe(probe, check)}); cookies NOT saved`);
    const cookies = (await context.cookies()).filter((c) => renew.cookieInDomains(c, cfg.cookieDomains));
    // A metered wall can let a visitor read the probe article; no auth cookie = no session.
    if (!renew.hasAuthCookie(cookies, cfg.authCookies)) throw new Error(`the walled probe read the article but none of ${cfg.authCookies.join(', ')} is set (metered free view?); cookies NOT saved`);
    const httpOnly = cookies.filter((c) => c.httpOnly).length;
    const p = writeOtpCookies(cfg.fileKey, cookies, { method });
    console.log(`Walled probe: logged in (${bprobe.describe(probe, check)}). Wrote ${cookies.length} cookies (${httpOnly} httpOnly) to ${p}`);
  } finally {
    await context.close().catch(() => {});
  }
}

module.exports = { FLOWS, runLoginFlow, standaloneLogin, recordStandaloneLogin, loginRefusal, sleep };
