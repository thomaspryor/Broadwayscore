#!/usr/bin/env node

/**
 * WaPo scripted login via email + password (task #876, generalizes #831/#779).
 *
 * Unlike WSJ/NYT/New Yorker, washingtonpost.com's sign-in page (probed live
 * 2026-08-02) offers no email-OTP option — it's a two-step Okta-style flow:
 * email address -> Next -> password field appears -> Sign in. No 2FA
 * challenge was presented for this account. So this script is a plain
 * scripted password login, not an OTP flow; it reuses launchOtpBrowser/
 * writeOtpCookies from otp-login-helpers.js (real-Chrome launch + cookie
 * write schema) but skips the Gmail-polling step entirely.
 *
 * Root cause this exists at all: same as WSJ/NYT (task #779) — macOS Tahoe
 * no longer persists httpOnly cookies to Safari's Cookies.binarycookies, so
 * extract-safari-cookies.py can never recover a WaPo subscriber session.
 * A real scripted browser login sidesteps Safari's cookie store entirely.
 *
 * Writes data/cookies/wapo.json in the same schema extract-safari-cookies.py
 * produces, so every downstream consumer (cookie-loader.js,
 * recover-wapo-browser.js, check-cookie-health.js) needs no changes.
 *
 * Usage:
 *   node scripts/wapo-login.js
 *
 * Requires: WAPO_EMAIL and WASHPOST_PASSWORD in the shell env.
 * Local only — do not run in CI (needs a real subscriber login).
 */

const args = process.argv.slice(2);
if (args.some(a => a === '--help' || a === '-h' || a.startsWith('--help='))) {
  console.log('Usage: node scripts/wapo-login.js');
  console.log('');
  console.log('Logs into washingtonpost.com via email + password and writes fresh');
  console.log('cookies to data/cookies/wapo.json. Requires WAPO_EMAIL and');
  console.log('WASHPOST_PASSWORD in the environment.');
  process.exit(0);
}

const { launchOtpBrowser, writeOtpCookies } = require('./lib/otp-login-helpers');

const PROFILE_DIR = '/tmp/wapo-login-browser-profile';

async function main() {
  const email = process.env.WAPO_EMAIL;
  const password = process.env.WASHPOST_PASSWORD;
  if (!email || !password) {
    console.error('ERROR: WAPO_EMAIL and/or WASHPOST_PASSWORD not set in environment.');
    process.exit(1);
  }

  console.log(`Logging into WaPo as ${email} via email + password...`);

  const context = await launchOtpBrowser(PROFILE_DIR);
  const page = context.pages()[0] || (await context.newPage());

  try {
    console.log('Navigating to WaPo sign-in...');
    await page.goto('https://www.washingtonpost.com/subscribe/signin/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const emailField = page.locator('input[type="email"]').first();
    if (!(await emailField.count())) {
      throw new Error('Email field not found — WaPo login page layout may have changed');
    }
    await emailField.fill(email);

    const nextButton = page.getByRole('button', { name: /^next$/i });
    if (await nextButton.count()) {
      await nextButton.click();
    } else {
      await emailField.press('Enter');
    }
    await page.waitForTimeout(2500);

    const passwordField = page.locator('input[type="password"]').first();
    if (!(await passwordField.count({ timeout: 10000 }).catch(() => 0))) {
      await page.waitForSelector('input[type="password"]', { timeout: 10000 });
    }
    await passwordField.fill(password);

    const signInButton = page.getByRole('button', { name: /^(sign in|log in|continue)$/i });
    if (await signInButton.count()) {
      await signInButton.click();
    } else {
      await passwordField.press('Enter');
    }

    await page.waitForFunction(
      () => !/subscribe\/signin/i.test(window.location.pathname),
      { timeout: 20000 }
    );
    console.log(`Login complete. Landed on: ${page.url()}`);

    const allCookies = await context.cookies();
    const wapoCookies = allCookies.filter(c => c.domain.includes('washingtonpost.com'));

    if (wapoCookies.length === 0) {
      throw new Error('No washingtonpost.com cookies found after login — something went wrong');
    }

    const httpOnlyCount = wapoCookies.filter(c => c.httpOnly).length;
    console.log(`Captured ${wapoCookies.length} cookies (${httpOnlyCount} httpOnly).`);
    if (httpOnlyCount === 0) {
      console.log('WARNING: zero httpOnly cookies captured — login likely did not fully complete.');
    }

    const cookiePath = writeOtpCookies('wapo', wapoCookies);
    console.log(`Wrote ${wapoCookies.length} cookies to ${cookiePath}`);
  } finally {
    await context.close();
  }
}

main()
  .then(() => {
    console.log('Done.');
  })
  .catch(err => {
    console.error('\nFATAL ERROR:', err.message);
    process.exit(1);
  });
