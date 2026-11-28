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
 * Requires: NYT_EMAIL in the shell env (renew-cookies.js uses the Keychain instead), and ~/.claude/bin/gmail on PATH.
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

// BRO-7705: the login steps live in lib/cookie-login-adapters.js, shared
// with renew-cookies.js (which runs them with Keychain credentials inside the
// same persistent profile, once, behind the device-limit guards). This
// script is the manual entry point with env credentials.
const { standaloneLogin } = require('./lib/cookie-login-adapters');

standaloneLogin('nytimes', { email: process.env.NYT_EMAIL }, {
  legacy: ['/tmp/nyt-otp-browser-profile', '/tmp/nyt-recovery-browser-profile', '/tmp/nyt-browser-profile'],
  method: 'otp-login',
})
  .then(() => console.log('Done.'))
  .catch((err) => {
    console.error('\nFATAL ERROR:', err.message);
    process.exit(1);
  });
