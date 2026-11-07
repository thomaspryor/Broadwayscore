#!/usr/bin/env node

/**
 * New Yorker (Condé Nast ID) scripted login via email one-time-passcode
 * (task #831, generalizes #779).
 *
 * Same root cause as WSJ: macOS Tahoe no longer persists httpOnly cookies to
 * Safari's Cookies.binarycookies, so extract-safari-cookies.py can never
 * recover CN_token_access/CN_token_id for a subscriber account — confirmed
 * live: check-cookie-health.js reported newyorker auth expiring in 0.1d with
 * no working refresh path (task #779/#831 investigation, 2026-08-02).
 * Condé Nast ID offers "Sign in with one-time code" on the password screen
 * (probed live) — no anti-bot gate observed, but OTP is used for consistency
 * with the proven WSJ pattern. The code entry UI is 6 separate 1-character
 * boxes (name="otp_code_part_1".."_6"), unlike NYT/WSJ's single field.
 *
 * Writes data/cookies/newyorker.json in the same schema extract-safari-cookies.py
 * produces, so every downstream consumer (cookie-loader.js,
 * recover-newyorker-browser.js, check-cookie-health.js) needs no changes.
 *
 * Usage:
 *   node scripts/newyorker-otp-login.js
 *
 * Requires: NEW_YORKER_EMAIL in the shell env, and ~/.claude/bin/gmail on PATH.
 * Local only — do not run in CI (needs a live inbox to poll).
 */

const args = process.argv.slice(2);
if (args.some(a => a === '--help' || a === '-h' || a.startsWith('--help='))) {
  console.log('Usage: node scripts/newyorker-otp-login.js');
  console.log('');
  console.log('Logs into The New Yorker (Condé Nast ID) via email one-time-passcode and');
  console.log('writes fresh cookies to data/cookies/newyorker.json. Requires NEW_YORKER_EMAIL');
  console.log('in the environment and a working ~/.claude/bin/gmail to retrieve the code.');
  process.exit(0);
}

const { launchOtpBrowser, pollGmailForOtpCode, writeOtpCookies } = require('./lib/otp-login-helpers');

const PROFILE_DIR = '/tmp/newyorker-otp-browser-profile';
const LOGIN_URL = 'https://www.newyorker.com/auth/initiate?redirectURL=https%3A%2F%2Fwww.newyorker.com%2F&source=HB';

async function main() {
  const email = process.env.NEW_YORKER_EMAIL;
  if (!email) {
    console.error('ERROR: NEW_YORKER_EMAIL not set in environment.');
    process.exit(1);
  }

  console.log(`Logging into The New Yorker as ${email} via one-time passcode...`);

  const context = await launchOtpBrowser(PROFILE_DIR);
  const page = context.pages()[0] || (await context.newPage());

  try {
    console.log('Navigating to New Yorker login...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);

    const emailField = page.locator('input[type="email"]').first();
    if (!(await emailField.count())) {
      throw new Error('Email field not found — Condé Nast ID login page layout may have changed');
    }
    await emailField.fill(email);

    const continueButton = page.locator('button[type="submit"]').first();
    await continueButton.click();
    await page.waitForTimeout(2500);

    const otpButton = page.getByRole('button', { name: /sign in with one-time code/i });
    if (!(await otpButton.count())) {
      throw new Error('"Sign in with one-time code" button not found — Condé Nast ID login flow may have changed, or this email has no account');
    }

    const requestedAtEpochSec = Math.floor(Date.now() / 1000) - 30; // backdate to absorb clock skew
    await otpButton.click();

    console.log(`OTP requested at epoch ${requestedAtEpochSec}. Polling Gmail for a NEWER code (up to 90s)...`);
    // Condé Nast puts the code directly in the subject line: "Your one time code is 123456"
    const code = await pollGmailForOtpCode({
      fromFilter: 'condenast.com',
      sinceEpochSeconds: requestedAtEpochSec,
      codePattern: /code is[^\d]{0,5}(\d{6})/i,
    });
    if (!code) throw new Error('Could not retrieve a fresh New Yorker OTP code from Gmail after 90s');
    console.log(`Got OTP code: ${code}`);

    // Dismiss the cookie-consent banner first — it can overlay the code boxes
    // and the submit button, blocking clicks even though fill() still works.
    const consentOk = page.getByRole('button', { name: /^ok$/i });
    if (await consentOk.count()) {
      await consentOk.click();
      await page.waitForTimeout(500);
    }

    // The code entry UI is 6 separate single-character boxes, not one field.
    await page.waitForTimeout(1000);
    const digits = code.split('');
    for (let i = 0; i < digits.length; i++) {
      const box = page.locator(`input[name="otp_code_part_${i + 1}"]`).first();
      if (!(await box.count())) {
        throw new Error(`OTP box ${i + 1} not found — Condé Nast ID code-entry layout may have changed`);
      }
      await box.fill(digits[i]);
    }

    const submitButton = page.getByRole('button', { name: /submit code/i });
    if (await submitButton.count()) {
      await submitButton.click();
    } else {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(3000);
    console.log(`After submit, on: ${page.url()}`);

    // Condé Nast ID interposes a "set up a passkey" upsell interstitial after
    // OTP verification, before redirecting back to newyorker.com. Skip it —
    // it is not a login step, just a prompt.
    if (page.url().includes('/setup-passkey')) {
      const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500));
      console.log(`Passkey interstitial. Body text:\n${bodyText}`);
      const skipButton = page.getByText(/continue without a passkey|not now|skip|maybe later|no thanks/i).first();
      if (await skipButton.count()) {
        await skipButton.click();
      } else {
        const buttons = await page.locator('button').allInnerTexts();
        console.log(`No skip button matched. Buttons on page: ${JSON.stringify(buttons)}`);
      }
      await page.waitForTimeout(2000);
      console.log(`After skipping passkey, on: ${page.url()}`);
    }

    await page.waitForFunction(
      () => window.location.hostname.includes('newyorker.com'),
      { timeout: 20000 }
    );
    console.log(`Login complete. Landed on: ${page.url()}`);

    const allCookies = await context.cookies();
    const nyCookies = allCookies.filter(
      c => c.domain.includes('newyorker.com') || c.domain.includes('condenast.com')
    );

    if (nyCookies.length === 0) {
      throw new Error('No newyorker.com/condenast.com cookies found after login — something went wrong');
    }

    const httpOnlyCount = nyCookies.filter(c => c.httpOnly).length;
    console.log(`Captured ${nyCookies.length} cookies (${httpOnlyCount} httpOnly).`);
    if (httpOnlyCount === 0) {
      console.log('WARNING: zero httpOnly cookies captured — login likely did not fully complete.');
    }

    const cookiePath = writeOtpCookies('newyorker', nyCookies);
    console.log(`Wrote ${nyCookies.length} cookies to ${cookiePath}`);
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
