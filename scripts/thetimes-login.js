#!/usr/bin/env node

/**
 * Times UK scripted login via email + password (task #919, closes task #876
 * follow-up — credentials were missing from .env until the owner supplied
 * THETIMES_EMAIL/THETIMES_PASSWORD on 2026-08-03).
 *
 * account.thetimes.co.uk's login page (probed live 2026-08-03 via
 * https://login.thetimes.com/?gotoUrl=... -> Auth0 /login redirect) is a
 * single-step email+password form (input[name="email"] /
 * input[name="password"]) with an Apple/Google SSO option but no OTP or 2FA
 * step. No honeypot field was found (unlike thestage.co.uk).
 *
 * Writes data/cookies/thetimes.json in the same schema
 * extract-safari-cookies.py produces, so every downstream consumer
 * (cookie-loader.js, recover-thetimes-browser.js, check-cookie-health.js)
 * needs no changes.
 *
 * Usage:
 *   node scripts/thetimes-login.js
 *
 * Requires: THETIMES_EMAIL and THETIMES_PASSWORD in the shell env.
 * Local only — do not run in CI (needs a real subscriber login).
 */

const args = process.argv.slice(2);
if (args.some(a => a === '--help' || a === '-h' || a.startsWith('--help='))) {
  console.log('Usage: node scripts/thetimes-login.js');
  console.log('');
  console.log('Logs into thetimes.co.uk via email + password and writes fresh cookies');
  console.log('to data/cookies/thetimes.json. Requires THETIMES_EMAIL and');
  console.log('THETIMES_PASSWORD in the environment.');
  process.exit(0);
}

const { launchOtpBrowser, writeOtpCookies } = require('./lib/otp-login-helpers');

const PROFILE_DIR = '/tmp/thetimes-login-browser-profile';
const LOGIN_URL = 'https://login.thetimes.com/?gotoUrl=https://www.thetimes.com/';

async function main() {
  const email = process.env.THETIMES_EMAIL;
  const password = process.env.THETIMES_PASSWORD;
  if (!email || !password) {
    console.error('ERROR: THETIMES_EMAIL and/or THETIMES_PASSWORD not set in environment.');
    process.exit(1);
  }

  console.log(`Logging into The Times as ${email} via email + password...`);

  const context = await launchOtpBrowser(PROFILE_DIR);
  const page = context.pages()[0] || (await context.newPage());

  try {
    console.log('Navigating to The Times login...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const emailField = page.locator('input[name="email"]').first();
    await page.waitForSelector('input[name="email"]', { timeout: 15000 });
    await emailField.fill(email);

    const passwordField = page.locator('input[name="password"]').first();
    if (!(await passwordField.count())) {
      throw new Error('Password field not found — The Times login page layout may have changed');
    }
    await passwordField.fill(password);

    const loginButton = page.getByRole('button', { name: /^log in$/i });
    if (await loginButton.count()) {
      await loginButton.click();
    } else {
      await passwordField.press('Enter');
    }

    await page.waitForFunction(
      () => !/\/login/i.test(window.location.pathname),
      { timeout: 20000 }
    );
    console.log(`Login complete. Landed on: ${page.url()}`);

    const allCookies = await context.cookies();
    const timesCookies = allCookies.filter(
      (c) => c.domain.includes('thetimes.co.uk') || c.domain.includes('thetimes.com')
    );

    if (timesCookies.length === 0) {
      throw new Error('No thetimes cookies found after login — something went wrong');
    }

    const httpOnlyCount = timesCookies.filter((c) => c.httpOnly).length;
    console.log(`Captured ${timesCookies.length} cookies (${httpOnlyCount} httpOnly).`);
    if (httpOnlyCount === 0) {
      console.log('WARNING: zero httpOnly cookies captured — login likely did not fully complete.');
    }

    const cookiePath = writeOtpCookies('thetimes', timesCookies);
    console.log(`Wrote ${timesCookies.length} cookies to ${cookiePath}`);
  } finally {
    await context.close();
  }
}

main()
  .then(() => {
    console.log('Done.');
  })
  .catch((err) => {
    console.error('\nFATAL ERROR:', err.message);
    process.exit(1);
  });
