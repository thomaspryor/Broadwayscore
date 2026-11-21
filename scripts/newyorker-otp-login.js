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

// BRO-7705: the login steps live in lib/cookie-login-adapters.js, shared
// with renew-cookies.js (which runs them with Keychain credentials inside the
// same persistent profile, once, behind the device-limit guards). This
// script is the manual entry point with env credentials.
const { standaloneLogin } = require('./lib/cookie-login-adapters');

standaloneLogin('newyorker', { email: process.env.NEW_YORKER_EMAIL }, {
  legacy: ['/tmp/newyorker-otp-browser-profile', '/tmp/newyorker-recovery-browser-profile', '/tmp/newyorker-browser-profile'],
  method: 'otp-login',
})
  .then(() => console.log('Done.'))
  .catch((err) => {
    console.error('\nFATAL ERROR:', err.message);
    process.exit(1);
  });
