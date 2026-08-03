#!/usr/bin/env node

/**
 * The Stage scripted login via email + password (task #876, closes task #198
 * — cookie session has been functionally dead for months even though
 * check-cookie-health.js reported "Auth OK" the whole time, because that
 * check only looks at cookie expiry, not whether the session actually
 * authenticates content).
 *
 * thestage.co.uk's login page (probed live 2026-08-02) is a single-step
 * email+password form (id=Email3786 / id=Password3786) with no OTP or 2FA
 * step. There's also a hidden `Age_3_8_2026`-style input (name changes daily)
 * that is a bot honeypot — real users never see it and scripts must leave it
 * blank, or the submission gets silently rejected as bot traffic.
 *
 * Writes data/cookies/thestage.json in the same schema
 * extract-safari-cookies.py produces, so every downstream consumer
 * (cookie-loader.js, recover-thestage-browser.js, check-cookie-health.js)
 * needs no changes.
 *
 * Usage:
 *   node scripts/thestage-login.js
 *
 * Requires: THESTAGE_EMAIL and THESTAGE_PASSWORD in the shell env.
 * Local only — do not run in CI (needs a real subscriber login).
 */

const args = process.argv.slice(2);
if (args.some(a => a === '--help' || a === '-h' || a.startsWith('--help='))) {
  console.log('Usage: node scripts/thestage-login.js');
  console.log('');
  console.log('Logs into thestage.co.uk via email + password and writes fresh cookies');
  console.log('to data/cookies/thestage.json. Requires THESTAGE_EMAIL and');
  console.log('THESTAGE_PASSWORD in the environment.');
  process.exit(0);
}

const { launchOtpBrowser, writeOtpCookies } = require('./lib/otp-login-helpers');

const PROFILE_DIR = '/tmp/thestage-login-browser-profile';

async function main() {
  const email = process.env.THESTAGE_EMAIL;
  const password = process.env.THESTAGE_PASSWORD;
  if (!email || !password) {
    console.error('ERROR: THESTAGE_EMAIL and/or THESTAGE_PASSWORD not set in environment.');
    process.exit(1);
  }

  console.log(`Logging into The Stage as ${email} via email + password...`);

  const context = await launchOtpBrowser(PROFILE_DIR);
  const page = context.pages()[0] || (await context.newPage());

  try {
    console.log('Navigating to The Stage login...');
    await page.goto('https://www.thestage.co.uk/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    // Dismiss the cookie-consent banner if present — it can overlay the form.
    const rejectCookies = page.getByRole('button', { name: /reject additional cookies/i });
    if (await rejectCookies.count()) {
      await rejectCookies.click().catch(() => {});
      await page.waitForTimeout(500);
    }

    // The page renders TWO input[name="email"] elements — a hidden
    // #Email3786 (0x0, belongs to an inactive duplicate form) and the real,
    // visible #aoLogin-email. A bare name= selector grabs the hidden one
    // first and hangs waiting for it to become fillable, so target the
    // visible element explicitly (confirmed live 2026-08-02).
    const emailField = page.locator('input[name="email"]:visible').first();
    if (!(await emailField.count())) {
      throw new Error('Visible email field not found — The Stage login page layout may have changed');
    }
    await emailField.fill(email);

    const passwordField = page.locator('input[name="password"]:visible').first();
    if (!(await passwordField.count())) {
      throw new Error('Visible password field not found — The Stage login page layout may have changed');
    }
    await passwordField.fill(password);

    // Deliberately never touch the hidden honeypot input (name is a
    // per-day-changing "Age_M_D_YYYY" pattern) — filling it marks the
    // submission as bot traffic.

    const loginButton = page.getByRole('button', { name: /^login$/i });
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
    const stageCookies = allCookies.filter(c => c.domain.includes('thestage.co.uk'));

    if (stageCookies.length === 0) {
      throw new Error('No thestage.co.uk cookies found after login — something went wrong');
    }

    const httpOnlyCount = stageCookies.filter(c => c.httpOnly).length;
    console.log(`Captured ${stageCookies.length} cookies (${httpOnlyCount} httpOnly).`);
    if (httpOnlyCount === 0) {
      console.log('WARNING: zero httpOnly cookies captured — login likely did not fully complete.');
    }

    const cookiePath = writeOtpCookies('thestage', stageCookies);
    console.log(`Wrote ${stageCookies.length} cookies to ${cookiePath}`);
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
