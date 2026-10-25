#!/usr/bin/env node

/**
 * NYT scripted login via email one-time-passcode (task #831, generalizes #779).
 *
 * Same root cause as WSJ: macOS Tahoe no longer persists httpOnly cookies to
 * Safari's Cookies.binarycookies, so extract-safari-cookies.py can never
 * recover NYT-S/nyt-a for a subscriber account. Unlike WSJ, NYT's login page
 * offers "Email me a one-time code" directly on the password screen (probed
 * live 2026-08-02) — no separate anti-bot gate observed, but OTP is used
 * anyway for consistency with the proven WSJ pattern and because it sidesteps
 * password-based anti-bot risk entirely.
 *
 * Writes data/cookies/nytimes.json in the same schema extract-safari-cookies.py
 * produces, so every downstream consumer (cookie-loader.js,
 * recover-nyt-browser.js, check-cookie-health.js) needs no changes.
 *
 * Usage:
 *   node scripts/nyt-otp-login.js
 *
 * Requires: NYT_EMAIL in the shell env, and ~/.claude/bin/gmail on PATH.
 * Local only — do not run in CI (needs a live inbox to poll).
 */

const args = process.argv.slice(2);
if (args.some(a => a === '--help' || a === '-h' || a.startsWith('--help='))) {
  console.log('Usage: node scripts/nyt-otp-login.js');
  console.log('');
  console.log('Logs into NYT via email one-time-passcode and writes fresh cookies to');
  console.log('data/cookies/nytimes.json. Requires NYT_EMAIL in the environment and a');
  console.log('working ~/.claude/bin/gmail to retrieve the passcode email.');
  process.exit(0);
}

const { launchOtpBrowser, pollGmailForOtpCode, writeOtpCookies } = require('./lib/otp-login-helpers');

const PROFILE_DIR = '/tmp/nyt-otp-browser-profile';

async function main() {
  const email = process.env.NYT_EMAIL;
  if (!email) {
    console.error('ERROR: NYT_EMAIL not set in environment.');
    process.exit(1);
  }

  console.log(`Logging into NYT as ${email} via one-time passcode...`);

  const context = await launchOtpBrowser(PROFILE_DIR);
  const page = context.pages()[0] || (await context.newPage());

  try {
    console.log('Navigating to NYT login...');
    await page.goto('https://myaccount.nytimes.com/auth/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const emailField = page.locator('input[type="email"]').first();
    if (!(await emailField.count())) {
      throw new Error('Email field not found — NYT login page layout may have changed');
    }
    await emailField.fill(email);

    const continueButton = page.locator('button[type="submit"]').first();
    await continueButton.click();
    await page.waitForTimeout(2500);

    // Existing subscribers land on the password screen, which also offers
    // "Email me a one-time code" — click that instead of filling a password.
    const otpButton = page.getByRole('button', { name: /email me a one-time code/i });
    if (!(await otpButton.count())) {
      throw new Error('"Email me a one-time code" button not found — NYT login flow may have changed, or this email has no NYT account');
    }

    const requestedAtEpochSec = Math.floor(Date.now() / 1000) - 30; // backdate to absorb clock skew
    await otpButton.click();

    console.log(`OTP requested at epoch ${requestedAtEpochSec}. Polling Gmail for a NEWER code (up to 90s)...`);
    // NYT puts the code directly in the subject line: "Log in with code 123456"
    const code = await pollGmailForOtpCode({
      fromFilter: 'nytimes.com',
      sinceEpochSeconds: requestedAtEpochSec,
      codePattern: /code[^\d]{0,10}(\d{6})/i,
    });
    if (!code) throw new Error('Could not retrieve a fresh NYT OTP code from Gmail after 90s');
    console.log(`Got OTP code: ${code}`);

    const codeField = page.locator('input[name="verificationCode"]').first();
    await codeField.fill(code);

    const loginButton = page.getByRole('button', { name: /^log in$/i });
    if (await loginButton.count()) {
      await loginButton.click();
    } else {
      await codeField.press('Enter');
    }

    await page.waitForFunction(
      () => !window.location.pathname.includes('/auth/'),
      { timeout: 20000 }
    );
    console.log(`Login complete. Landed on: ${page.url()}`);

    const allCookies = await context.cookies();
    const nytCookies = allCookies.filter(c => c.domain.includes('nytimes.com'));

    if (nytCookies.length === 0) {
      throw new Error('No nytimes.com cookies found after login — something went wrong');
    }

    const httpOnlyCount = nytCookies.filter(c => c.httpOnly).length;
    console.log(`Captured ${nytCookies.length} cookies (${httpOnlyCount} httpOnly).`);
    if (httpOnlyCount === 0) {
      console.log('WARNING: zero httpOnly cookies captured — login likely did not fully complete.');
    }

    const cookiePath = writeOtpCookies('nytimes', nytCookies);
    console.log(`Wrote ${nytCookies.length} cookies to ${cookiePath}`);
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
