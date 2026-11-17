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

// BRO-7705: the login steps live in lib/cookie-login-adapters.js, shared
// with renew-cookies.js (which runs them with Keychain credentials inside the
// same persistent profile, once, behind the device-limit guards). This
// script is the manual entry point with env credentials.
const { standaloneLogin } = require('./lib/cookie-login-adapters');

standaloneLogin('wapo', { email: process.env.WAPO_EMAIL, password: process.env.WASHPOST_PASSWORD }, {
  legacy: ['/tmp/wapo-login-browser-profile', '/tmp/wapo-recovery-browser-profile'],
  method: 'password-login',
})
  .then(() => console.log('Done.'))
  .catch((err) => {
    console.error('\nFATAL ERROR:', err.message);
    process.exit(1);
  });
